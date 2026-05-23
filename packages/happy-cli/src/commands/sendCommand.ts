/**
 * `happy send` — push a user message into another Happy session.
 *
 * The receiving session's apiSession picks the message up via its existing
 * socket `new-message` route (apiSession.ts) and feeds it to its agent —
 * identical wire shape to a message sent from the mobile/web app.
 *
 * Targeting works against sessions cached in ~/.happy/sessions.json, which
 * is populated whenever this machine joins/creates a session. Sessions that
 * only exist on other devices (e.g. mobile-only) are not reachable because
 * this install does not hold the account content secret key needed to
 * decrypt their per-session dataEncryptionKey.
 */

import axios from 'axios'
import chalk from 'chalk'
import { randomUUID } from 'node:crypto'

import { configuration } from '@/configuration'
import { readCredentials, readPersistedSessions, type PersistedSession } from '@/persistence'
import { encodeBase64, encrypt } from '@/api/encryption'
import { logger } from '@/ui/logger'

function printHelp(): void {
  console.log(`
${chalk.bold('happy send')} - Send a user message to another Happy session

${chalk.bold('Usage:')}
  happy send --list                   List recently cached sessions
  happy send <session-id> <text...>   Send <text> as a user message to that session

${chalk.bold('Examples:')}
  happy send --list
  happy send cmphrci0p "ping from sister session"

${chalk.bold('Notes:')}
  - <session-id> may be a unique prefix of the full id.
  - The target session must be cached in ~/.happy/sessions.json on this
    machine (i.e. this install has previously joined/created it).
  - Only the dataKey encryption variant is supported here; legacy sessions
    will be rejected with a clear error.
`)
}

function resolveSession(idOrPrefix: string): { id: string; session: PersistedSession } {
  const all = readPersistedSessions()
  const direct = all[idOrPrefix]
  if (direct) return { id: idOrPrefix, session: direct }

  const matches = Object.entries(all).filter(([id]) => id.startsWith(idOrPrefix))
  if (matches.length === 0) {
    throw new Error(`No cached session matches "${idOrPrefix}" — run \`happy send --list\` to inspect.`)
  }
  if (matches.length > 1) {
    const sample = matches.slice(0, 5).map(([id]) => `  ${id}`).join('\n')
    throw new Error(`Ambiguous session prefix "${idOrPrefix}" (${matches.length} matches):\n${sample}`)
  }
  return { id: matches[0][0], session: matches[0][1] }
}

function listSessions(): void {
  const sessions = readPersistedSessions()
  const entries = Object.entries(sessions)
    .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0))
    .slice(0, 30)
  console.log(`Top ${entries.length} of ${Object.keys(sessions).length} cached sessions (by savedAt):\n`)
  for (const [id, s] of entries) {
    const when = s.savedAt ? new Date(s.savedAt).toISOString() : '?'
    const p = (s.metadata && (s.metadata as { path?: string }).path) || '(no path)'
    console.log(`  ${id.slice(0, 12)}…  ${when}  ${s.encryptionVariant.padEnd(8)} ${p}`)
  }
}

async function postUserMessage(idOrPrefix: string, text: string): Promise<void> {
  const credentials = await readCredentials()
  if (!credentials) {
    throw new Error('No credentials at ~/.happy/access.key — run `happy auth login` first.')
  }

  const { id: sessionId, session } = resolveSession(idOrPrefix)

  // The encryption helper picks the right algorithm by variant — but we still
  // gate on dataKey here because legacy sessions need the account-wide secret
  // (credentials.encryption.secret), and we want a clear error for users on
  // dataKey-only installs trying to message a legacy session.
  let key: Uint8Array
  if (session.encryptionVariant === 'dataKey') {
    key = new Uint8Array(Buffer.from(session.encryptionKey, 'base64'))
  } else if (session.encryptionVariant === 'legacy') {
    if (credentials.encryption.type !== 'legacy') {
      throw new Error(
        `Session ${sessionId} is legacy-encrypted but this install uses dataKey credentials — cannot send.`,
      )
    }
    key = credentials.encryption.secret
  } else {
    throw new Error(`Unknown encryptionVariant: ${(session as PersistedSession).encryptionVariant}`)
  }

  const userMessage = {
    role: 'user' as const,
    content: { type: 'text' as const, text },
  }

  const encryptedBundle = encrypt(key, session.encryptionVariant, userMessage)
  const contentB64 = encodeBase64(encryptedBundle)
  const localId = randomUUID()

  const url = `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`
  logger.debug(`[send] POST ${url} session=${sessionId} variant=${session.encryptionVariant}`)

  console.log(chalk.gray('→'), chalk.bold(sessionId))
  const sessionPath = (session.metadata && (session.metadata as { path?: string }).path) || '(unknown path)'
  console.log(chalk.gray('  path :'), sessionPath)
  console.log(chalk.gray('  text :'), text)

  try {
    const res = await axios.post(
      url,
      { messages: [{ content: contentB64, localId }] },
      {
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
          'X-Happy-Client': `cli-send/${configuration.currentCliVersion}`,
        },
        timeout: 30000,
      },
    )
    const seq = res.data?.messages?.[0]?.seq
    console.log(chalk.green('✓ delivered'), seq != null ? chalk.gray(`(seq=${seq})`) : '')
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const { status, data } = err.response
      if (status === 404) {
        throw new Error(
          `Server returned 404 for session ${sessionId}. The session may belong to a different account, ` +
            `or no longer exist on the server.`,
        )
      }
      if (status === 401) {
        throw new Error(`Server returned 401. Token may be expired — try \`happy auth login --force\`.`)
      }
      throw new Error(`Server returned ${status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    }
    throw err
  }
}

export async function handleSendCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp()
    return
  }
  if (args[0] === '--list' || args[0] === '-l') {
    listSessions()
    return
  }
  const [idOrPrefix, ...rest] = args
  if (rest.length === 0) {
    throw new Error('Missing message text. Usage: happy send <session-id> "<text>"')
  }
  const text = rest.join(' ')
  await postUserMessage(idOrPrefix, text)
}
