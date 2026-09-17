/**
 * Read the progress of in-flight background work from Claude Code's own
 * on-disk journals.
 *
 * The Stop hook tells us *what* is running (see `backgroundActivity.ts`) but
 * nothing about how far along it is. For the two kinds that fan out — a
 * Workflow and a backgrounded Agent — Claude Code keeps that on disk beside the
 * session transcript, and happy-cli runs on the same machine, so it can read it:
 *
 * ```
 * ~/.claude/projects/<encoded-cwd>/
 *   <session-id>.jsonl                          the session transcript
 *   <session-id>/
 *     subagents/
 *       agent-<agentId>.jsonl                   a backgrounded Agent's transcript
 *       agent-<agentId>.meta.json               its agentType / description
 *       workflows/<runId>/journal.jsonl         a Workflow's launched/started/result log
 *       workflows/<runId>/agent-<agentId>.jsonl each workflow sub-agent's transcript
 *     workflows/scripts/<name>-<runId>.js       the workflow script
 * ```
 *
 * Two id shapes matter, and only one of them lines up for free:
 *
 * - A **subagent** task id from the hook (`afae91ced093e5d14`) IS the `agentId`
 *   in the filename, so the transcript is one path join away.
 * - A **workflow** task id (`wlq8xr2wv`) is NOT the run id its directory is
 *   named after (`wf_2e8bb897-cf4`). The link between them is only stated in the
 *   Workflow tool's result text in the transcript. Rather than parse a
 *   human-readable tool result, this module maps through the script file, whose
 *   name is `<workflow name>-<runId>.js` and whose name the hook does give us.
 *
 * Everything here fails soft: a session whose files have been cleaned up, a
 * journal being written as we read it, or a shape from a newer Claude Code must
 * degrade to "no progress information", never to a thrown error. The caller is
 * a hook handler on the session's critical path.
 */

import { readFile, readdir, stat, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BackgroundTaskProgress, BackgroundTaskSummary } from './backgroundActivity';
import { taskKind } from './backgroundActivity';

/** Tail bytes read from a transcript. Enough for the last few records. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** A journal is a few dozen short lines; refuse anything pathological. */
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

/**
 * The per-session directory that holds `subagents/` and `workflows/`.
 *
 * Claude Code names it after the transcript with the extension dropped, so the
 * transcript path the hook already sends is all we need — no re-deriving the
 * encoded-cwd, which has its own escaping rules and would drift.
 */
export function sessionDirForTranscript(transcriptPath: string | undefined): string | null {
    if (!transcriptPath || !transcriptPath.endsWith('.jsonl')) return null;
    return transcriptPath.slice(0, -'.jsonl'.length);
}

/** Read at most the last `bytes` of a file, dropping the first partial line. */
async function readTail(path: string, bytes: number): Promise<string | null> {
    let handle;
    try {
        handle = await open(path, 'r');
        const { size } = await handle.stat();
        const start = Math.max(0, size - bytes);
        const length = size - start;
        if (length <= 0) return '';
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        const text = buffer.toString('utf8');
        // A non-zero start almost certainly lands mid-line; that fragment is
        // not parseable JSON and would otherwise be counted as a bad record.
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => { });
    }
}

function parseLines(text: string): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                records.push(parsed as Record<string, unknown>);
            }
        } catch {
            // A half-written trailing line is normal while the producer is live.
        }
    }
    return records;
}

async function mtimeMs(path: string): Promise<number | undefined> {
    try {
        // Rounded: mtimeMs carries sub-millisecond precision on APFS, and a
        // fractional timestamp is meaningless to a UI that renders whole
        // seconds while making the value look like a computed quantity.
        return Math.round((await stat(path)).mtimeMs);
    } catch {
        return undefined;
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Find the run directory for a workflow, given the `name` the hook reports.
 *
 * The script file is the only artifact that carries both, so the run id is
 * recovered from its filename. A name run more than once leaves several, and
 * the newest is the one still in flight.
 */
export async function findWorkflowRunDir(sessionDir: string, name: string): Promise<string | null> {
    try {
        const scriptsDir = join(sessionDir, 'workflows', 'scripts');
        const candidates: { runId: string; mtime: number }[] = [];
        for (const entry of await readdir(scriptsDir)) {
            if (!entry.startsWith(`${name}-`) || !entry.endsWith('.js')) continue;
            const runId = entry.slice(name.length + 1, -'.js'.length);
            if (!runId) continue;
            const mtime = await mtimeMs(join(scriptsDir, entry)) ?? 0;
            candidates.push({ runId, mtime });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.mtime - a.mtime);
        return join(sessionDir, 'subagents', 'workflows', candidates[0]!.runId);
    } catch {
        return null;
    }
}

/** One sub-agent of a workflow, as its journal describes it. */
export interface WorkflowAgentEntry {
    agentId: string;
    label: string;
    phase?: string;
    done: boolean;
}

export interface WorkflowJournal {
    runDir: string;
    agents: WorkflowAgentEntry[];
    updatedAt?: number;
}

/**
 * Read a workflow's journal into its sub-agent list.
 *
 * The journal is append-only with three record types — `launched` once, then a
 * `started` per sub-agent and a `result` per sub-agent that returned — so
 * "finished / launched so far" falls straight out of it. `total` is what has
 * been *started*, not what the script will eventually start: a pipeline adds
 * agents as earlier phases complete, so the denominator legitimately grows.
 */
export async function readWorkflowJournal(runDir: string): Promise<WorkflowJournal | null> {
    const journalPath = join(runDir, 'journal.jsonl');
    let text: string | null;
    try {
        const { size } = await stat(journalPath);
        text = size > MAX_JOURNAL_BYTES
            ? await readTail(journalPath, MAX_JOURNAL_BYTES)
            : await readFile(journalPath, 'utf8');
    } catch {
        return null;
    }
    if (text === null) return null;

    const byId = new Map<string, WorkflowAgentEntry>();
    const order: string[] = [];
    for (const record of parseLines(text)) {
        const agentId = asString(record.agentId);
        if (!agentId) continue;
        if (record.type === 'started') {
            if (!byId.has(agentId)) order.push(agentId);
            byId.set(agentId, {
                agentId,
                label: asString(record.label) ?? agentId,
                phase: asString(record.phase),
                done: byId.get(agentId)?.done ?? false,
            });
        } else if (record.type === 'result') {
            const existing = byId.get(agentId);
            if (existing) {
                existing.done = true;
            } else {
                // A result with no preceding `started` means the tail cut the
                // start off; still worth counting as a finished unit.
                order.push(agentId);
                byId.set(agentId, { agentId, label: agentId, done: true });
            }
        }
    }

    return {
        runDir,
        agents: order.map((id) => byId.get(id)!).filter(Boolean),
        updatedAt: await mtimeMs(journalPath),
    };
}

function workflowProgress(journal: WorkflowJournal): BackgroundTaskProgress {
    const done = journal.agents.filter((agent) => agent.done).length;
    const pending = journal.agents.filter((agent) => !agent.done);
    return {
        done,
        total: journal.agents.length,
        // The phase still being worked is the one the unfinished agents are in;
        // once they all return, the last phase seen is the right thing to show.
        phase: pending[0]?.phase ?? journal.agents[journal.agents.length - 1]?.phase,
        latest: pending[pending.length - 1]?.label ?? journal.agents[journal.agents.length - 1]?.label,
        updatedAt: journal.updatedAt,
    };
}

/** What a backgrounded Agent's own files say about it. */
export interface SubagentSnapshot {
    agentType?: string;
    description?: string;
    /** Assistant turns recorded so far — a rough "how much work has happened". */
    turns: number;
    /** The newest thing the agent said, for a one-line "currently…". */
    latestText?: string;
    updatedAt?: number;
}

function transcriptCandidates(sessionDir: string, agentId: string, runDirs: string[]): string[] {
    const file = `agent-${agentId}.jsonl`;
    return [join(sessionDir, 'subagents', file), ...runDirs.map((dir) => join(dir, file))];
}

/**
 * Read a backgrounded Agent's transcript tail.
 *
 * Only the tail: these transcripts reach megabytes, this runs on a hook, and
 * everything we want — how recently it spoke and what it last said — is at the
 * end. The turn count is therefore a count *within the tail*, so it is a floor,
 * not a total; it is presented as movement, never as a completion ratio.
 */
export async function readSubagentSnapshot(
    sessionDir: string,
    agentId: string,
    runDirs: string[] = [],
): Promise<SubagentSnapshot | null> {
    let meta: Record<string, unknown> | undefined;
    try {
        meta = JSON.parse(await readFile(join(sessionDir, 'subagents', `agent-${agentId}.meta.json`), 'utf8'));
    } catch {
        meta = undefined;
    }

    for (const path of transcriptCandidates(sessionDir, agentId, runDirs)) {
        const text = await readTail(path, TRANSCRIPT_TAIL_BYTES);
        if (text === null) continue;
        let turns = 0;
        let latestText: string | undefined;
        for (const record of parseLines(text)) {
            if (record.type !== 'assistant') continue;
            turns += 1;
            const message = record.message as { content?: unknown } | undefined;
            if (!Array.isArray(message?.content)) continue;
            for (const block of message.content) {
                const blockText = asString((block as { text?: unknown })?.text);
                if (blockText) latestText = blockText;
            }
        }
        return {
            agentType: asString(meta?.agentType),
            description: asString(meta?.description),
            turns,
            latestText,
            updatedAt: await mtimeMs(path),
        };
    }

    // No transcript yet — the agent was spawned but has not written. The meta
    // file alone is still worth returning so the app can name it.
    return meta ? { agentType: asString(meta.agentType), description: asString(meta.description), turns: 0 } : null;
}

function subagentProgress(snapshot: SubagentSnapshot): BackgroundTaskProgress {
    return {
        done: snapshot.turns,
        latest: snapshot.latestText,
        updatedAt: snapshot.updatedAt,
    };
}

/** What the journals add to one task: how far along it is, and what to call it. */
export interface TaskJournalFacts {
    progress: BackgroundTaskProgress;
    /**
     * A name from disk, used only when the hook gave the task no description.
     * A fan-out spawned without one would otherwise render as N identical rows
     * all titled "subagent".
     */
    description?: string;
}

/**
 * Journal facts for every task that has a journal, keyed by the task id the
 * hook used.
 *
 * Tasks with nothing readable are simply absent from the map — the app renders
 * those as a plain "running" row, which is all a background shell can offer
 * anyway (its output lives inside the Claude process, not on disk).
 */
export async function collectProgress(
    transcriptPath: string | undefined,
    tasks: BackgroundTaskSummary[],
): Promise<Map<string, TaskJournalFacts>> {
    const progress = new Map<string, TaskJournalFacts>();
    const sessionDir = sessionDirForTranscript(transcriptPath);
    if (!sessionDir) return progress;

    // Workflows first, and only then subagents: resolving a workflow is what
    // discovers its run directory, and a subagent transcript may live inside
    // one. Collecting both in a single concurrent pass would have the subagent
    // lookups race the list they depend on.
    const runDirs: string[] = [];
    await Promise.all(tasks.filter((task) => taskKind(task.type) === 'workflow').map(async (task) => {
        try {
            if (!task.name) return;
            const runDir = await findWorkflowRunDir(sessionDir, task.name);
            if (!runDir) return;
            runDirs.push(runDir);
            const journal = await readWorkflowJournal(runDir);
            if (journal) progress.set(task.id, { progress: workflowProgress(journal) });
        } catch {
            // Progress is a nicety; never let it break the activity update.
        }
    }));

    await Promise.all(tasks.filter((task) => taskKind(task.type) === 'subagent').map(async (task) => {
        try {
            const snapshot = await readSubagentSnapshot(sessionDir, task.id, runDirs);
            if (snapshot) {
                progress.set(task.id, { progress: subagentProgress(snapshot), description: snapshot.description });
            }
        } catch {
            // Same: a missing or malformed transcript must not fail the update.
        }
    }));

    return progress;
}
