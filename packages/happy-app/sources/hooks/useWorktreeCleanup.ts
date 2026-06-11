/**
 * Worktree cleanup logic shared by archive and delete flows.
 *
 * Callers run this after they have told the session to stop. When the session
 * lives inside a worktree, it decides whether to offer the user the option to
 * delete the worktree:
 *
 * 1. If other active sessions still reference the same worktree → skip silently.
 * 2. If git status has uncommitted changes → skip silently.
 * 3. Otherwise → show a confirmation dialog ("Delete worktree" / "Keep files").
 *
 * The prompt only appears when: no other active sessions AND git is clean.
 *
 * The order is load-bearing: the session stops first (killSession, so its CLI
 * stamps the session archived and exits), then whatever else is still running
 * in the worktree is stopped, then the directory goes. Removing the worktree
 * first SIGTERMs the session's own CLI, and a SIGTERM'd CLI exits without
 * stamping `archived`.
 */

import { storage } from '@/sync/storage';
import { machineBash } from '@/sync/ops';
import { isWorktreePath, removeWorktree } from '@/utils/worktree';
import { Modal } from '@/modal';
import { t } from '@/text';

const SESSION_STOP_WAIT_MS = 5000;
const SESSION_STOP_POLL_MS = 200;

/**
 * Wait until the session is no longer active, or until the timeout. Removing
 * the worktree stops every process still inside it, so starting while the CLI
 * is still shutting down would cut that shutdown short before it has stamped
 * the session archived.
 */
async function waitForSessionToStop(sessionId: string): Promise<void> {
    const deadline = Date.now() + SESSION_STOP_WAIT_MS;
    while (Date.now() < deadline) {
        if (!storage.getState().sessions[sessionId]?.active) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, SESSION_STOP_POLL_MS));
    }
}

/**
 * Check whether any *other* active session shares the same worktree path,
 * then optionally prompt the user to delete the worktree.
 *
 * Returns after the worktree has been removed or the user chose to keep it.
 * Never throws: it runs after the archive or delete already went through, so
 * a problem here must not be reported as a failed archive.
 */
export async function maybeCleanupWorktree(
    sessionId: string,
    sessionPath: string | undefined,
    machineId: string | undefined,
): Promise<void> {
    if (!sessionPath || !machineId || !isWorktreePath(sessionPath)) {
        return;
    }

    try {
        // 1. Check if other active sessions use the same worktree
        const allSessions = storage.getState().getActiveSessions();
        const otherOnSameWorktree = allSessions.some(
            s => s.id !== sessionId && s.metadata?.path === sessionPath,
        );
        if (otherOnSameWorktree) {
            return;
        }

        // 2. Check git status for uncommitted changes
        const statusResult = await machineBash(
            machineId,
            'git status --porcelain',
            sessionPath,
        );
        if (!statusResult.success || statusResult.stdout.trim().length > 0) {
            // Either git failed (not a repo / machine offline) or there are changes → skip
            return;
        }

        // 3. Git is clean, no other sessions → ask the user
        const shouldDelete = await Modal.confirm(
            t('sessionInfo.worktreeCleanupTitle'),
            t('sessionInfo.worktreeCleanupMessage'),
            {
                confirmText: t('sessionInfo.worktreeCleanupDelete'),
                cancelText: t('sessionInfo.worktreeCleanupKeep'),
                destructive: true,
            },
        );

        if (shouldDelete) {
            await waitForSessionToStop(sessionId);
            await removeWorktree(machineId, sessionPath);
        }
    } catch {
        // Best-effort, see above.
    }
}
