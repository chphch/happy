import { describe, expect, it } from 'vitest';
import {
    agentsForCollapsedView,
    formatCompactDuration,
    formatElapsed,
    formatLastMovement,
    isRunningStatus,
    looksStalled,
    orderForDisplay,
} from './backgroundActivityFormat';
import type { BackgroundTaskItem } from '@/sync/backgroundActivity';

const task = (over: Partial<BackgroundTaskItem> = {}): BackgroundTaskItem => ({
    id: 'w1',
    kind: 'workflow',
    status: 'running',
    title: 'Audit the thing',
    ...over,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('formatCompactDuration', () => {
    it('steps through seconds, minutes, hours and days', () => {
        expect(formatCompactDuration(45_000)).toBe('45s');
        expect(formatCompactDuration(12 * MINUTE)).toBe('12m');
        expect(formatCompactDuration(HOUR + 4 * MINUTE)).toBe('1h 4m');
        expect(formatCompactDuration(2 * 24 * HOUR + 3 * HOUR)).toBe('2d 3h');
    });

    it('drops the smaller unit when it is zero', () => {
        expect(formatCompactDuration(2 * HOUR)).toBe('2h');
        expect(formatCompactDuration(3 * 24 * HOUR)).toBe('3d');
    });

    it('returns null below a second', () => {
        expect(formatCompactDuration(0)).toBeNull();
        expect(formatCompactDuration(999)).toBeNull();
    });

    it('returns null for a negative span rather than rendering "-3m"', () => {
        // The agent's clock and this device's clock are not the same clock.
        expect(formatCompactDuration(-3 * MINUTE)).toBeNull();
        expect(formatCompactDuration(Number.NaN)).toBeNull();
    });
});

describe('formatElapsed', () => {
    it('measures from when the agent first saw the task', () => {
        expect(formatElapsed(task({ startedAt: 1000 }), 1000 + 5 * MINUTE)).toBe('5m');
    });

    it('is null when the agent never reported a start', () => {
        // Must read as "unknown", never as "just started".
        expect(formatElapsed(task(), Date.now())).toBeNull();
    });
});

describe('formatLastMovement', () => {
    it('reports the age of the journal, not of the task', () => {
        const item = task({ startedAt: 0, progress: { done: 1, updatedAt: 10 * MINUTE } });
        expect(formatLastMovement(item, 12 * MINUTE)).toBe('2m');
    });

    it('is null for a kind that writes no journal', () => {
        expect(formatLastMovement(task({ kind: 'shell', startedAt: 0 }), 5 * MINUTE)).toBeNull();
    });
});

describe('looksStalled', () => {
    it('is true once a quiet agent passes the threshold', () => {
        const item = task({ kind: 'subagent', progress: { done: 1, updatedAt: 0 } });
        expect(looksStalled(item, 11 * MINUTE)).toBe(true);
        expect(looksStalled(item, 9 * MINUTE)).toBe(false);
    });

    it('never flags a quiet workflow, whose journal only moves between agents', () => {
        // A healthy workflow running three long sub-agents writes nothing for
        // the whole time; judging it by file mtime would call that stuck.
        const item = task({ kind: 'workflow', progress: { done: 1, total: 3, updatedAt: 0 } });
        expect(looksStalled(item, 60 * MINUTE)).toBe(false);
    });

    it('is never true for a task that keeps no journal', () => {
        // A background shell writes nothing we can read, so silence is not a signal.
        expect(looksStalled(task({ kind: 'shell' }), Date.now())).toBe(false);
    });
});

describe('isRunningStatus', () => {
    it('accepts the status however it is cased or padded', () => {
        expect(isRunningStatus('running')).toBe(true);
        expect(isRunningStatus(' Running ')).toBe(true);
        expect(isRunningStatus('pending')).toBe(false);
    });
});

describe('orderForDisplay', () => {
    it('floats running tasks above queued ones without reshuffling either', () => {
        // A twenty-agent fan-out is mostly queued; the two doing work must not
        // be buried under them.
        const items = [
            task({ id: 'q1', status: 'pending' }),
            task({ id: 'r1', status: 'running' }),
            task({ id: 'q2', status: 'pending' }),
            task({ id: 'r2', status: 'running' }),
        ];
        expect(orderForDisplay(items).map((i) => i.id)).toEqual(['r1', 'r2', 'q1', 'q2']);
    });
});

describe('agentsForCollapsedView', () => {
    const agent = (id: string, done: boolean) => ({ agentId: id, label: id, done });

    it('shows the agents still working, not the first four launched', () => {
        // Launch order would show four checkmarks and none of the live agents.
        const agents = [
            agent('d1', true), agent('d2', true), agent('d3', true), agent('d4', true),
            agent('r1', false), agent('r2', false),
        ];
        expect(agentsForCollapsedView(agents, 4).map((a) => a.agentId)).toEqual(['r1', 'r2', 'd3', 'd4']);
    });

    it('fills from the most recently finished, not the oldest', () => {
        const agents = [agent('d1', true), agent('d2', true), agent('d3', true)];
        expect(agentsForCollapsedView(agents, 2).map((a) => a.agentId)).toEqual(['d2', 'd3']);
    });

    it('never shows more than the limit when everything is running', () => {
        const agents = Array.from({ length: 20 }, (_, i) => agent(`r${i}`, false));
        expect(agentsForCollapsedView(agents, 4)).toHaveLength(4);
    });

    it('handles a workflow that has launched nothing yet', () => {
        expect(agentsForCollapsedView([], 4)).toEqual([]);
    });
});
