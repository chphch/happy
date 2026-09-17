/**
 * Summarize Claude Code's in-flight background work for session metadata.
 *
 * Claude Code reports every registered background task on the `Stop` hook
 * payload as `background_tasks: [{ id, type, status, description, ... }]`,
 * where `type` is a friendly label — 'shell', 'subagent', 'workflow',
 * 'monitor', … — falling back to the raw discriminant for unknown kinds.
 *
 * This is the only signal that survives BOTH happy-cli launch modes: the local
 * launcher drives the `claude` binary through a PTY and the remote launcher
 * drives it through the SDK, but the binary runs its hooks either way. Reading
 * it here means the app learns about background work without happy-cli having
 * to reconstruct task lifecycles from transcript records.
 *
 * Why it matters: `thinking` is turn-scoped, so a session drops to "waiting"
 * the moment the turn ends — even when a 20-minute build or a still-running
 * subagent is the whole reason the session is still alive. The counts produced
 * here let the session list say "idle, but N things are still running", and the
 * per-task items let the app answer the next question — *which* N things.
 */

/** One entry of the Stop hook's `background_tasks` array. */
export interface BackgroundTaskSummary {
    id: string;
    /** 'shell' | 'subagent' | 'workflow' | raw discriminant. */
    type: string;
    status: string;
    description?: string;
    /** shell only: the command line being run. */
    command?: string;
    /**
     * subagent only: which agent definition was spawned. Claude Code spells
     * this `agent_type`; `subagent_type` is accepted too so a payload from a
     * differently-spelled build still names the agent instead of dropping it.
     */
    agent_type?: string;
    subagent_type?: string;
    /** workflow only: the script's `meta.name`, which also names its files on disk. */
    name?: string;
}

/** Which bucket a task belongs to, once its raw `type` has been normalized. */
export type BackgroundTaskKind = 'shell' | 'subagent' | 'workflow' | 'other';

/**
 * Live progress for a task that keeps a journal on disk. Absent for kinds that
 * do not (a background shell writes nothing we can read from here).
 */
export interface BackgroundTaskProgress {
    /** Finished units — workflow sub-agents that returned, or a subagent's completed turns. */
    done: number;
    /** Total units, when the journal knows it: workflow sub-agents launched so far. */
    total?: number;
    /** The workflow phase currently running, e.g. 'Investigate'. */
    phase?: string;
    /** Newest unit of work — a sub-agent's label, or the subagent's latest sentence. */
    latest?: string;
    /** Journal mtime, so a task that stopped moving is visible as such. */
    updatedAt?: number;
}

/**
 * One in-flight task as the app renders it. This is the detail the counts used
 * to throw away — the whole point of making the activity indicator tappable.
 */
export interface BackgroundTaskItem {
    id: string;
    kind: BackgroundTaskKind;
    status: string;
    /** The human description Claude Code gave the task. */
    title: string;
    /** shell: the command; subagent: its agent type; workflow: its script name. */
    detail?: string;
    /** When happy-cli first saw this id, so the app can show elapsed time. */
    startedAt?: number;
    /** `detail` was cut to fit metadata; the full text is on the RPC. */
    truncated?: boolean;
    progress?: BackgroundTaskProgress;
}

/**
 * Session activity counts, shaped to the app's `metadata.activity` schema.
 * Every bucket is always present so the app's Zod object schema parses it
 * whether or not a given kind of work is running.
 */
export interface SessionActivity {
    subagents: { running: number; queued: number; total: number };
    workflows: { running: number; total: number };
    processes: { running: number };
    tasks: { pending: number; inProgress: number; completed: number; total: number };
    /** Per-task detail, newest-first. Absent when nothing is running. */
    items?: BackgroundTaskItem[];
}

export const EMPTY_ACTIVITY: SessionActivity = {
    subagents: { running: 0, queued: 0, total: 0 },
    workflows: { running: 0, total: 0 },
    processes: { running: 0 },
    tasks: { pending: 0, inProgress: 0, completed: 0, total: 0 },
};

/**
 * Metadata is an encrypted blob rewritten on every turn under optimistic
 * concurrency, so the per-task detail is bounded. The bounds are measured, not
 * guessed — 638 real background shell commands and 524 real hook payloads from
 * this machine's happy-cli logs:
 *
 *   one command:  median 302 chars, p90 1014, max 1015
 *   one payload:  median 1 task, p90 4, max 24 — total detail max 5216 chars
 *
 * So `MAX_DETAIL_CHARS` is 1200: above the longest command ever observed, which
 * makes truncation the rare case instead of the usual one. (It was 200, which
 * cut 63% of real commands — the median command did not fit, and the first
 * person to open the screen hit it.) `MAX_TOTAL_DETAIL_CHARS` then bounds the
 * pathological payload the per-item cap alone cannot: 24 tasks each at the cap
 * would be 28 KB, while the worst payload actually seen totalled 5 KB.
 *
 * Whatever the caps do cut, the item says so with `truncated`, and the full
 * text stays available over RPC.
 */
export const MAX_ACTIVITY_ITEMS = 24;
const MAX_TITLE_CHARS = 120;
const MAX_DETAIL_CHARS = 1200;
const MAX_TOTAL_DETAIL_CHARS = 8192;
/** A detail squeezed by the total budget still has to be worth reading. */
const MIN_DETAIL_CHARS = 80;
const MAX_LATEST_CHARS = 160;

export function truncate(value: string, max: number): string {
    return truncateTracked(value, max).text;
}

/**
 * Truncate, and say whether anything was cut.
 *
 * The caller needs the flag rather than testing for a trailing `…`: a command
 * can legitimately end in one, so an ellipsis is not evidence of truncation and
 * a UI that guesses from it will sometimes lie in both directions.
 */
export function truncateTracked(value: string, max: number): { text: string; truncated: boolean } {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= max) return { text: collapsed, truncated: false };
    return { text: `${collapsed.slice(0, max - 1)}…`, truncated: true };
}

/**
 * A task Claude Code still lists is in flight by definition, but only some of
 * them have actually started. Anything not explicitly 'running' is counted as
 * queued so a large fan-out reads as "2 running +6 queued" rather than "8 running".
 */
function isRunning(status: string): boolean {
    return status.toLowerCase() === 'running';
}

function isBackgroundTask(value: unknown): value is BackgroundTaskSummary {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const task = value as Record<string, unknown>;
    return typeof task.id === 'string' && typeof task.type === 'string' && typeof task.status === 'string';
}

/**
 * Pull the well-formed entries out of a raw hook payload's `background_tasks`.
 * Malformed entries are dropped rather than throwing — a hook payload shape we
 * do not recognize must never take the session down.
 */
export function parseBackgroundTasks(value: unknown): BackgroundTaskSummary[] {
    return Array.isArray(value) ? value.filter(isBackgroundTask) : [];
}

/** Normalize the hook's free-form `type` into the bucket the app renders. */
export function taskKind(type: string): BackgroundTaskKind {
    switch (type.toLowerCase()) {
        case 'subagent': return 'subagent';
        case 'workflow': return 'workflow';
        case 'shell': return 'shell';
        default: return 'other';
    }
}

/**
 * Fold background tasks into the counts the app renders.
 *
 * 'shell' and every unrecognized kind land in `processes`, which is the app's
 * generic "something is running on the machine" bucket — an unknown future task
 * type is still worth showing as activity, just without a specific icon.
 */
export function summarizeBackgroundTasks(tasks: BackgroundTaskSummary[]): SessionActivity {
    const activity: SessionActivity = {
        subagents: { running: 0, queued: 0, total: 0 },
        workflows: { running: 0, total: 0 },
        processes: { running: 0 },
        tasks: { pending: 0, inProgress: 0, completed: 0, total: 0 },
    };

    for (const task of tasks) {
        const running = isRunning(task.status);
        switch (taskKind(task.type)) {
            case 'subagent':
                activity.subagents.total += 1;
                if (running) {
                    activity.subagents.running += 1;
                } else {
                    activity.subagents.queued += 1;
                }
                break;
            case 'workflow':
                activity.workflows.total += 1;
                if (running) {
                    activity.workflows.running += 1;
                }
                break;
            default:
                activity.processes.running += 1;
                break;
        }
    }

    return activity;
}

/** The raw text a task's `detail` line is built from, by kind. */
function rawDetail(task: BackgroundTaskSummary, kind: BackgroundTaskKind): string | undefined {
    return kind === 'shell'
        ? task.command
        : kind === 'subagent'
            ? (task.agent_type ?? task.subagent_type)
            : kind === 'workflow'
                ? task.name
                : task.command;
}

/**
 * Build the per-task list the app shows when the activity indicator is tapped.
 *
 * `firstSeenAt` maps a task id to when this process first observed it. The hook
 * payload carries no timestamp, so elapsed time can only come from happy-cli's
 * own memory of the id — which also means it resets if happy-cli restarts, and
 * the app must treat a missing `startedAt` as "unknown", not as "just started".
 */
export function toActivityItems(
    tasks: BackgroundTaskSummary[],
    firstSeenAt?: ReadonlyMap<string, number>,
    factsById?: ReadonlyMap<string, { progress: BackgroundTaskProgress; description?: string }>,
): BackgroundTaskItem[] {
    // Spent in task order, so the tasks a person is most likely to be waiting on
    // keep their full text and a long tail of queued work is what gets squeezed.
    let budget = MAX_TOTAL_DETAIL_CHARS;

    return tasks.slice(0, MAX_ACTIVITY_ITEMS).map((task) => {
        const kind = taskKind(task.type);
        const facts = factsById?.get(task.id);
        const progress = facts?.progress;
        const item: BackgroundTaskItem = {
            id: task.id,
            kind,
            // The task's own description first, then the name disk knows it by;
            // `type` is the last resort and is what an unnamed fan-out would
            // otherwise render as N identical rows of.
            title: truncate(
                task.description ?? facts?.description ?? task.name ?? task.command ?? task.type,
                MAX_TITLE_CHARS,
            ),
            status: task.status,
        };

        const raw = rawDetail(task, kind);
        if (raw) {
            const allowed = Math.max(MIN_DETAIL_CHARS, Math.min(MAX_DETAIL_CHARS, budget));
            const { text, truncated } = truncateTracked(raw, allowed);
            item.detail = text;
            if (truncated) item.truncated = true;
            budget = Math.max(0, budget - text.length);
        }

        const startedAt = firstSeenAt?.get(task.id);
        if (startedAt !== undefined) item.startedAt = startedAt;
        if (progress) {
            item.progress = progress.latest
                ? { ...progress, latest: truncate(progress.latest, MAX_LATEST_CHARS) }
                : progress;
        }
        return item;
    });
}

/** Whether an activity summary carries no in-flight work at all. */
export function isActivityEmpty(activity: SessionActivity): boolean {
    return activity.subagents.total === 0
        && activity.workflows.total === 0
        && activity.processes.running === 0
        && activity.tasks.total === 0;
}

function progressEquals(a: BackgroundTaskProgress | undefined, b: BackgroundTaskProgress | undefined): boolean {
    if (!a || !b) return a === b;
    return a.done === b.done
        && a.total === b.total
        && a.phase === b.phase
        && a.latest === b.latest
        && a.updatedAt === b.updatedAt;
}

function itemsEqual(a: BackgroundTaskItem[] | undefined, b: BackgroundTaskItem[] | undefined): boolean {
    if (!a || !b) return a === b;
    if (a.length !== b.length) return false;
    return a.every((item, index) => {
        const other = b[index];
        return item.id === other.id
            && item.kind === other.kind
            && item.status === other.status
            && item.title === other.title
            && item.detail === other.detail
            && item.truncated === other.truncated
            && item.startedAt === other.startedAt
            && progressEquals(item.progress, other.progress);
    });
}

/**
 * Structural equality, used to skip redundant metadata writes. Metadata updates
 * are read-modify-write against the server under optimistic concurrency, so
 * re-sending an identical `activity` on every idle turn is pure churn.
 */
export function activityEquals(a: SessionActivity | undefined, b: SessionActivity | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    return a.subagents.running === b.subagents.running
        && a.subagents.queued === b.subagents.queued
        && a.subagents.total === b.subagents.total
        && a.workflows.running === b.workflows.running
        && a.workflows.total === b.workflows.total
        && a.processes.running === b.processes.running
        && a.tasks.pending === b.tasks.pending
        && a.tasks.inProgress === b.tasks.inProgress
        && a.tasks.completed === b.tasks.completed
        && a.tasks.total === b.tasks.total
        && itemsEqual(a.items, b.items);
}
