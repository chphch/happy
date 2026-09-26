import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import {
    createProjectRank,
    mergeProjectOrder,
    readLegacyStarredKeys,
    type ProjectRank,
} from '@/utils/projectOrder';

const NO_ORDER: readonly string[] = [];

/**
 * The order the user arranged the home list's project cards in, as the rank
 * the list builders sort by.
 *
 * Read here rather than while the list data is built: the order is a synced
 * setting, and a settings change does not rebuild the cached list data, so a
 * list that took the order at build time would leave a moved card where it was
 * until something unrelated rebuilt it. Every view that lays out project cards
 * (both home lists, the keyboard shortcut numbers, the reorder editor) reads
 * this one hook, so they always agree.
 */
export function useProjectRank(): ProjectRank {
    const order = storage(useShallow((state) => state.settings.projectOrder ?? NO_ORDER));
    // The retired star list still rides in the settings blob; it only matters
    // until the first arrangement is stored (see createProjectRank).
    const legacyStarred = storage(useShallow((state) => readLegacyStarredKeys(state.settings)));
    return React.useMemo(() => createProjectRank(order, legacyStarred), [order, legacyStarred]);
}

/**
 * Stores the order the reorder editor shows — every card on screen, in order.
 * It goes through the same settings path as any other setting (local apply,
 * then push), so the other devices get it with the next settings update.
 */
export function saveProjectOrder(visibleInOrder: readonly string[]): void {
    const previous = storage.getState().settings.projectOrder ?? NO_ORDER;
    const next = mergeProjectOrder(previous, visibleInOrder);
    const unchanged = next.length === previous.length
        && next.every((id, index) => id === previous[index]);
    if (unchanged) return;
    sync.applySettings({ projectOrder: next });
}
