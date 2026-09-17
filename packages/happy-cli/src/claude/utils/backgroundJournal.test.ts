import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    collectProgress,
    findWorkflowRunDir,
    readSubagentSnapshot,
    readWorkflowJournal,
    sessionDirForTranscript,
} from './backgroundJournal';
import type { BackgroundTaskSummary } from './backgroundActivity';

let root: string;
let sessionDir: string;

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const assistantTurn = (text: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bgjournal-'));
    sessionDir = join(root, 'session-abc');
    await mkdir(join(sessionDir, 'subagents', 'workflows'), { recursive: true });
    await mkdir(join(sessionDir, 'workflows', 'scripts'), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('sessionDirForTranscript', () => {
    it('drops the .jsonl to name the session directory', () => {
        expect(sessionDirForTranscript('/p/-enc/abc.jsonl')).toBe('/p/-enc/abc');
    });

    it('refuses anything that is not a transcript', () => {
        expect(sessionDirForTranscript(undefined)).toBeNull();
        expect(sessionDirForTranscript('/p/-enc/abc')).toBeNull();
    });
});

describe('findWorkflowRunDir', () => {
    it('recovers the run id from the script filename', async () => {
        await writeFile(join(sessionDir, 'workflows', 'scripts', 'my-flow-wf_1111111-aaa.js'), '//');
        await expect(findWorkflowRunDir(sessionDir, 'my-flow'))
            .resolves.toBe(join(sessionDir, 'subagents', 'workflows', 'wf_1111111-aaa'));
    });

    it('picks the newest when a name has been run more than once', async () => {
        const scripts = join(sessionDir, 'workflows', 'scripts');
        await writeFile(join(scripts, 'my-flow-wf_old.js'), '//');
        await new Promise((resolve) => setTimeout(resolve, 12));
        await writeFile(join(scripts, 'my-flow-wf_new.js'), '//');
        await expect(findWorkflowRunDir(sessionDir, 'my-flow'))
            .resolves.toBe(join(sessionDir, 'subagents', 'workflows', 'wf_new'));
    });

    it('does not match a different workflow whose name shares a prefix', async () => {
        await writeFile(join(sessionDir, 'workflows', 'scripts', 'my-flow-extra-wf_x.js'), '//');
        await expect(findWorkflowRunDir(sessionDir, 'my-flow-ext')).resolves.toBeNull();
    });

    it('returns null rather than throwing when nothing is on disk', async () => {
        await expect(findWorkflowRunDir(sessionDir, 'absent')).resolves.toBeNull();
        await expect(findWorkflowRunDir('/nope/nowhere', 'absent')).resolves.toBeNull();
    });
});

describe('readWorkflowJournal', () => {
    const writeJournal = async (runId: string, records: unknown[]) => {
        const dir = join(sessionDir, 'subagents', 'workflows', runId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'journal.jsonl'), jsonl(records));
        return dir;
    };

    it('counts started against result, keeping launch order', async () => {
        const dir = await writeJournal('wf_a', [
            { type: 'launched' },
            { type: 'started', agentId: 'a1', label: 'investigate:consumers', phase: 'Investigate' },
            { type: 'started', agentId: 'a2', label: 'investigate:fx', phase: 'Investigate' },
            { type: 'result', agentId: 'a1', result: { findings: [] } },
        ]);
        const journal = await readWorkflowJournal(dir);
        expect(journal?.agents.map((a) => [a.agentId, a.label, a.done]))
            .toEqual([['a1', 'investigate:consumers', true], ['a2', 'investigate:fx', false]]);
    });

    it('still counts a result whose started record fell outside the window', async () => {
        // The tail read can cut the start off a very long journal; the finished
        // unit must not vanish from the denominator because of that.
        const dir = await writeJournal('wf_b', [{ type: 'result', agentId: 'orphan' }]);
        const journal = await readWorkflowJournal(dir);
        expect(journal?.agents).toEqual([{ agentId: 'orphan', label: 'orphan', done: true }]);
    });

    it('ignores a half-written trailing line', async () => {
        const dir = join(sessionDir, 'subagents', 'workflows', 'wf_c');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'journal.jsonl'),
            jsonl([{ type: 'started', agentId: 'a1', label: 'x' }]) + '{"type":"resu');
        const journal = await readWorkflowJournal(dir);
        expect(journal?.agents).toHaveLength(1);
    });

    it('returns null when there is no journal', async () => {
        await expect(readWorkflowJournal(join(sessionDir, 'subagents', 'workflows', 'missing')))
            .resolves.toBeNull();
    });
});

describe('readSubagentSnapshot', () => {
    const writeAgent = async (agentId: string, meta: unknown, records?: unknown[]) => {
        const dir = join(sessionDir, 'subagents');
        await writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
        if (records) await writeFile(join(dir, `agent-${agentId}.jsonl`), jsonl(records));
    };

    it('reports the agent type and its newest sentence', async () => {
        await writeAgent('a1', { agentType: 'general-purpose', description: 'Full-read batch 1' }, [
            assistantTurn('first'),
            { type: 'user', message: { role: 'user', content: [] } },
            assistantTurn('second'),
        ]);
        const snapshot = await readSubagentSnapshot(sessionDir, 'a1');
        expect(snapshot).toMatchObject({
            agentType: 'general-purpose',
            description: 'Full-read batch 1',
            turns: 2,
            latestText: 'second',
        });
    });

    it('returns the meta alone when the agent has not written a transcript', async () => {
        await writeAgent('a2', { agentType: 'Explore', description: 'Look around' });
        expect(await readSubagentSnapshot(sessionDir, 'a2'))
            .toEqual({ agentType: 'Explore', description: 'Look around', turns: 0 });
    });

    it('finds a transcript that lives inside a workflow run directory', async () => {
        const runDir = join(sessionDir, 'subagents', 'workflows', 'wf_d');
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, 'agent-a3.jsonl'), jsonl([assistantTurn('inside a workflow')]));
        const snapshot = await readSubagentSnapshot(sessionDir, 'a3', [runDir]);
        expect(snapshot?.latestText).toBe('inside a workflow');
    });

    it('parses cleanly when the transcript is larger than the tail window', async () => {
        // Only the tail is read, so the cut lands mid-line — the first fragment
        // must be dropped rather than counted as a malformed record.
        const filler = Array.from({ length: 4000 }, (_, i) => assistantTurn(`turn ${i} ${'x'.repeat(200)}`));
        await writeFile(join(sessionDir, 'subagents', 'agent-a4.jsonl'), jsonl([...filler, assistantTurn('the last word')]));
        const snapshot = await readSubagentSnapshot(sessionDir, 'a4');
        expect(snapshot?.latestText).toBe('the last word');
        expect(snapshot!.turns).toBeGreaterThan(0);
        expect(snapshot!.turns).toBeLessThan(filler.length);
    });

    it('returns null when the agent is unknown', async () => {
        await expect(readSubagentSnapshot(sessionDir, 'nope')).resolves.toBeNull();
    });
});

describe('collectProgress', () => {
    const task = (over: Partial<BackgroundTaskSummary>): BackgroundTaskSummary =>
        ({ id: 'x', type: 'shell', status: 'running', ...over });

    it('carries the on-disk description so an unnamed agent still has a name', async () => {
        await writeFile(join(sessionDir, 'subagents', 'agent-sub9.meta.json'),
            JSON.stringify({ agentType: 'general-purpose', description: 'G8 net-new: Korean large corps' }));
        const progress = await collectProgress(`${sessionDir}.jsonl`, [task({ id: 'sub9', type: 'subagent' })]);
        expect(progress.get('sub9')?.description).toBe('G8 net-new: Korean large corps');
    });

    it('maps workflow and subagent tasks to progress, and leaves shells alone', async () => {
        await writeFile(join(sessionDir, 'workflows', 'scripts', 'flow-wf_e.js'), '//');
        const runDir = join(sessionDir, 'subagents', 'workflows', 'wf_e');
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, 'journal.jsonl'), jsonl([
            { type: 'started', agentId: 'g1', label: 'probe', phase: 'Investigate' },
            { type: 'started', agentId: 'g2', label: 'verify', phase: 'Verify' },
            { type: 'result', agentId: 'g1' },
        ]));
        await writeFile(join(sessionDir, 'subagents', 'agent-sub1.jsonl'), jsonl([assistantTurn('working')]));

        const progress = await collectProgress(`${sessionDir}.jsonl`, [
            task({ id: 'w1', type: 'workflow', name: 'flow' }),
            task({ id: 'sub1', type: 'subagent' }),
            task({ id: 'sh1', type: 'shell', command: 'pnpm build' }),
        ]);

        expect(progress.get('w1')!.progress).toMatchObject({ done: 1, total: 2, phase: 'Verify', latest: 'verify' });
        expect(progress.get('sub1')!.progress).toMatchObject({ done: 1, latest: 'working' });
        expect(progress.has('sh1')).toBe(false);
    });

    it('is empty rather than throwing when the transcript path is unusable', async () => {
        await expect(collectProgress(undefined, [task({ type: 'workflow', name: 'flow' })]))
            .resolves.toEqual(new Map());
        await expect(collectProgress('/nowhere/x.jsonl', [task({ type: 'workflow', name: 'flow' })]))
            .resolves.toEqual(new Map());
    });
});
