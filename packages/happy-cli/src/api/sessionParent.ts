/**
 * Re-parent a Happy session — mutate `metadata.parentSessionId` after creation.
 *
 * `parentSessionId` used to be write-once: `createSessionMetadata()` stamps it from
 * `HAPPY_FORKED_FROM_SESSION_ID` when the session is spawned and nothing ever changed
 * it afterwards. The app's fork-lineage view (`utils/forkLineage.ts`) and the session
 * info screen read that field, so making it mutable is what lets a session be moved
 * under a different parent, or promoted to top level, without respawning it.
 *
 * Two properties of the existing stack make this doable from a running session:
 *
 * 1. The server's `update-metadata` socket handler is ACCOUNT-scoped, not
 *    session-scoped — it resolves the row by `{ id: sid, accountId: userId }` and
 *    writes with `updateMany({ where: { metadataVersion: expectedVersion } })`. So
 *    this session's socket may legitimately target a sibling session by id, and the
 *    write is a genuine compare-and-swap rather than a blind overwrite.
 * 2. Metadata is end-to-end encrypted with a per-session data key, so the caller must
 *    hold the TARGET's key. Two local sources provide it, tried in order: the on-disk
 *    session cache (`~/.happy/sessions.json`, written by `persistSession`) and legacy
 *    account credentials (`resolveReconnectableSession`, which unwraps the session's
 *    `dataEncryptionKey` with the account content key).
 *
 * Every guard here fails LOUD rather than proceeding on a value that merely looks
 * safe. In particular a lineage chain that cannot be fully read reports `unverified`
 * — which is refused by default — instead of the clean verdict an unreadable graph
 * would otherwise produce, since "no cycle found" and "could not look" are the same
 * observation from the outside.
 */

import { decodeBase64, encodeBase64, decrypt, encrypt } from '@/api/encryption'
import type { Metadata } from '@/api/types'
import { logger } from '@/ui/logger'
import { readPersistedSessions } from '@/persistence'
import { resolveLocalReconnectableSession, LocalResumeSessionError } from '@/resume/localResumeStore'
import { resolveReconnectableSession } from '@/resume/resolveHappySession'
import type { ApiSessionClient } from '@/api/apiSession'

/**
 * Depth cap for the ancestor walk. Well past any real fork chain; its purpose is to
 * bound a graph that is already cyclic through sessions this machine cannot read,
 * so the walk terminates instead of spinning.
 */
const MAX_LINEAGE_DEPTH = 64

/** Bounded CAS retries for the foreign-session path. */
const MAX_CAS_ATTEMPTS = 5

export type LineageVerdict =
    /** The parent's full ancestor chain was read and does not contain the target. */
    | { status: 'clean'; depth: number }
    /** The target appears in the new parent's ancestor chain — applying this would cycle. */
    | { status: 'cycle'; via: string[] }
    /**
     * The chain ran into a session this machine cannot read (not in the local cache and
     * not resolvable through account credentials), or exceeded MAX_LINEAGE_DEPTH. NOT a
     * pass: it means the question was not answered.
     */
    | { status: 'unverified'; reason: string; walked: string[] }

export type SetParentErrorCode =
    | 'self_parent'
    | 'cycle'
    | 'lineage_unverified'
    | 'target_unreadable'
    | 'version_conflict'
    | 'server_error'

export type SetParentResult =
    | {
          ok: true
          sessionId: string
          previousParent: string | null
          parentSessionId: string | null
          lineage: LineageVerdict
          attempts: number
      }
    | {
          ok: false
          sessionId: string
          code: SetParentErrorCode
          error: string
          lineage?: LineageVerdict
      }

export interface SetSessionParentOptions {
    /** Session to re-parent. Defaults to the calling session. */
    sessionId?: string
    /** New parent id, or null to promote the session to top level. */
    parentSessionId: string | null
    /**
     * Accept a lineage verdict of `unverified` — i.e. apply the change even though the
     * ancestor chain could not be fully read. Off by default; a cycle that the app's
     * lineage walk then has to survive is worse than a refused tool call.
     */
    allowUnverifiedLineage?: boolean
}

/** A session record we can both read and re-encrypt. */
type ResolvedTarget = {
    id: string
    metadata: Metadata
    metadataVersion: number
    encryptionKey: Uint8Array
    encryptionVariant: 'legacy' | 'dataKey'
    /** Where the key came from — surfaced in errors so a failure is diagnosable. */
    source: 'local-cache' | 'account-credentials'
}

/**
 * Parent links for every session this machine has cached. Read straight from the
 * persisted store rather than through `parseResumableMetadata`, because the lineage
 * walk only needs `parentSessionId` and must not reject a record for lacking the
 * fields a *resume* would require.
 */
function readLineageGraph(): Map<string, string | null> {
    const graph = new Map<string, string | null>()
    for (const [id, session] of Object.entries(readPersistedSessions())) {
        const metadata = session.metadata as Metadata | undefined
        graph.set(id, metadata?.parentSessionId ?? null)
    }
    return graph
}

/**
 * Walk up from `parentSessionId` looking for `sessionId`.
 *
 * Returns `clean` only when the walk reached a root (a session with no parent) without
 * meeting the target. Running out of readable sessions returns `unverified`, never
 * `clean` — an unreadable ancestor is exactly where an undetected cycle would hide.
 */
export function checkLineage(
    sessionId: string,
    parentSessionId: string | null,
    graph: Map<string, string | null> = readLineageGraph()
): LineageVerdict {
    if (parentSessionId === null) {
        // Promoting to top level cannot create a cycle: the chain ends immediately.
        return { status: 'clean', depth: 0 }
    }

    const walked: string[] = []
    let cursor: string | null = parentSessionId

    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
        if (cursor === null) {
            return { status: 'clean', depth }
        }
        if (cursor === sessionId) {
            return { status: 'cycle', via: [...walked, cursor] }
        }
        if (walked.includes(cursor)) {
            // The graph is already cyclic somewhere above the target. Not this change's
            // doing, but the app's lineage walk would still spin, so do not call it clean.
            return {
                status: 'unverified',
                reason: `the existing lineage above ${parentSessionId} already contains a cycle at ${cursor}`,
                walked
            }
        }
        walked.push(cursor)
        if (!graph.has(cursor)) {
            return {
                status: 'unverified',
                reason: `session ${cursor} is not in this machine's session cache, so its own parent could not be read`,
                walked
            }
        }
        cursor = graph.get(cursor) ?? null
    }

    return {
        status: 'unverified',
        reason: `ancestor chain exceeded ${MAX_LINEAGE_DEPTH} levels`,
        walked
    }
}

/**
 * Resolve a session's metadata + data key. Local cache first (no account secret
 * needed, covers every session started on this machine), then account credentials.
 */
async function resolveTarget(sessionId: string): Promise<ResolvedTarget> {
    try {
        const local = await resolveLocalReconnectableSession(sessionId)
        return {
            id: local.id,
            metadata: local.metadata,
            metadataVersion: local.metadataVersion,
            encryptionKey: local.encryptionKey,
            encryptionVariant: local.encryptionVariant,
            source: 'local-cache'
        }
    } catch (localError) {
        const localMessage =
            localError instanceof LocalResumeSessionError || localError instanceof Error
                ? localError.message
                : String(localError)
        try {
            const remote = await resolveReconnectableSession(sessionId)
            return {
                id: remote.id,
                metadata: remote.metadata,
                metadataVersion: remote.metadataVersion,
                encryptionKey: remote.encryptionKey,
                encryptionVariant: remote.encryptionVariant,
                source: 'account-credentials'
            }
        } catch (remoteError) {
            const remoteMessage = remoteError instanceof Error ? remoteError.message : String(remoteError)
            throw new Error(
                `cannot read session ${sessionId} on this machine. Local cache: ${localMessage} Account credentials: ${remoteMessage}`
            )
        }
    }
}

/**
 * Re-parent a session. See the file header for why this is safe to drive from a
 * running session's socket, and what each guard is protecting.
 */
export async function setSessionParent(
    client: ApiSessionClient,
    opts: SetSessionParentOptions
): Promise<SetParentResult> {
    const sessionId = opts.sessionId ?? client.sessionId
    const parentSessionId = opts.parentSessionId

    if (parentSessionId !== null && parentSessionId === sessionId) {
        return {
            ok: false,
            sessionId,
            code: 'self_parent',
            error: 'a session cannot be its own parent'
        }
    }

    const lineage = checkLineage(sessionId, parentSessionId)
    if (lineage.status === 'cycle') {
        return {
            ok: false,
            sessionId,
            code: 'cycle',
            error: `setting the parent to ${parentSessionId} would create a lineage cycle (${lineage.via.join(' -> ')} -> ${sessionId})`,
            lineage
        }
    }
    if (lineage.status === 'unverified' && !opts.allowUnverifiedLineage) {
        return {
            ok: false,
            sessionId,
            code: 'lineage_unverified',
            error: `lineage could not be verified: ${lineage.reason}. Re-run with allowUnverifiedLineage to apply anyway.`,
            lineage
        }
    }

    // Own session: route through the client's metadata lock so the in-memory copy and
    // the server stay in step. Writing our own row through the foreign path below would
    // leave this client's cached metadataVersion stale.
    if (sessionId === client.sessionId) {
        const previousParent = client.getMetadata()?.parentSessionId ?? null
        try {
            await client.updateMetadataAndWait((metadata) => applyParent(metadata, parentSessionId))
        } catch (error) {
            return {
                ok: false,
                sessionId,
                code: 'version_conflict',
                error: `failed to update own session metadata: ${error instanceof Error ? error.message : String(error)}`,
                lineage
            }
        }
        return { ok: true, sessionId, previousParent, parentSessionId, lineage, attempts: 1 }
    }

    let target: ResolvedTarget
    try {
        target = await resolveTarget(sessionId)
    } catch (error) {
        return {
            ok: false,
            sessionId,
            code: 'target_unreadable',
            error: error instanceof Error ? error.message : String(error),
            lineage
        }
    }

    const previousParent = target.metadata.parentSessionId ?? null
    let metadata = target.metadata
    let expectedVersion = target.metadataVersion

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
        const updated = applyParent(metadata, parentSessionId)
        const encrypted = encodeBase64(encrypt(target.encryptionKey, target.encryptionVariant, updated))
        const ack = await client.casSessionMetadata(sessionId, expectedVersion, encrypted)

        if (ack.result === 'success') {
            return { ok: true, sessionId, previousParent, parentSessionId, lineage, attempts: attempt }
        }
        if (ack.result === 'version-mismatch') {
            // Someone else wrote first. Re-derive from the value the server just handed
            // back rather than from our stale copy, then retry.
            const fresh = ack.metadata
                ? (decrypt(target.encryptionKey, target.encryptionVariant, decodeBase64(ack.metadata)) as Metadata | null)
                : null
            if (!fresh) {
                return {
                    ok: false,
                    sessionId,
                    code: 'version_conflict',
                    error: `metadata version mismatch on ${sessionId} and the server's current value could not be decrypted with the ${target.source} key`,
                    lineage
                }
            }
            metadata = fresh
            expectedVersion = ack.version ?? expectedVersion + 1
            logger.debug(`[setSessionParent] CAS retry ${attempt}/${MAX_CAS_ATTEMPTS} for ${sessionId} at version ${expectedVersion}`)
            continue
        }
        return {
            ok: false,
            sessionId,
            code: 'server_error',
            error: `server rejected the metadata update for ${sessionId}`,
            lineage
        }
    }

    return {
        ok: false,
        sessionId,
        code: 'version_conflict',
        error: `gave up after ${MAX_CAS_ATTEMPTS} CAS attempts — session ${sessionId} is being updated concurrently`,
        lineage
    }
}

/**
 * Setting the parent to null must REMOVE the key, not set it to null: the field is
 * optional throughout, and the app tests it for presence.
 */
function applyParent(metadata: Metadata, parentSessionId: string | null): Metadata {
    if (parentSessionId === null) {
        const { parentSessionId: _dropped, ...rest } = metadata
        return rest as Metadata
    }
    return { ...metadata, parentSessionId }
}
