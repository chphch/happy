// "Sort by activity" ordering key, kept in a dependency-free module so it can be
// unit-tested without pulling in the react-native import chain via storage.ts.
//
// The key is the newest actual message time (lastMessageAt), falling back to
// updatedAt only when no message has been synced yet. Deliberately NOT plain
// updatedAt: metadata writes (read-position/star/mode) bump Session.updatedAt,
// so keying on it made merely viewing a session jump it to the top. Do not
// "simplify" this back to updatedAt.
export function sessionActivitySortKey(s: { lastMessageAt?: number; updatedAt: number }): number {
    return s.lastMessageAt ?? s.updatedAt;
}
