import { describe, expect, it } from 'vitest';
import {
    autoScrollSpeed,
    gatedAutoScrollSpeed,
    groupTopFromCard,
    nextGapIndex,
    orderWithDrop,
    packedTops,
    slotTop,
} from './projectCardDrag';

// Three other cards, 100 tall each, packed from 1000; the held card is 60 tall.
const HEIGHTS = [100, 100, 100];
const TOP = 1000;
const HELD = 60;

describe('groupTopFromCard / packedTops / slotTop', () => {
    it('walks back from the held card to where the group starts', () => {
        expect(groupTopFromCard(1250, [100, 150])).toBe(1000);
        expect(groupTopFromCard(1000, [])).toBe(1000);
    });

    it('packs the other cards from the group top', () => {
        expect(packedTops(TOP, HEIGHTS)).toEqual([1000, 1100, 1200]);
    });

    it('puts the slot where the card it precedes would start', () => {
        expect(slotTop(TOP, HEIGHTS, 0)).toBe(1000);
        expect(slotTop(TOP, HEIGHTS, 2)).toBe(1200);
        expect(slotTop(TOP, HEIGHTS, 3)).toBe(1300);
    });
});

describe('nextGapIndex', () => {
    it('keeps the slot while the held card stays between the two midpoints', () => {
        // Slot before card 1: card 0 middle is 1050, card 1 shown at 1160..1260, middle 1210.
        expect(nextGapIndex(TOP, HEIGHTS, 1, HELD, 1051)).toBe(1);
        expect(nextGapIndex(TOP, HEIGHTS, 1, HELD, 1209)).toBe(1);
    });

    it('moves up once the centre rises above the neighbour above', () => {
        expect(nextGapIndex(TOP, HEIGHTS, 1, HELD, 1049)).toBe(0);
    });

    it('moves down once the centre sinks below the shifted neighbour below', () => {
        expect(nextGapIndex(TOP, HEIGHTS, 1, HELD, 1211)).toBe(2);
    });

    it('crosses several cards in one step when the finger jumped', () => {
        expect(nextGapIndex(TOP, HEIGHTS, 0, HELD, 5000)).toBe(3);
        expect(nextGapIndex(TOP, HEIGHTS, 3, HELD, -5000)).toBe(0);
    });

    it('clamps a slot index that no longer fits the group', () => {
        expect(nextGapIndex(TOP, [100], 5, HELD, 1000)).toBe(0);
        expect(nextGapIndex(TOP, [], 0, HELD, 1000)).toBe(0);
    });
});

describe('orderWithDrop', () => {
    it('lands the held card before the card the slot precedes', () => {
        expect(orderWithDrop(['a', 'b', 'c'], 'x', 0)).toEqual(['x', 'a', 'b', 'c']);
        expect(orderWithDrop(['a', 'b', 'c'], 'x', 2)).toEqual(['a', 'b', 'x', 'c']);
    });

    it('lands it last when the slot is after the last card', () => {
        expect(orderWithDrop(['a', 'b'], 'x', 2)).toEqual(['a', 'b', 'x']);
        expect(orderWithDrop(['a', 'b'], 'x', 9)).toEqual(['a', 'b', 'x']);
    });

    it('never duplicates the held card', () => {
        expect(orderWithDrop(['a', 'x', 'b'], 'x', 1)).toEqual(['a', 'x', 'b']);
    });
});

describe('autoScrollSpeed', () => {
    it('stays still in the middle of the viewport', () => {
        expect(autoScrollSpeed(400, 0, 800, 60, 900)).toBe(0);
    });

    it('scrolls up near the top and down near the bottom, fastest at the edge', () => {
        expect(autoScrollSpeed(30, 0, 800, 60, 900)).toBe(-450);
        expect(autoScrollSpeed(-10, 0, 800, 60, 900)).toBe(-900);
        expect(autoScrollSpeed(770, 0, 800, 60, 900)).toBe(450);
    });

    it('measures from the usable part of the viewport, under a header and above a dock', () => {
        expect(autoScrollSpeed(120, 100, 700, 60, 900)).toBe(-600);
        expect(autoScrollSpeed(690, 100, 700, 60, 900)).toBe(750);
    });

    it('does not scroll a viewport too short to hold both edges', () => {
        expect(autoScrollSpeed(10, 0, 100, 60, 900)).toBe(0);
    });
});

describe('gatedAutoScrollSpeed', () => {
    it('keeps the list still while a card lifted inside an edge band has not moved', () => {
        // The phone case: a card just above the dock, held without moving.
        expect(gatedAutoScrollSpeed(450, 0, 24)).toBe(0);
        expect(gatedAutoScrollSpeed(-450, 3, 24)).toBe(0);
    });

    it('scrolls once the finger has travelled far enough toward that edge', () => {
        expect(gatedAutoScrollSpeed(450, 24, 24)).toBe(450);
        expect(gatedAutoScrollSpeed(-450, -40, 24)).toBe(-450);
    });

    it('never scrolls toward the edge the finger is moving away from', () => {
        // Picked up by the dock and dragged up: the bottom band must not pull it back down.
        expect(gatedAutoScrollSpeed(450, -80, 24)).toBe(0);
        expect(gatedAutoScrollSpeed(-450, 80, 24)).toBe(0);
    });

    it('passes a still list through unchanged', () => {
        expect(gatedAutoScrollSpeed(0, 200, 24)).toBe(0);
    });
});
