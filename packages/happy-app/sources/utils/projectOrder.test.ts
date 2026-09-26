import { describe, expect, it } from 'vitest';
import { buildPathProjectGroups } from '@/sync/projectGroups';
import type { Session } from '@/sync/storageTypes';
import type { SessionRowData } from '@/sync/storage';
import {
    PROJECT_ORDER_LIMIT,
    compareProjectRank,
    createProjectRank,
    legacyStarredProjectIds,
    mergeProjectOrder,
    moveProjectId,
    readLegacyStarredKeys,
    unrankedProjects,
} from './projectOrder';

function sortByRank(ids: string[], rank: (id: string) => number): string[] {
    return [...ids].sort((a, b) => compareProjectRank(rank(a), rank(b)) || a.localeCompare(b));
}

// Only what buildPathProjectGroups reads to key a card.
function pathSession(id: string, machineId: string, path: string): Session {
    return { id, metadata: { machineId, path } } as unknown as Session;
}

describe('createProjectRank', () => {
    it('ranks stored cards by position and puts the rest after them', () => {
        const rank = createProjectRank(['c', 'a']);

        expect(sortByRank(['a', 'b', 'c', 'd'], rank)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('uses the first position of an id stored twice', () => {
        const rank = createProjectRank(['b', 'a', 'b']);

        expect(rank('b')).toBe(0);
        expect(rank('a')).toBe(1);
    });

    it('leaves every card unranked when nothing is stored', () => {
        const rank = createProjectRank([]);

        expect(rank('anything')).toBe(unrankedProjects('anything'));
        expect(compareProjectRank(rank('a'), rank('b'))).toBe(0);
    });

    it('keeps the retired stars on top until an order is stored', () => {
        const starredCard = `happy:${JSON.stringify(['m1', '/repo/zulu'])}`;
        const otherCard = `happy:${JSON.stringify(['m1', '/repo/alpha'])}`;

        const beforeAnyOrder = createProjectRank([], ['m1:/repo/zulu']);
        expect(sortByRank([otherCard, starredCard], beforeAnyOrder)).toEqual([starredCard, otherCard]);

        // Once the user has arranged the cards, the stars no longer count.
        const afterOrder = createProjectRank([otherCard, starredCard], ['m1:/repo/zulu']);
        expect(sortByRank([otherCard, starredCard], afterOrder)).toEqual([otherCard, starredCard]);
    });
});

describe('legacyStarredProjectIds', () => {
    it('names the card buildPathProjectGroups gives the starred checkout, in both sections', () => {
        const [happyCard] = buildPathProjectGroups(
            [pathSession('s1', 'machine-1', '/Users/me/repo')],
            (session) => ({ id: session.id }) as SessionRowData,
            () => true,
            'happy',
        );
        const [rigCard] = buildPathProjectGroups(
            [pathSession('s2', 'machine-1', '/Users/me/repo')],
            (session) => ({ id: session.id }) as SessionRowData,
            () => true,
            'rig',
        );

        const ids = legacyStarredProjectIds(['machine-1:/Users/me/repo']);

        expect(ids.has(happyCard.id)).toBe(true);
        expect(ids.has(rigCard.id)).toBe(true);
    });

    it('splits on the first colon, so a path may contain one', () => {
        const ids = legacyStarredProjectIds(['m1:C:/work/repo']);

        expect(ids.has(`happy:${JSON.stringify(['m1', 'C:/work/repo'])}`)).toBe(true);
    });

    it('ignores keys with no machine', () => {
        expect(legacyStarredProjectIds([':/repo', 'no-separator']).size).toBe(0);
    });
});

describe('readLegacyStarredKeys', () => {
    it('reads the star list the settings blob still carries', () => {
        expect(readLegacyStarredKeys({ starredProjects: ['m1:/a', 7, 'm1:/b'] })).toEqual(['m1:/a', 'm1:/b']);
    });

    it('returns nothing when the field is missing or malformed', () => {
        expect(readLegacyStarredKeys({})).toEqual([]);
        expect(readLegacyStarredKeys({ starredProjects: 'm1:/a' })).toEqual([]);
    });
});

describe('mergeProjectOrder', () => {
    it('stores every card on screen in the order shown', () => {
        expect(mergeProjectOrder([], ['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
        expect(mergeProjectOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
    });

    it('keeps a hidden card in its slot so it comes back where it was', () => {
        // `h` is a project whose sessions are all archived right now.
        const next = mergeProjectOrder(['a', 'h', 'b'], ['b', 'a']);

        expect(next).toEqual(['b', 'h', 'a']);
    });

    it('appends cards that were never stored after the ones that were', () => {
        expect(mergeProjectOrder(['a', 'b'], ['a', 'b', 'new'])).toEqual(['a', 'b', 'new']);
        expect(mergeProjectOrder(['a', 'b'], ['new', 'a', 'b'])).toEqual(['new', 'a', 'b']);
    });

    it('keeps each machine\'s relative order when several machines share the list', () => {
        // a* live on one machine, b* on another; only a1 and a2 swapped.
        const next = mergeProjectOrder(['a1', 'b1', 'a2', 'b2'], ['a2', 'a1', 'b1', 'b2']);
        const rank = createProjectRank(next);

        expect(sortByRank(['a1', 'a2'], rank)).toEqual(['a2', 'a1']);
        expect(sortByRank(['b1', 'b2'], rank)).toEqual(['b1', 'b2']);
    });

    it('drops duplicate ids', () => {
        expect(mergeProjectOrder(['a', 'a', 'h', 'h'], ['a', 'a'])).toEqual(['a', 'h']);
    });

    it('trims hidden cards from the end once over the cap, never a card on screen', () => {
        const hidden = Array.from({ length: PROJECT_ORDER_LIMIT }, (_, index) => `h${index}`);
        const next = mergeProjectOrder([...hidden, 'a'], ['a', 'b']);

        expect(next).toHaveLength(PROJECT_ORDER_LIMIT);
        expect(next).toContain('a');
        expect(next).toContain('b');
        expect(next[0]).toBe('h0');
        expect(next).not.toContain(`h${PROJECT_ORDER_LIMIT - 1}`);
    });
});

describe('moveProjectId', () => {
    it('moves an id down and up, shifting the ones between', () => {
        expect(moveProjectId(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
        expect(moveProjectId(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    });

    it('clamps the target and ignores an index out of range', () => {
        expect(moveProjectId(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
        expect(moveProjectId(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    });
});
