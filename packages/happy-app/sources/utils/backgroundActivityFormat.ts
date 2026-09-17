/**
 * Formatting for the background-work screen.
 *
 * Kept apart from the components so the awkward parts — an elapsed time the
 * agent may not know, a denominator that only some task kinds have, a list
 * whose age the user has to be told about — are testable without rendering.
 */

import type { BackgroundTaskItem, BackgroundTaskKind, BackgroundWorkflowAgent } from '@/sync/backgroundActivity';

/**
 * A compact duration: `45s`, `12m`, `1h 4m`, `2d 3h`.
 *
 * Returns null below a second and for anything negative, which is what a clock
 * skew between the agent's machine and this device looks like. Showing `-3m`
 * would read as a bug; showing nothing reads as "not known yet", which is true.
 */
export function formatCompactDuration(ms: number): string | null {
    if (!Number.isFinite(ms) || ms < 1000) return null;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const restMinutes = minutes % 60;
        return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
    }
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/**
 * How long a task has been running, or null when nothing knows.
 *
 * `startedAt` is the agent's memory of first seeing the task, not a timestamp
 * from Claude Code — it has none. So it resets when the agent restarts, and an
 * absent value means "unknown", never "just started".
 */
export function formatElapsed(item: BackgroundTaskItem, now: number): string | null {
    if (item.startedAt === undefined) return null;
    return formatCompactDuration(now - item.startedAt);
}

/** How long ago the agent last moved this task's journal, or null. */
export function formatLastMovement(item: BackgroundTaskItem, now: number): string | null {
    const updatedAt = item.progress?.updatedAt;
    if (updatedAt === undefined) return null;
    return formatCompactDuration(now - updatedAt);
}

/**
 * Whether a task looks stalled: it claims to be running, but the file that
 * tracks it has not been touched in a while.
 *
 * Only a **backgrounded agent** can be judged this way, because only its
 * transcript is appended on every turn — silence there really does mean no work.
 * A workflow's journal is written only when a sub-agent starts or returns, so a
 * perfectly healthy workflow running three long agents writes nothing for the
 * whole time, and judging it by the same rule would flag it as stuck. A
 * background shell writes nothing we can read at all.
 */
export function looksStalled(item: BackgroundTaskItem, now: number, thresholdMs = 10 * 60 * 1000): boolean {
    if (item.kind !== 'subagent') return false;
    const updatedAt = item.progress?.updatedAt;
    if (updatedAt === undefined) return false;
    return now - updatedAt > thresholdMs;
}

/** The icon name for a kind, matching the activity bar's existing icons. */
export function iconForKind(kind: BackgroundTaskKind): string {
    switch (kind) {
        case 'subagent': return 'people-outline';
        case 'workflow': return 'git-network-outline';
        case 'shell': return 'terminal-outline';
        default: return 'ellipse-outline';
    }
}

/** Whether a task's status string means it has actually started. */
export function isRunningStatus(status: string): boolean {
    return status.trim().toLowerCase() === 'running';
}

/**
 * Group tasks for display: running first, then queued, each keeping the order
 * the agent reported. A fan-out of twenty agents is mostly queued, and burying
 * the two that are actually working under them is the wrong answer to "what is
 * happening right now".
 */
export function orderForDisplay<T extends { status: string }>(items: T[]): T[] {
    const running = items.filter((item) => isRunningStatus(item.status));
    const rest = items.filter((item) => !isRunningStatus(item.status));
    return [...running, ...rest];
}

/**
 * Which of a workflow's sub-agents to show while the card is collapsed.
 *
 * Expanded, they stay in launch order — that reads like a progress list and
 * keeps the phases in sequence. Collapsed, launch order is the wrong answer: a
 * twenty-agent workflow would show four finished ones and none of the agents
 * actually working. So the collapsed view prefers the unfinished, and falls
 * back to the most recently finished once everything has returned.
 */
export function agentsForCollapsedView(
    agents: BackgroundWorkflowAgent[],
    limit: number,
): BackgroundWorkflowAgent[] {
    const pending = agents.filter((agent) => !agent.done);
    if (pending.length >= limit) return pending.slice(0, limit);
    const finished = agents.filter((agent) => agent.done);
    return [...pending, ...finished.slice(-(limit - pending.length))];
}
