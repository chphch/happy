/**
 * The order the user gave the project cards on the home list.
 *
 * Stored as `settings.projectOrder`: project card ids (`ProjectGroupData.id`)
 * in the order the user arranged them. Cards it names come first, in that
 * order; cards it does not name — projects that appeared since — follow by
 * name. A card never leaves its machine's group, so only the order among one
 * machine's cards is ever visible, and one flat list serves every machine.
 *
 * Kept free of React and the store so the list builders and their tests can
 * import it directly.
 */

/** Where a card sorts: lower first. Unranked cards share `Infinity`. */
export type ProjectRank = (projectId: string) => number;

const UNRANKED = Number.POSITIVE_INFINITY;

export const unrankedProjects: ProjectRank = () => UNRANKED;

/** Orders two ranks; two unranked cards compare equal and fall to the name. */
export function compareProjectRank(a: number, b: number): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/**
 * How many ids the setting keeps. It lives in the synced settings blob, which
 * is re-encrypted and uploaded on every settings change, so ids of projects
 * long gone must not pile up forever.
 */
export const PROJECT_ORDER_LIMIT = 200;

export function createProjectRank(
    order: readonly string[],
    legacyStarredKeys: readonly string[] = [],
): ProjectRank {
    if (order.length > 0) {
        const index = new Map<string, number>();
        order.forEach((id, position) => {
            if (!index.has(id)) index.set(id, position);
        });
        return (id) => index.get(id) ?? UNRANKED;
    }
    // Nothing arranged yet: keep what the retired star feature showed, so the
    // switch does not reshuffle the list. The first arrangement writes every
    // card, and from then on the stars are not read again.
    const starred = legacyStarredProjectIds(legacyStarredKeys);
    if (starred.size === 0) return unrankedProjects;
    return (id) => (starred.has(id) ? 0 : UNRANKED);
}

/**
 * The card ids the retired star feature pinned to the top.
 *
 * Stars were stored as `${machineId}:${repoPath}`. A path-grouped card's id is
 * `${source}:${JSON.stringify([machineId, repoPath])}` (`buildPathProjectGroups`),
 * where the source is `happy` for Happy CLI sessions and `rig` for Happy Agent
 * sessions grouped by path — so each star names one card in either section.
 * Machine ids carry no colon, so the first one splits the key.
 */
export function legacyStarredProjectIds(keys: readonly string[]): Set<string> {
    const ids = new Set<string>();
    for (const key of keys) {
        const separator = key.indexOf(':');
        if (separator <= 0) continue;
        const tail = JSON.stringify([key.slice(0, separator), key.slice(separator + 1)]);
        ids.add(`happy:${tail}`);
        ids.add(`rig:${tail}`);
    }
    return ids;
}

/**
 * The retired star list. It is no longer part of the settings schema, but
 * `settingsParse` keeps fields it does not know, so the blob still carries it.
 */
export function readLegacyStarredKeys(settings: object): string[] {
    const raw = (settings as Record<string, unknown>).starredProjects;
    if (!Array.isArray(raw)) return [];
    return raw.filter((key): key is string => typeof key === 'string');
}

/**
 * The stored order once the editor shows `visible` — every card on screen, in
 * the order it now shows them.
 *
 * Every visible card is written, so a card is ranked from the moment the user
 * has seen it placed and a new project does not jump around later. Ids of cards
 * that are not on screen (a project whose sessions are all archived) keep their
 * slots, so a project that comes back returns to where it was instead of to
 * the end.
 */
export function mergeProjectOrder(
    previous: readonly string[],
    visible: readonly string[],
    limit: number = PROJECT_ORDER_LIMIT,
): string[] {
    const placed = dedupe(visible);
    const onScreen = new Set(placed);

    // A slot per id already stored: hidden ids stay put, visible ones become
    // blanks the new order is poured into.
    const slots = dedupe(previous).map((id) => (onScreen.has(id) ? null : id));
    let next = 0;
    const merged = slots.map((id) => id ?? placed[next++]);
    // Cards that were never stored follow, in the order they are shown.
    merged.push(...placed.slice(next));

    // Over the cap: drop hidden ids from the end — the lowest-ranked, and none
    // of them anything the user is looking at.
    for (let index = merged.length - 1; merged.length > limit && index >= 0; index--) {
        if (!onScreen.has(merged[index])) merged.splice(index, 1);
    }
    return merged;
}

/** `ids` with the entry at `from` moved to `to`, everything between shifting. */
export function moveProjectId(ids: readonly string[], from: number, to: number): string[] {
    const result = [...ids];
    if (from < 0 || from >= result.length) return result;
    const [moved] = result.splice(from, 1);
    result.splice(Math.max(0, Math.min(to, result.length)), 0, moved);
    return result;
}

function dedupe(ids: readonly string[]): string[] {
    return Array.from(new Set(ids));
}
