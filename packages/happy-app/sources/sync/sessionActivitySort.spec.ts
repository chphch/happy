import { describe, it, expect } from 'vitest';
import { sessionActivitySortKey } from './sessionActivitySort';

// Regression guard for the "sort by activity" ordering decision.
//
// Priority: lastTurnCompletedAt > lastMessageAt > updatedAt.
// - lastTurnCompletedAt (bumps once at turn END) is preferred so a session lifts
//   only when its turn finishes, NOT on every mid-turn streamed message.
// - lastMessageAt is the fallback across a fresh app start (turn-completion is
//   live-only), and only then updatedAt.
// Do NOT "simplify" to plain updatedAt: metadata writes (read-position/star/mode)
// bump Session.updatedAt, which would re-order a just-viewed session to the top.
describe('sessionActivitySortKey', () => {
    it('prefers lastTurnCompletedAt, ignoring a newer lastMessageAt (mid-turn message)', () => {
        // Turn finished at 100; a later message (200) arrived mid the NEXT turn —
        // the key must stay at the completion time so the session doesn't jump
        // while it's working.
        expect(sessionActivitySortKey({ lastTurnCompletedAt: 100, lastMessageAt: 200, updatedAt: 200 })).toBe(100);
    });

    it('falls back to lastMessageAt when no turn has completed yet (e.g. after restart)', () => {
        expect(sessionActivitySortKey({ lastTurnCompletedAt: undefined, lastMessageAt: 150, updatedAt: 999 })).toBe(150);
    });

    it('falls back to updatedAt when neither turn-completion nor message is tracked', () => {
        expect(sessionActivitySortKey({ lastMessageAt: undefined, updatedAt: 500 })).toBe(500);
    });

    it('does not lift a session that is mid-turn (message newer than its last completion)', () => {
        const working = { lastTurnCompletedAt: 100, lastMessageAt: 300, updatedAt: 300 }; // streaming now
        const justFinished = { lastTurnCompletedAt: 200, lastMessageAt: 200, updatedAt: 200 };
        const ordered = [working, justFinished].sort(
            (a, b) => sessionActivitySortKey(b) - sessionActivitySortKey(a),
        );
        // justFinished (completed at 200) outranks working (completed at 100),
        // even though working has a newer message (300).
        expect(ordered[0]).toBe(justFinished);
    });

    it('lifts a session the moment its turn completes', () => {
        const other = { lastTurnCompletedAt: 200, lastMessageAt: 200, updatedAt: 200 };
        const beforeComplete = { lastTurnCompletedAt: 100, lastMessageAt: 150, updatedAt: 150 };
        expect(
            [other, beforeComplete].sort((a, b) => sessionActivitySortKey(b) - sessionActivitySortKey(a))[0],
        ).toBe(other);
        // turn completes at 300 → now outranks `other`.
        const afterComplete = { ...beforeComplete, lastTurnCompletedAt: 300 };
        expect(
            [other, afterComplete].sort((a, b) => sessionActivitySortKey(b) - sessionActivitySortKey(a))[0],
        ).toBe(afterComplete);
    });
});
