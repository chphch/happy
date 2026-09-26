import * as React from 'react';
import {
    LayoutAnimation,
    Platform,
    View,
    type FlatList,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, type PanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { StyleSheet } from 'react-native-unistyles';
import { saveProjectOrder } from '@/hooks/useProjectOrder';
import { moveProjectId } from '@/utils/projectOrder';
import {
    autoScrollSpeed,
    gatedAutoScrollSpeed,
    groupTopFromCard,
    nextGapIndex,
    orderWithDrop,
    slotTop,
} from '@/utils/projectCardDrag';
import { hapticsLight } from './haptics';

/** How long a card header is held before it lifts. */
const LONG_PRESS_MS = 300;
/** How near the list's top or bottom a finger starts scrolling it. */
const AUTO_SCROLL_EDGE = 72;
/** Auto-scroll speed at the very edge, in points per second. */
const AUTO_SCROLL_SPEED = 900;
/**
 * How far the finger has to move toward an edge, after the card lifts, before
 * that edge scrolls the list. A card lifted inside an edge band stays put.
 */
const AUTO_SCROLL_ARM_DISTANCE = 24;
const SETTLE = { duration: 160 };
const LIFT = { duration: 120 };
/** How long a header ignores presses after a drag ends (the web fires one on release). */
const PRESS_GUARD_MS = 450;
/** A card never laid out yet (virtualized away) is assumed to be a folded header. */
const UNMEASURED_HEIGHT = 64;
const SLOT_MOVE = {
    duration: 180,
    create: { type: 'easeInEaseOut', property: 'opacity' },
    update: { type: 'easeInEaseOut' },
    delete: { type: 'easeInEaseOut', property: 'opacity' },
} as const;

/** One machine's project cards, in the order the list shows them. */
export interface ProjectCardDragGroup {
    key: string;
    ids: string[];
}

/** What a held card is doing, as the list needs it to draw. */
export interface ProjectCardDragState {
    id: string;
    groupKey: string;
    /** The group's other cards, in the order shown when the card lifted. */
    others: string[];
    /** Where the card was among `others` when it lifted. */
    from: number;
    /** Where the empty slot is among `others` now. */
    gap: number;
    /** The held card's height, which the slot copies. */
    height: number;
}

/** What a project card needs to take part in a drag. */
export interface ProjectCardDragApi {
    /** The hold-and-drag gesture a card header wraps itself in. */
    headerGesture(projectId: string, headerKey: string): PanGesture;
    registerHeader(headerKey: string, view: View | null): void;
    registerCell(projectId: string, view: View | null): void;
    reportCellHeight(projectId: string, height: number): void;
    /** Moves a card one place up or down — the screen-reader path. */
    moveBy(projectId: string, delta: number): void;
    /** True while a drag is on or just ended, so a header press is not a tap. */
    pressSuppressed(): boolean;
}

export const ProjectCardDragContext = React.createContext<ProjectCardDragApi | null>(null);

export function useProjectCardDragApi(): ProjectCardDragApi | null {
    return React.useContext(ProjectCardDragContext);
}

interface Geometry {
    /** Top of the group's first card in the scroll content. */
    groupTop: number;
    /** Heights of `others`, in order. */
    heights: number[];
    /** Where the held card started, in viewport coordinates. */
    startTop: number;
    /** Where the finger sat below the card's top. */
    grabY: number;
    /** How far the finger has moved since the card lifted. */
    translation: number;
}

/**
 * Hold a project card's header and drag it to a new place in its machine's
 * group, the way Trello cards move.
 *
 * The list's data never reorders while a card is held — its cells do not move,
 * so the view the gesture is attached to stays where it was. Instead the held
 * card shrinks to nothing in place, an empty slot of its height opens before
 * one of the other cards, and a floating copy of the card follows the finger
 * above the list. On release the copy settles into the slot and only then is
 * the order saved; that one render moves the card into the slot and removes the
 * copy, so nothing on screen jumps.
 */
export function useProjectCardDrag({ groups, topInset, bottomInset }: {
    groups: readonly ProjectCardDragGroup[];
    /** Part of the viewport top a header overlays (phone layout). */
    topInset: number;
    /** Part of the viewport bottom a dock overlays (phone layout). */
    bottomInset: number;
}) {
    const listRef = React.useRef<FlatList<any>>(null);
    const containerRef = React.useRef<View>(null);

    const groupsRef = React.useRef(groups);
    groupsRef.current = groups;
    const insetsRef = React.useRef({ top: topInset, bottom: bottomInset });
    insetsRef.current = { top: topInset, bottom: bottomInset };

    const cells = React.useRef(new Map<string, View>()).current;
    const headers = React.useRef(new Map<string, View>()).current;
    const heights = React.useRef(new Map<string, number>()).current;
    const scroll = React.useRef({ offset: 0, content: 0, viewport: 0 }).current;
    const geometry = React.useRef<Geometry | null>(null);
    const pending = React.useRef<string | null>(null);
    const lastTranslation = React.useRef(0);
    const guardUntil = React.useRef(0);

    const [state, setState] = React.useState<ProjectCardDragState | null>(null);
    const stateRef = React.useRef<ProjectCardDragState | null>(null);
    const setDragState = React.useCallback((next: ProjectCardDragState | null) => {
        stateRef.current = next;
        setState(next);
    }, []);

    // Read by the floating copy on the UI thread.
    const ghostTop = useSharedValue(0);
    const startTop = useSharedValue(0);
    const lift = useSharedValue(0);
    const following = useSharedValue(false);

    const heightOf = (id: string) => heights.get(id) ?? UNMEASURED_HEIGHT;

    const updateGap = () => {
        const drag = stateRef.current;
        const geo = geometry.current;
        if (!drag || !geo) return;
        const center = geo.startTop + geo.translation + scroll.offset + drag.height / 2;
        const gap = nextGapIndex(geo.groupTop, geo.heights, drag.gap, drag.height, center);
        if (gap === drag.gap) return;
        if (Platform.OS !== 'web') LayoutAnimation.configureNext(SLOT_MOVE);
        setDragState({ ...drag, gap });
    };

    const begin = (projectId: string, headerKey: string, touchY: number) => {
        lastTranslation.current = 0;
        if (stateRef.current || pending.current) return;
        const group = groupsRef.current.find((candidate) => candidate.ids.includes(projectId));
        // A card alone in its machine's group has nowhere to go.
        if (!group || group.ids.length < 2) return;
        const cell = cells.get(projectId);
        const header = headers.get(headerKey);
        const container = containerRef.current;
        if (!cell || !header || !container) return;

        pending.current = projectId;
        const fail = () => {
            if (pending.current === projectId) pending.current = null;
        };
        cell.measureLayout(container as any, (_cellX, cellTop, _cellWidth, cellHeight) => {
            header.measureLayout(container as any, (_headerX, headerTop) => {
                // Let go, or another card lifted, while this one was measured.
                if (pending.current !== projectId) return;
                pending.current = null;

                const index = group.ids.indexOf(projectId);
                const others = group.ids.filter((id) => id !== projectId);
                heights.set(projectId, cellHeight);
                geometry.current = {
                    groupTop: groupTopFromCard(cellTop + scroll.offset, group.ids.slice(0, index).map(heightOf)),
                    heights: others.map(heightOf),
                    startTop: cellTop,
                    grabY: headerTop - cellTop + touchY,
                    translation: lastTranslation.current,
                };
                startTop.value = cellTop;
                ghostTop.value = cellTop + lastTranslation.current;
                following.value = true;
                lift.value = withTiming(1, LIFT);
                setDragState({ id: projectId, groupKey: group.key, others, from: index, gap: index, height: cellHeight });
                if (Platform.OS !== 'web') hapticsLight();
            }, fail);
        }, fail);
    };

    const move = (translation: number) => {
        lastTranslation.current = translation;
        if (!geometry.current) return;
        geometry.current.translation = translation;
        updateGap();
    };

    const finish = (commit: boolean) => {
        const drag = stateRef.current;
        geometry.current = null;
        if (!drag) return;
        const order = orderWithDrop(drag.others, drag.id, drag.gap);
        const moved = commit && drag.gap !== drag.from;
        // Saving the order and letting go of the card must land in one render,
        // or the card would flash back to where it was for a frame. React 19
        // batches every update made in the same task, the store's included.
        if (moved) {
            saveProjectOrder(groupsRef.current.flatMap((group) => {
                if (group.key !== drag.groupKey) return group.ids;
                // Cards that appeared in the group mid-drag keep their place after it.
                const placed = order.filter((id) => group.ids.includes(id));
                return [...placed, ...group.ids.filter((id) => !placed.includes(id))];
            }));
        }
        setDragState(null);
    };

    const end = (success: boolean) => {
        const drag = stateRef.current;
        const geo = geometry.current;
        if (!drag && !pending.current) return;
        guardUntil.current = Date.now() + PRESS_GUARD_MS;
        if (pending.current) {
            // Released before the card had even lifted.
            pending.current = null;
            return;
        }
        if (!drag || !geo) return;
        following.value = false;
        lift.value = withTiming(0, SETTLE);
        // A cancelled drag (the system took the touch) goes back where it came from.
        const gap = success ? drag.gap : drag.from;
        if (gap !== drag.gap) setDragState({ ...drag, gap });
        const target = slotTop(geo.groupTop, geo.heights, gap) - scroll.offset;
        ghostTop.value = withTiming(target, SETTLE, () => {
            runOnJS(finish)(success);
        });
    };

    // The gesture's callbacks run as worklets and reach JS through these, so
    // they must stay the same functions for the life of the list.
    const handlers = React.useRef({ begin, move, end });
    handlers.current = { begin, move, end };
    const beginJS = React.useCallback((projectId: string, headerKey: string, touchY: number) => {
        handlers.current.begin(projectId, headerKey, touchY);
    }, []);
    const moveJS = React.useCallback((translation: number) => {
        handlers.current.move(translation);
    }, []);
    const endJS = React.useCallback((success: boolean) => {
        handlers.current.end(success);
    }, []);

    // Holding a finger near an edge keeps scrolling while it stays still, which
    // no gesture event would report — so a frame loop drives it.
    const dragging = state !== null;
    React.useEffect(() => {
        if (!dragging) return;
        let frame = 0;
        let previous = 0;
        const tick = (now: number) => {
            const geo = geometry.current;
            if (geo && stateRef.current && previous > 0) {
                const elapsed = Math.min(48, now - previous) / 1000;
                const finger = geo.startTop + geo.grabY + geo.translation;
                const speed = gatedAutoScrollSpeed(
                    autoScrollSpeed(
                        finger,
                        insetsRef.current.top,
                        scroll.viewport - insetsRef.current.bottom,
                        AUTO_SCROLL_EDGE,
                        AUTO_SCROLL_SPEED,
                    ),
                    geo.translation,
                    AUTO_SCROLL_ARM_DISTANCE,
                );
                if (speed !== 0) {
                    const maxOffset = Math.max(0, scroll.content - scroll.viewport);
                    const next = Math.min(maxOffset, Math.max(0, scroll.offset + speed * elapsed));
                    if (next !== scroll.offset) {
                        scroll.offset = next;
                        listRef.current?.scrollToOffset({ offset: next, animated: false });
                        updateGap();
                    }
                }
            }
            previous = now;
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [dragging]); // eslint-disable-line react-hooks/exhaustive-deps

    const api = React.useMemo<ProjectCardDragApi>(() => ({
        headerGesture: (projectId: string, headerKey: string) => Gesture.Pan()
            .activateAfterLongPress(LONG_PRESS_MS)
            .onStart((event) => {
                runOnJS(beginJS)(projectId, headerKey, event.y);
            })
            .onUpdate((event) => {
                if (following.value) ghostTop.value = startTop.value + event.translationY;
                runOnJS(moveJS)(event.translationY);
            })
            .onFinalize((_event, success) => {
                runOnJS(endJS)(success);
            }),
        registerHeader: (headerKey, view) => {
            if (view) headers.set(headerKey, view);
            else headers.delete(headerKey);
        },
        registerCell: (projectId, view) => {
            if (view) cells.set(projectId, view);
            else cells.delete(projectId);
        },
        reportCellHeight: (projectId, height) => {
            if (height > 0) heights.set(projectId, height);
        },
        moveBy: (projectId, delta) => {
            const group = groupsRef.current.find((candidate) => candidate.ids.includes(projectId));
            if (!group) return;
            const from = group.ids.indexOf(projectId);
            const to = from + delta;
            if (to < 0 || to >= group.ids.length) return;
            const order = moveProjectId(group.ids, from, to);
            saveProjectOrder(groupsRef.current.flatMap((candidate) => (
                candidate.key === group.key ? order : candidate.ids
            )));
        },
        pressSuppressed: () => (
            stateRef.current !== null || pending.current !== null || Date.now() < guardUntil.current
        ),
    }), [beginJS, cells, endJS, following, ghostTop, headers, heights, moveJS, startTop]);

    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        scroll.offset = event.nativeEvent.contentOffset.y;
        if (stateRef.current) updateGap();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const onContentSizeChange = React.useCallback((_width: number, height: number) => {
        scroll.content = height;
    }, [scroll]);

    const onContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
        scroll.viewport = event.nativeEvent.layout.height;
    }, [scroll]);

    return {
        api,
        state,
        listRef,
        containerRef,
        onScroll,
        onContentSizeChange,
        onContainerLayout,
        ghost: { ghostTop, lift },
    };
}

/** Where the empty slot sits: before `id`, after it, or not at this card. */
export function slotAround(state: ProjectCardDragState | null, id: string): { before: number; after: number } {
    if (!state) return NO_SLOT;
    if (state.gap < state.others.length) {
        return state.others[state.gap] === id ? { before: state.height, after: 0 } : NO_SLOT;
    }
    return state.others[state.others.length - 1] === id ? { before: 0, after: state.height } : NO_SLOT;
}

const NO_SLOT = { before: 0, after: 0 };

/**
 * A project card's cell in the list: reports where and how tall the card is,
 * shrinks it to nothing while it is the one being held, and draws the empty
 * slot the held card will land in when that slot is next to this card.
 */
export const ProjectCardDragCell = React.memo(function ProjectCardDragCell({
    projectId,
    hidden,
    slotBefore,
    slotAfter,
    children,
}: {
    projectId: string;
    hidden: boolean;
    slotBefore: number;
    slotAfter: number;
    children: React.ReactNode;
}) {
    const api = useProjectCardDragApi();
    const ref = React.useRef<View>(null);

    React.useEffect(() => {
        if (!api) return;
        api.registerCell(projectId, ref.current);
        return () => api.registerCell(projectId, null);
    }, [api, projectId]);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        // A hidden card measures zero; keep the height it had.
        if (!hidden) api?.reportCellHeight(projectId, event.nativeEvent.layout.height);
    }, [api, hidden, projectId]);

    return (
        <View>
            {slotBefore > 0 && <DropSlot height={slotBefore} />}
            <View ref={ref} collapsable={false} onLayout={onLayout} style={hidden ? styles.hiddenCard : undefined}>
                {children}
            </View>
            {slotAfter > 0 && <DropSlot height={slotAfter} />}
        </View>
    );
});

/** Where the held card will land: a quiet placeholder of its size. */
function DropSlot({ height }: { height: number }) {
    return (
        <View style={[styles.slot, { height }]}>
            <View style={styles.slotFill} />
        </View>
    );
}

/**
 * The floating copy of the held card. It lives over the list, not in it, so
 * the list can shift underneath without dragging the copy along.
 */
export function ProjectCardGhost({ ghost, children }: {
    ghost: { ghostTop: SharedValue<number>; lift: SharedValue<number> };
    children: React.ReactNode;
}) {
    // Lifted means slightly larger and casting a shadow — and fully opaque, so
    // the card it passes over never shows through it.
    const style = useAnimatedStyle(() => ({
        transform: [
            { translateY: ghost.ghostTop.value },
            { scale: 1 + 0.02 * ghost.lift.value },
        ],
    }));
    return (
        <Animated.View pointerEvents="none" testID="project-card-ghost" style={[styles.ghost, style]}>
            {/* The copy is a picture of the card, not a card: nothing in it drags. */}
            <ProjectCardDragContext.Provider value={null}>
                {children}
            </ProjectCardDragContext.Provider>
        </Animated.View>
    );
}

const styles = StyleSheet.create((theme) => ({
    hiddenCard: {
        height: 0,
        opacity: 0,
        overflow: 'hidden',
    },
    slot: {
        paddingHorizontal: Platform.select({ ios: 16, default: 12 }),
        paddingTop: 4,
        paddingBottom: 8,
    },
    slotFill: {
        flex: 1,
        borderRadius: Platform.select({ web: 16, default: 18 }),
        backgroundColor: theme.colors.surfacePressed,
    },
    ghost: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        elevation: 12,
        borderRadius: 18,
        backgroundColor: theme.colors.groupped.background,
        shadowColor: '#000',
        shadowOpacity: 0.22,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 10 },
    },
}));
