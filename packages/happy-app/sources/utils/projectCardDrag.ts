/**
 * The arithmetic behind dragging a project card within the home list.
 *
 * While a card is held, the list keeps its data order untouched: the held card
 * shrinks to nothing where it was, and an empty slot of its height opens
 * before one of the other cards of its machine group. These functions work
 * out where that slot goes and what order the group has once the card lands.
 * Everything is in content coordinates (the list's scroll content, not the
 * screen), and "cards" means the group's other cards in their shown order.
 *
 * Kept free of React so the maths can be tested on its own.
 */

/**
 * Where the group starts in the content, given where the held card starts and
 * the heights of the cards shown above it in the same group.
 */
export function groupTopFromCard(cardTop: number, heightsAbove: readonly number[]): number {
    return heightsAbove.reduce((top, height) => top - height, cardTop);
}

/** Tops of the other cards with the held card taken out and no slot open. */
export function packedTops(groupTop: number, heights: readonly number[]): number[] {
    const tops: number[] = [];
    let top = groupTop;
    for (const height of heights) {
        tops.push(top);
        top += height;
    }
    return tops;
}

/** Top of the open slot when it sits before card `gap` (or after the last). */
export function slotTop(groupTop: number, heights: readonly number[], gap: number): number {
    let top = groupTop;
    for (let index = 0; index < gap && index < heights.length; index++) top += heights[index];
    return top;
}

/**
 * Moves the slot toward the held card, one neighbour at a time, flipping at
 * each neighbour's midpoint — so it lands where dragging card by card would
 * put it, and does not flicker between two positions near a boundary.
 *
 * `center` is the held card's vertical centre. A neighbour above the slot is
 * passed once the centre rises above that neighbour's middle; one below the
 * slot sits `slotHeight` lower than it would packed, and is passed once the
 * centre sinks below its (shifted) middle.
 */
export function nextGapIndex(
    groupTop: number,
    heights: readonly number[],
    gap: number,
    slotHeight: number,
    center: number,
): number {
    const tops = packedTops(groupTop, heights);
    let next = Math.max(0, Math.min(gap, heights.length));
    while (next > 0 && center < tops[next - 1] + heights[next - 1] / 2) next--;
    while (next < heights.length && center > tops[next] + slotHeight + heights[next] / 2) next++;
    return next;
}

/** The group's ids once the held card lands in the slot before card `gap`. */
export function orderWithDrop(otherIds: readonly string[], heldId: string, gap: number): string[] {
    const order = otherIds.filter((id) => id !== heldId);
    order.splice(Math.max(0, Math.min(gap, order.length)), 0, heldId);
    return order;
}

/**
 * How fast the list should scroll by itself, in points per second (negative
 * is up), for a finger at `fingerY` in a viewport whose usable part runs from
 * `viewTop` to `viewBottom`. It picks up inside `edge` of either end and
 * reaches `maxSpeed` at the very end.
 */
export function autoScrollSpeed(
    fingerY: number,
    viewTop: number,
    viewBottom: number,
    edge: number,
    maxSpeed: number,
): number {
    if (viewBottom - viewTop < edge * 2) return 0;
    if (fingerY < viewTop + edge) {
        return -maxSpeed * Math.min(1, (viewTop + edge - fingerY) / edge);
    }
    if (fingerY > viewBottom - edge) {
        return maxSpeed * Math.min(1, (fingerY - (viewBottom - edge)) / edge);
    }
    return 0;
}
