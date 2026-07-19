import { describe, it, expect } from 'vitest';
import { sessionActivitySortKey } from './sessionActivitySort';

// Regression guard for the "sort by activity" ordering decision:
// merely viewing a session writes read-position metadata, which bumps
// Session.updatedAt on the server. The activity sort key must therefore key on
// lastMessageAt (real message arrivals) and only fall back to updatedAt when no
// message has been synced yet — NOT plain updatedAt, which would re-order a
// just-viewed session to the top. Do not "simplify" this back to updatedAt.
describe('sessionActivitySortKey', () => {
    it('uses lastMessageAt when present, ignoring a newer updatedAt', () => {
        // updatedAt is newer (e.g. bumped by a read-position write) but the last
        // real message is older — the key must reflect the message, not the bump.
        expect(sessionActivitySortKey({ lastMessageAt: 100, updatedAt: 999 })).toBe(100);
    });

    it('falls back to updatedAt when no message has been tracked yet', () => {
        expect(sessionActivitySortKey({ lastMessageAt: undefined, updatedAt: 500 })).toBe(500);
    });

    it('orders sessions by last message, so viewing (updatedAt bump) does not lift a session', () => {
        const viewedOld = { lastMessageAt: 100, updatedAt: 999 }; // just opened → updatedAt bumped
        const recentlyMessaged = { lastMessageAt: 200, updatedAt: 200 };
        const ordered = [viewedOld, recentlyMessaged].sort(
            (a, b) => sessionActivitySortKey(b) - sessionActivitySortKey(a),
        );
        expect(ordered[0]).toBe(recentlyMessaged);
    });
});
