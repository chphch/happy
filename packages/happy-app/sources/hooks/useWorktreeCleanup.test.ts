import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, machineBash, removeWorktree, confirm } = vi.hoisted(() => ({
    state: { sessions: {} as Record<string, { id: string; active: boolean; metadata?: { path?: string } }> },
    machineBash: vi.fn(),
    removeWorktree: vi.fn(),
    confirm: vi.fn(),
}));

vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            sessions: state.sessions,
            getActiveSessions: () => Object.values(state.sessions).filter(s => s.active),
        }),
    },
}));
vi.mock('@/sync/ops', () => ({ machineBash }));
vi.mock('@/utils/worktree', () => ({
    isWorktreePath: (path: string) => path.includes('/.dev/worktree/'),
    removeWorktree,
}));
vi.mock('@/modal', () => ({ Modal: { confirm } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { maybeCleanupWorktree } from './useWorktreeCleanup';

const PATH = '/repo/.dev/worktree/quiet-ocean';

describe('maybeCleanupWorktree', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        state.sessions = { s1: { id: 's1', active: true, metadata: { path: PATH } } };
        machineBash.mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
        removeWorktree.mockResolvedValue({ success: true });
        confirm.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('removes the worktree only after the session has gone inactive', async () => {
        const done = maybeCleanupWorktree('s1', PATH, 'm1');

        await vi.advanceTimersByTimeAsync(1000);
        expect(removeWorktree).not.toHaveBeenCalled();

        state.sessions.s1.active = false;
        await vi.advanceTimersByTimeAsync(200);
        await done;

        expect(removeWorktree).toHaveBeenCalledWith('m1', PATH);
    });

    it('stops waiting after five seconds and removes the worktree anyway', async () => {
        const done = maybeCleanupWorktree('s1', PATH, 'm1');

        await vi.advanceTimersByTimeAsync(4800);
        expect(removeWorktree).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(400);
        await done;
        expect(removeWorktree).toHaveBeenCalledTimes(1);
    });

    it('does not wait or remove when the user keeps the files', async () => {
        confirm.mockResolvedValue(false);
        await maybeCleanupWorktree('s1', PATH, 'm1');
        expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('skips the prompt while another active session uses the same worktree', async () => {
        state.sessions.s2 = { id: 's2', active: true, metadata: { path: PATH } };
        await maybeCleanupWorktree('s1', PATH, 'm1');
        expect(confirm).not.toHaveBeenCalled();
        expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('never throws, even when the machine call fails', async () => {
        machineBash.mockRejectedValue(new Error('machine offline'));
        await expect(maybeCleanupWorktree('s1', PATH, 'm1')).resolves.toBeUndefined();

        machineBash.mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
        state.sessions.s1.active = false;
        removeWorktree.mockRejectedValue(new Error('git failed'));
        await expect(maybeCleanupWorktree('s1', PATH, 'm1')).resolves.toBeUndefined();
    });
});
