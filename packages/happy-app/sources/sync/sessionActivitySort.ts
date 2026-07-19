// "Sort by activity" ordering key, kept in a dependency-free module so it can be
// unit-tested without pulling in the react-native import chain via storage.ts.
//
// The key is when the session last COMPLETED a turn (lastTurnCompletedAt),
// falling back to the newest message time (lastMessageAt), then updatedAt.
//
// Why turn-completion first: lastMessageAt bumps on every streamed message, so
// keying on it re-ordered a session on every mid-turn message — visual churn
// while the user can't yet act on the result. lastTurnCompletedAt bumps ONCE at
// turn end, so a session lifts to the top only when its turn finishes and stays
// put while it's working. lastTurnCompletedAt is live-only (set from turn-end
// events), so we fall back to lastMessageAt across a fresh app start (the last
// message of a completed turn is a good resting-position proxy) and finally to
// updatedAt. Deliberately NOT plain updatedAt: metadata writes (read-position/
// star/mode) bump Session.updatedAt, so keying on it made merely viewing a
// session jump it to the top. Do not "simplify" this back to updatedAt.
export function sessionActivitySortKey(
    s: { lastTurnCompletedAt?: number; lastMessageAt?: number; updatedAt: number },
): number {
    return s.lastTurnCompletedAt ?? s.lastMessageAt ?? s.updatedAt;
}
