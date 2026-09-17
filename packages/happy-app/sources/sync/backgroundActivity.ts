/**
 * The per-task detail behind the activity indicator.
 *
 * Two sources, deliberately different in freshness, because only one of them is
 * cheap:
 *
 * - **`metadata.activity.items`** arrives with the session like any other
 *   metadata. It costs nothing to read and is always there, so it is what the
 *   sheet renders the instant it opens — but the agent only republishes it at
 *   the end of a turn, so a long-running task's progress can be minutes old.
 * - **`background-activity-detail` RPC** asks the agent to re-read the
 *   journals now. It needs the session to be online and costs a round trip, so
 *   it runs after the first paint and then on a poll while the sheet is open.
 *
 * The task *list* is as stale as the metadata either way — the agent learns it
 * from a hook that only fires at turn end — which is why the RPC returns
 * `listedAt` and the screen says how old the list is instead of implying it is
 * live.
 */

import { z } from 'zod';
import { apiSocket } from './apiSocket';
import type { Metadata } from './storageTypes';

/** The kinds the UI draws differently. Anything else renders as a plain row. */
export type BackgroundTaskKind = 'shell' | 'subagent' | 'workflow' | 'other';

export function normalizeTaskKind(kind: string | undefined): BackgroundTaskKind {
    switch (kind?.trim().toLowerCase()) {
        case 'shell': return 'shell';
        case 'subagent': return 'subagent';
        case 'workflow': return 'workflow';
        default: return 'other';
    }
}

export type BackgroundTaskProgress = {
    done: number;
    total?: number;
    phase?: string;
    latest?: string;
    updatedAt?: number;
};

export type BackgroundTaskItem = {
    id: string;
    kind: BackgroundTaskKind;
    status: string;
    title: string;
    detail?: string;
    startedAt?: number;
    progress?: BackgroundTaskProgress;
};

/** One sub-agent of a workflow, as the RPC reports it. */
export type BackgroundWorkflowAgent = {
    agentId: string;
    label: string;
    phase?: string;
    done: boolean;
};

export type BackgroundTaskDetail = BackgroundTaskItem & {
    agents?: BackgroundWorkflowAgent[];
    latestText?: string;
    note?: string;
};

const ProgressSchema = z.object({
    done: z.number(),
    total: z.number().optional(),
    phase: z.string().optional(),
    latest: z.string().optional(),
    updatedAt: z.number().optional(),
}).passthrough();

const DetailSchema = z.object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    title: z.string(),
    detail: z.string().optional(),
    startedAt: z.number().optional(),
    progress: ProgressSchema.optional(),
    agents: z.array(z.object({
        agentId: z.string(),
        label: z.string(),
        phase: z.string().optional(),
        done: z.boolean(),
    }).passthrough()).optional(),
    latestText: z.string().optional(),
    note: z.string().optional(),
}).passthrough();

const DetailResultSchema = z.object({
    listedAt: z.number(),
    items: z.array(DetailSchema),
}).passthrough();

export type BackgroundActivityDetail = {
    /** When the agent last learned the task list — i.e. the last turn end. */
    listedAt: number;
    items: BackgroundTaskDetail[];
};

/**
 * The tasks carried in session metadata, ready to render.
 *
 * Returns `null` rather than an empty array when the agent published no items
 * at all, so the screen can tell "nothing is running" apart from "this agent is
 * too old to report what is running" — the counts alone cannot.
 */
export function getBackgroundTaskItems(metadata: Metadata | null | undefined): BackgroundTaskItem[] | null {
    const items = metadata?.activity?.items;
    if (!items) return null;
    return items.map((item) => ({
        id: item.id,
        kind: normalizeTaskKind(item.kind),
        status: item.status,
        title: item.title,
        detail: item.detail,
        startedAt: item.startedAt,
        progress: item.progress,
    }));
}

/** Ask the agent to re-read the journals now. Throws if the session is offline. */
export async function fetchBackgroundActivityDetail(sessionId: string): Promise<BackgroundActivityDetail> {
    const raw = await apiSocket.sessionRPC<unknown, Record<string, never>>(
        sessionId,
        'background-activity-detail',
        {},
    );
    const parsed = DetailResultSchema.parse(raw);
    return {
        listedAt: parsed.listedAt,
        items: parsed.items.map((item) => ({ ...item, kind: normalizeTaskKind(item.kind) })),
    };
}

/**
 * How far along a task is, as a fraction — only when the denominator means
 * something.
 *
 * A workflow knows how many sub-agents it has launched, so `2/5` is real. A
 * backgrounded agent reports turns taken with no idea how many remain, so it
 * gets no bar: showing one would invent a finish line that does not exist.
 */
export function progressFraction(item: BackgroundTaskItem): number | null {
    const { progress } = item;
    if (!progress || !progress.total || progress.total <= 0) return null;
    return Math.max(0, Math.min(1, progress.done / progress.total));
}
