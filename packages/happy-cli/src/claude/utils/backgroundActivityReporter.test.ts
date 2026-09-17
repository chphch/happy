import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundActivityReporter } from './backgroundActivityReporter';
import type { BackgroundTaskSummary } from './backgroundActivity';

let root: string;
let sessionDir: string;
let transcriptPath: string;

const shell = (id: string): BackgroundTaskSummary =>
    ({ id, type: 'shell', status: 'running', description: `Run ${id}`, command: `echo ${id}` });

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bgreporter-'));
    sessionDir = join(root, 'session-abc');
    transcriptPath = `${sessionDir}.jsonl`;
    await mkdir(join(sessionDir, 'subagents', 'workflows'), { recursive: true });
    await mkdir(join(sessionDir, 'workflows', 'scripts'), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('onTasks', () => {
    it('publishes counts and items on the first report', async () => {
        const activity = await new BackgroundActivityReporter().onTasks([shell('b1')], transcriptPath);
        expect(activity).toMatchObject({ processes: { running: 1 } });
        expect(activity?.items?.map((i) => i.title)).toEqual(['Run b1']);
    });

    it('returns null for an unchanged report so metadata is not rewritten', async () => {
        // Metadata is read-modify-write under optimistic concurrency, so an
        // idle turn re-sending the same summary is pure churn.
        const reporter = new BackgroundActivityReporter();
        await reporter.onTasks([shell('b1')], transcriptPath);
        await expect(reporter.onTasks([shell('b1')], transcriptPath)).resolves.toBeNull();
    });

    it('returns undefined — not an all-zero object — once nothing is running', async () => {
        const reporter = new BackgroundActivityReporter();
        await reporter.onTasks([shell('b1')], transcriptPath);
        await expect(reporter.onTasks([], transcriptPath)).resolves.toBeUndefined();
    });

    it('keeps a task first-seen time stable across reports', async () => {
        const reporter = new BackgroundActivityReporter();
        const first = await reporter.onTasks([shell('b1')], transcriptPath);
        const started = first?.items?.[0]?.startedAt;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await reporter.onTasks([shell('b1'), shell('b2')], transcriptPath);
        expect(second?.items?.find((i) => i.id === 'b1')?.startedAt).toBe(started);
        expect(second?.items?.find((i) => i.id === 'b2')?.startedAt).toBeGreaterThanOrEqual(started!);
    });

    it('forgets an id once its task is gone, so a reused id is not back-dated', async () => {
        const reporter = new BackgroundActivityReporter();
        const first = await reporter.onTasks([shell('b1')], transcriptPath);
        await reporter.onTasks([], transcriptPath);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const again = await reporter.onTasks([shell('b1')], transcriptPath);
        expect(again?.items?.[0]?.startedAt).toBeGreaterThan(first!.items![0]!.startedAt!);
    });

    it('still reports counts when the transcript path is unusable', async () => {
        // Progress is a nicety; losing it must not lose the indicator itself.
        const activity = await new BackgroundActivityReporter().onTasks([shell('b1')], undefined);
        expect(activity).toMatchObject({ processes: { running: 1 } });
        expect(activity?.items?.[0]?.progress).toBeUndefined();
    });
});

describe('detail', () => {
    it('is empty before any Stop hook has reported a list', async () => {
        await expect(new BackgroundActivityReporter().detail()).resolves.toEqual({ listedAt: 0, items: [] });
    });

    it('serves a shell command in full, with no note of its own', async () => {
        const reporter = new BackgroundActivityReporter();
        const command = 'pnpm build && ' + 'x'.repeat(4000);
        await reporter.onTasks([{ id: 'b1', type: 'shell', status: 'running', description: 'Build', command }], transcriptPath);
        const { items } = await reporter.detail();
        expect(items[0]!.detail).toBe(command);
        // The "output is not readable from here" line is the app's to render:
        // it is constant per kind, so it must survive the session being offline.
        expect(items[0]!.note).toBeUndefined();
    });

    it('expands a workflow into its sub-agent list, re-read at call time', async () => {
        await writeFile(join(sessionDir, 'workflows', 'scripts', 'flow-wf_z.js'), '//');
        const runDir = join(sessionDir, 'subagents', 'workflows', 'wf_z');
        await mkdir(runDir, { recursive: true });
        const journal = join(runDir, 'journal.jsonl');
        await writeFile(journal, JSON.stringify({ type: 'started', agentId: 'g1', label: 'probe', phase: 'Investigate' }) + '\n');

        const reporter = new BackgroundActivityReporter();
        await reporter.onTasks([{ id: 'w1', type: 'workflow', status: 'running', description: 'Audit', name: 'flow' }], transcriptPath);
        expect((await reporter.detail()).items[0]!.progress).toMatchObject({ done: 0, total: 1 });

        // The sheet stays open while the workflow advances — the RPC must see it.
        await writeFile(journal,
            JSON.stringify({ type: 'started', agentId: 'g1', label: 'probe', phase: 'Investigate' }) + '\n'
            + JSON.stringify({ type: 'result', agentId: 'g1' }) + '\n');
        const after = (await reporter.detail()).items[0]!;
        expect(after.progress).toMatchObject({ done: 1, total: 1 });
        expect(after.agents).toEqual([{ agentId: 'g1', label: 'probe', phase: 'Investigate', done: true }]);
    });

    it('explains a workflow that has not written its journal yet', async () => {
        const reporter = new BackgroundActivityReporter();
        await reporter.onTasks([{ id: 'w1', type: 'workflow', status: 'running', name: 'never-ran' }], transcriptPath);
        expect((await reporter.detail()).items[0]!.note).toBe('workflow-journal-missing');
    });

    it('serves a subagent its latest text and borrows its description', async () => {
        await writeFile(join(sessionDir, 'subagents', 'agent-a1.meta.json'),
            JSON.stringify({ agentType: 'general-purpose', description: 'Full-read batch 1' }));
        await writeFile(join(sessionDir, 'subagents', 'agent-a1.jsonl'),
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'halfway through' }] } }) + '\n');

        const reporter = new BackgroundActivityReporter();
        await reporter.onTasks([{ id: 'a1', type: 'subagent', status: 'running' }], transcriptPath);
        expect((await reporter.detail()).items[0]).toMatchObject({
            title: 'Full-read batch 1',
            detail: 'general-purpose',
            latestText: 'halfway through',
        });
    });
});
