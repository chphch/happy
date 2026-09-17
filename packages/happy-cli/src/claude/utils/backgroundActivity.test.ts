import { describe, expect, it } from 'vitest';
import {
    activityEquals,
    EMPTY_ACTIVITY,
    isActivityEmpty,
    MAX_ACTIVITY_ITEMS,
    parseBackgroundTasks,
    summarizeBackgroundTasks,
    taskKind,
    toActivityItems,
    truncate,
    type BackgroundTaskSummary,
} from './backgroundActivity';

const shell = (status = 'running'): BackgroundTaskSummary => ({
    id: `shell-${status}`,
    type: 'shell',
    status,
    description: 'Build and deploy webapp',
    command: 'pnpm build',
});

describe('parseBackgroundTasks', () => {
    it('keeps well-formed entries', () => {
        const tasks = parseBackgroundTasks([
            { id: 'b1', type: 'shell', status: 'running', description: 'x' },
            { id: 'a1', type: 'subagent', status: 'running', subagent_type: 'general-purpose' },
        ]);
        expect(tasks.map((t) => t.id)).toEqual(['b1', 'a1']);
    });

    it('drops malformed entries instead of throwing', () => {
        // A hook payload shape we do not recognize must never take the session down.
        expect(parseBackgroundTasks([
            { id: 'ok', type: 'shell', status: 'running' },
            { type: 'shell', status: 'running' },
            { id: 'no-type', status: 'running' },
            null,
            'nope',
            42,
        ]).map((t) => t.id)).toEqual(['ok']);
    });

    it('returns empty for a missing or non-array field', () => {
        expect(parseBackgroundTasks(undefined)).toEqual([]);
        expect(parseBackgroundTasks(null)).toEqual([]);
        expect(parseBackgroundTasks({ nope: true })).toEqual([]);
    });
});

describe('summarizeBackgroundTasks', () => {
    it('counts nothing when there are no tasks', () => {
        expect(summarizeBackgroundTasks([])).toEqual(EMPTY_ACTIVITY);
        expect(isActivityEmpty(summarizeBackgroundTasks([]))).toBe(true);
    });

    it('routes each task type into its own bucket', () => {
        const activity = summarizeBackgroundTasks([
            shell(),
            shell(),
            { id: 'a1', type: 'subagent', status: 'running' },
            { id: 'w1', type: 'workflow', status: 'running' },
        ]);
        expect(activity.processes.running).toBe(2);
        expect(activity.subagents).toEqual({ running: 1, queued: 0, total: 1 });
        expect(activity.workflows).toEqual({ running: 1, total: 1 });
        expect(isActivityEmpty(activity)).toBe(false);
    });

    it('separates queued subagents from running ones', () => {
        const activity = summarizeBackgroundTasks([
            { id: 'a1', type: 'subagent', status: 'running' },
            { id: 'a2', type: 'subagent', status: 'pending' },
            { id: 'a3', type: 'subagent', status: 'pending' },
        ]);
        // A fan-out should read as "1 running +2 queued", not "3 running".
        expect(activity.subagents).toEqual({ running: 1, queued: 2, total: 3 });
    });

    it('treats an unknown task type as a generic process rather than dropping it', () => {
        const activity = summarizeBackgroundTasks([
            { id: 'm1', type: 'monitor', status: 'running' },
            { id: 'x1', type: 'some_future_kind', status: 'running' },
        ]);
        expect(activity.processes.running).toBe(2);
        expect(isActivityEmpty(activity)).toBe(false);
    });

    it('matches the task type and status case-insensitively', () => {
        const activity = summarizeBackgroundTasks([
            { id: 'a1', type: 'Subagent', status: 'RUNNING' },
        ]);
        expect(activity.subagents).toEqual({ running: 1, queued: 0, total: 1 });
    });
});

describe('activityEquals', () => {
    it('is true for structurally identical summaries', () => {
        const tasks = [shell(), { id: 'a1', type: 'subagent', status: 'running' }];
        expect(activityEquals(summarizeBackgroundTasks(tasks), summarizeBackgroundTasks(tasks))).toBe(true);
    });

    it('is false once a count moves', () => {
        expect(activityEquals(
            summarizeBackgroundTasks([shell()]),
            summarizeBackgroundTasks([shell(), shell()]),
        )).toBe(false);
    });

    it('distinguishes a running task from a queued one of the same type', () => {
        expect(activityEquals(
            summarizeBackgroundTasks([{ id: 'a1', type: 'subagent', status: 'running' }]),
            summarizeBackgroundTasks([{ id: 'a1', type: 'subagent', status: 'pending' }]),
        )).toBe(false);
    });

    it('treats undefined as equal only to undefined', () => {
        expect(activityEquals(undefined, undefined)).toBe(true);
        expect(activityEquals(EMPTY_ACTIVITY, undefined)).toBe(false);
    });
});

describe('taskKind', () => {
    it('normalizes the kinds the app draws an icon for', () => {
        expect(taskKind('shell')).toBe('shell');
        expect(taskKind('Subagent')).toBe('subagent');
        expect(taskKind('WORKFLOW')).toBe('workflow');
    });

    it('sends an unrecognized kind to the generic bucket', () => {
        // A task type added by a newer Claude Code is still worth showing.
        expect(taskKind('monitor')).toBe('other');
    });
});

describe('truncate', () => {
    it('collapses whitespace so a heredoc command stays one line', () => {
        expect(truncate('pnpm   build\n  && pnpm test', 100)).toBe('pnpm build && pnpm test');
    });

    it('marks the cut with an ellipsis and never exceeds the budget', () => {
        const out = truncate('x'.repeat(50), 10);
        expect(out).toHaveLength(10);
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('toActivityItems', () => {
    it('names each kind by the field that identifies it', () => {
        const items = toActivityItems([
            { id: 'b1', type: 'shell', status: 'running', description: 'Build', command: 'pnpm build' },
            { id: 'a1', type: 'subagent', status: 'running', description: 'Batch 1', agent_type: 'general-purpose' },
            { id: 'w1', type: 'workflow', status: 'running', description: 'Audit', name: 'audit-flow' },
        ]);
        expect(items.map((i) => [i.kind, i.title, i.detail])).toEqual([
            ['shell', 'Build', 'pnpm build'],
            ['subagent', 'Batch 1', 'general-purpose'],
            ['workflow', 'Audit', 'audit-flow'],
        ]);
    });

    it('falls back to the older subagent_type spelling', () => {
        const [item] = toActivityItems([{ id: 'a1', type: 'subagent', status: 'running', subagent_type: 'Explore' }]);
        expect(item!.detail).toBe('Explore');
    });

    it('keeps a task with no description showing something useful', () => {
        const [item] = toActivityItems([{ id: 'b1', type: 'shell', status: 'running', command: 'make' }]);
        expect(item!.title).toBe('make');
    });

    it('names an unnamed agent from what disk knows it as', () => {
        // Claude Code may spawn an agent with no description; without this a
        // fan-out renders as N identical rows all titled "subagent".
        const [item] = toActivityItems(
            [{ id: 'a1', type: 'subagent', status: 'running' }],
            undefined,
            new Map([['a1', { progress: { done: 3 }, description: 'Full-read batch 7' }]]),
        );
        expect(item!.title).toBe('Full-read batch 7');
    });

    it("prefers the task's own description over the one on disk", () => {
        const [item] = toActivityItems(
            [{ id: 'a1', type: 'subagent', status: 'running', description: 'From the hook' }],
            undefined,
            new Map([['a1', { progress: { done: 3 }, description: 'From disk' }]]),
        );
        expect(item!.title).toBe('From the hook');
    });

    it('carries a whole real-world command rather than a preview of one', () => {
        // Measured over 638 real commands: median 302 chars, longest 1015. The
        // cap used to be 200, which cut 63% of them — the median did not fit.
        const command = 'pnpm build && ' + 'x'.repeat(900);
        const [item] = toActivityItems([{ id: 'b1', type: 'shell', status: 'running', command }]);
        expect(item!.detail).toBe(command);
        expect(item!.truncated).toBeUndefined();
    });

    it('caps a pathological command and says that it did', () => {
        const [item] = toActivityItems([{ id: 'b1', type: 'shell', status: 'running', command: 'x'.repeat(5000) }]);
        expect(item!.detail!.length).toBeLessThanOrEqual(1200);
        // The flag, not a trailing ellipsis: a command may legitimately end in one.
        expect(item!.truncated).toBe(true);
    });

    it('spends the shared budget in task order, squeezing the tail not the head', () => {
        // 24 tasks at the per-item cap would be 28 KB of metadata rewritten every
        // turn; the worst payload actually observed totalled 5 KB.
        const many = Array.from({ length: 20 }, (_, i) => ({
            id: `b${i}`, type: 'shell', status: 'running', command: 'y'.repeat(1000),
        }));
        const items = toActivityItems(many);
        expect(items[0]!.detail).toHaveLength(1000);
        expect(items[0]!.truncated).toBeUndefined();
        const total = items.reduce((sum, item) => sum + (item.detail?.length ?? 0), 0);
        expect(total).toBeLessThanOrEqual(8192 + 80 * items.length);
        expect(items[items.length - 1]!.truncated).toBe(true);
    });

    it('never squeezes a detail down to nothing', () => {
        // A row saying "b19" and an ellipsis helps nobody; a floor keeps the
        // squeezed tail at least readable.
        const many = Array.from({ length: 24 }, (_, i) => ({
            id: `b${i}`, type: 'shell', status: 'running', command: 'z'.repeat(2000),
        }));
        for (const item of toActivityItems(many)) {
            expect(item.detail!.length).toBeGreaterThanOrEqual(80);
        }
    });

    it('caps how many tasks ride in metadata at all', () => {
        const many = Array.from({ length: MAX_ACTIVITY_ITEMS + 10 }, (_, i) => ({
            id: `a${i}`, type: 'subagent', status: 'running',
        }));
        expect(toActivityItems(many)).toHaveLength(MAX_ACTIVITY_ITEMS);
    });

    it('carries first-seen time and progress when they are known', () => {
        const [item] = toActivityItems(
            [{ id: 'w1', type: 'workflow', status: 'running', name: 'flow' }],
            new Map([['w1', 1700]]),
            new Map([['w1', { progress: { done: 2, total: 5, phase: 'Investigate' } }]]),
        );
        expect(item).toMatchObject({ startedAt: 1700, progress: { done: 2, total: 5, phase: 'Investigate' } });
    });

    it('leaves startedAt absent when nothing knows it, rather than guessing now', () => {
        // The app must read a missing startedAt as "unknown", not "just started".
        const [item] = toActivityItems([{ id: 'w1', type: 'workflow', status: 'running' }]);
        expect(item!.startedAt).toBeUndefined();
    });
});

describe('activityEquals with items', () => {
    const withItems = (progressDone: number) => {
        const activity = summarizeBackgroundTasks([{ id: 'w1', type: 'workflow', status: 'running', name: 'flow' }]);
        activity.items = toActivityItems(
            [{ id: 'w1', type: 'workflow', status: 'running', name: 'flow' }],
            undefined,
            new Map([['w1', { progress: { done: progressDone, total: 5 } }]]),
        );
        return activity;
    };

    it('is false when only the progress moved', () => {
        // The counts are identical here — without comparing items, a workflow
        // advancing 2/5 -> 3/5 would never reach the app.
        expect(activityEquals(withItems(2), withItems(3))).toBe(false);
    });

    it('is true when nothing moved', () => {
        expect(activityEquals(withItems(2), withItems(2))).toBe(true);
    });
});
