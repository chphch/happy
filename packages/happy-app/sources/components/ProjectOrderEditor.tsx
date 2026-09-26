import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
    scrollTo,
    useAnimatedReaction,
    useAnimatedRef,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useDerivedValue,
    useFrameCallback,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAllMachines, type SessionRowData } from '@/sync/storage';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { saveProjectOrder, useProjectRank } from '@/hooks/useProjectOrder';
import { buildSessionProjectDisplayGroups } from '@/utils/sessionDisplayOrder';
import { moveProjectId } from '@/utils/projectOrder';
import { Avatar } from './Avatar';
import { MobileGlassSurface } from './MobileGlass';
import { hapticsLight } from './haptics';

const ROW_HEIGHT = 52;
const SECTION_HEADER_HEIGHT = 32;
const AVATAR_SIZE = 28;
/** How near the list's top or bottom edge a dragged row starts scrolling it. */
const AUTO_SCROLL_EDGE = 56;
/** Auto-scroll speed at the very edge, in points per second. */
const AUTO_SCROLL_SPEED = 720;
const SHIFT = { duration: 160 };
const SETTLE = { duration: 150 };
const LIFT = { duration: 120 };
// The key a machine group with no machine files under; no machine id is empty.
const UNKNOWN_MACHINE_KEY = '';

interface EditorProject {
    id: string;
    name: string;
    avatar: SessionRowData | null;
}

interface EditorSection {
    key: string;
    machineName: string;
    projects: EditorProject[];
}

/**
 * Where each card sits while the editor is open, read and written on the UI
 * thread during a drag so nothing waits on React.
 */
interface DragState {
    /** Card id → its slot within its machine group. */
    positions: SharedValue<Record<string, number>>;
    /** Card id → the machine group it belongs to (and may not leave). */
    sectionOf: SharedValue<Record<string, string>>;
    sectionCounts: SharedValue<Record<string, number>>;
    /** Machine group → where its first row sits in the scroll content. */
    sectionTops: SharedValue<Record<string, number>>;
    activeId: SharedValue<string | null>;
    dragTop: SharedValue<number>;
    startTop: SharedValue<number>;
    startScroll: SharedValue<number>;
    translation: SharedValue<number>;
    /** Signed points per second the list should scroll by itself. */
    autoScroll: SharedValue<number>;
    scrollOffset: SharedValue<number>;
    /** Recomputes the dragged row from the finger and the scroll position. */
    update: () => void;
}

/** Opens the editor, scrolled to and marking the card it was opened from. */
export function openProjectOrderEditor(focusProjectId?: string) {
    Modal.show({ component: ProjectOrderEditor, props: { focusProjectId } });
}

function clamp(value: number, min: number, max: number): number {
    'worklet';
    return Math.min(max, Math.max(min, value));
}

/** Moves the card in slot `from` to slot `to`, shifting its group between. */
function moveSlot(
    positions: Record<string, number>,
    sectionOf: Record<string, string>,
    section: string,
    from: number,
    to: number,
): Record<string, number> {
    'worklet';
    const next: Record<string, number> = {};
    for (const id of Object.keys(positions)) {
        const slot = positions[id];
        if (sectionOf[id] !== section) {
            next[id] = slot;
        } else if (slot === from) {
            next[id] = to;
        } else if (from < to && slot > from && slot <= to) {
            next[id] = slot - 1;
        } else if (from > to && slot >= to && slot < from) {
            next[id] = slot + 1;
        } else {
            next[id] = slot;
        }
    }
    return next;
}

function sectionIdsInSlotOrder(
    positions: Record<string, number>,
    sectionOf: Record<string, string>,
    section: string,
): string[] {
    'worklet';
    return Object.keys(positions)
        .filter((id) => sectionOf[id] === section)
        .sort((a, b) => positions[a] - positions[b]);
}

function slotsOf(sections: readonly EditorSection[]) {
    const positions: Record<string, number> = {};
    const sectionOf: Record<string, string> = {};
    const counts: Record<string, number> = {};
    for (const section of sections) {
        section.projects.forEach((project, index) => {
            positions[project.id] = index;
            sectionOf[project.id] = section.key;
        });
        counts[section.key] = section.projects.length;
    }
    return { positions, sectionOf, counts };
}

/**
 * The dialog that arranges the home list's project cards.
 *
 * One fixed-height row per project, grouped under its machine the way the list
 * groups them. Rows are placed absolutely from a slot map that lives on the UI
 * thread, so a drag never waits on React: the finger moves the row, the rows it
 * passes slide out of the way, and only the drop goes back to JS to be saved.
 * The saved order then comes back through `useProjectRank` already matching
 * what is on screen, so nothing moves when it lands.
 */
function ProjectOrderEditor({ focusProjectId, onClose }: {
    focusProjectId?: string;
    onClose: () => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const data = useVisibleSessionListViewData();
    const machines = useAllMachines();
    const projectRank = useProjectRank();

    const sections = React.useMemo<EditorSection[]>(() => {
        if (!data) return [];
        return buildSessionProjectDisplayGroups(data, machines, t('status.unknown'), projectRank)
            .map((group) => ({
                key: group.machineId ?? UNKNOWN_MACHINE_KEY,
                machineName: group.machineName,
                projects: group.projects.map(({ project }) => ({
                    id: project.id,
                    name: project.name,
                    avatar: project.workspaces[0]?.sessions[0] ?? null,
                })),
            }))
            .filter((section) => section.projects.length > 0);
    }, [data, machines, projectRank]);

    // The list data is rebuilt on every session update; only a change in which
    // cards sit where should reach the slot map.
    const slotKey = sections
        .map((section) => `${section.key}\u0001${section.projects.map((project) => project.id).join('\u0002')}`)
        .join('\u0003');
    const slots = React.useMemo(() => slotsOf(sections), [slotKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const positions = useSharedValue(slots.positions);
    const sectionOf = useSharedValue(slots.sectionOf);
    const sectionCounts = useSharedValue(slots.counts);
    const sectionTops = useSharedValue<Record<string, number>>({});
    const activeId = useSharedValue<string | null>(null);
    const dragTop = useSharedValue(0);
    const startTop = useSharedValue(0);
    const startScroll = useSharedValue(0);
    const translation = useSharedValue(0);
    const autoScroll = useSharedValue(0);
    const scrollOffset = useSharedValue(0);
    const viewportHeight = useSharedValue(0);
    const contentHeight = useSharedValue(0);

    React.useEffect(() => {
        positions.value = slots.positions;
        sectionOf.value = slots.sectionOf;
        sectionCounts.value = slots.counts;
        // A card that left the list mid-drag (its last session archived) takes
        // the drag with it.
        const dragged = activeId.value;
        if (dragged !== null && !(dragged in slots.positions)) activeId.value = null;
    }, [slots, positions, sectionOf, sectionCounts, activeId]);

    const scrollRef = useAnimatedRef<Animated.ScrollView>();
    const onScroll = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollOffset.value = event.contentOffset.y;
        },
    });

    const update = React.useCallback(() => {
        'worklet';
        const id = activeId.value;
        if (id === null) return;
        const section = sectionOf.value[id];
        const count = sectionCounts.value[section] ?? 1;
        // The row follows the finger, plus however far the list scrolled under
        // it, and cannot leave its machine's group.
        const top = clamp(
            startTop.value + translation.value + (scrollOffset.value - startScroll.value),
            0,
            (count - 1) * ROW_HEIGHT,
        );
        dragTop.value = top;

        const from = positions.value[id];
        const to = clamp(Math.round(top / ROW_HEIGHT), 0, count - 1);
        if (from !== undefined && to !== from) {
            positions.value = moveSlot(positions.value, sectionOf.value, section, from, to);
        }

        const onScreen = (sectionTops.value[section] ?? 0) + top - scrollOffset.value;
        const bottomEdge = viewportHeight.value - AUTO_SCROLL_EDGE;
        if (onScreen < AUTO_SCROLL_EDGE) {
            autoScroll.value = -AUTO_SCROLL_SPEED * Math.min(1, (AUTO_SCROLL_EDGE - onScreen) / AUTO_SCROLL_EDGE);
        } else if (onScreen + ROW_HEIGHT > bottomEdge) {
            autoScroll.value = AUTO_SCROLL_SPEED * Math.min(1, (onScreen + ROW_HEIGHT - bottomEdge) / AUTO_SCROLL_EDGE);
        } else {
            autoScroll.value = 0;
        }
    }, [activeId, autoScroll, dragTop, positions, scrollOffset, sectionCounts, sectionOf, sectionTops, startScroll, startTop, translation, viewportHeight]);

    // Holding a row near an edge keeps scrolling while the finger stays still,
    // which no gesture event would report — so the frame clock drives it.
    useFrameCallback((frame) => {
        const speed = autoScroll.value;
        if (speed === 0 || activeId.value === null) return;
        const elapsed = Math.min(frame.timeSincePreviousFrame ?? 16, 48);
        const maxOffset = Math.max(0, contentHeight.value - viewportHeight.value);
        const next = clamp(scrollOffset.value + (speed * elapsed) / 1000, 0, maxOffset);
        if (next === scrollOffset.value) return;
        scrollOffset.value = next;
        scrollTo(scrollRef, 0, next, false);
        update();
    });

    const drag = React.useMemo<DragState>(() => ({
        positions,
        sectionOf,
        sectionCounts,
        sectionTops,
        activeId,
        dragTop,
        startTop,
        startScroll,
        translation,
        autoScroll,
        scrollOffset,
        update,
    }), [activeId, autoScroll, dragTop, positions, scrollOffset, sectionCounts, sectionOf, sectionTops, startScroll, startTop, translation, update]);

    // Native scrolling stays off while a row is held, so the list cannot slide
    // under the finger; the drag scrolls it on purpose instead.
    const [dragging, setDragging] = React.useState(false);

    const sectionsRef = React.useRef(sections);
    sectionsRef.current = sections;

    const commitSection = React.useCallback((sectionKey: string, orderedIds: readonly string[]) => {
        const current = sectionsRef.current;
        const section = current.find((candidate) => candidate.key === sectionKey);
        if (!section) return;
        const shownIds = section.projects.map((project) => project.id);
        const inSection = new Set(shownIds);
        const placed = orderedIds.filter((id) => inSection.has(id));
        const placedSet = new Set(placed);
        const nextIds = [...placed, ...shownIds.filter((id) => !placedSet.has(id))];
        if (nextIds.every((id, index) => id === shownIds[index])) return;
        saveProjectOrder(current.flatMap((candidate) => (
            candidate.key === sectionKey ? nextIds : candidate.projects.map((project) => project.id)
        )));
    }, []);

    const handlePickUp = React.useCallback(() => {
        setDragging(true);
        if (Platform.OS !== 'web') hapticsLight();
    }, []);

    const handleDrop = React.useCallback((sectionKey: string, orderedIds: string[]) => {
        setDragging(false);
        commitSection(sectionKey, orderedIds);
    }, [commitSection]);

    const moveBy = React.useCallback((sectionKey: string, projectId: string, delta: number) => {
        const section = sectionsRef.current.find((candidate) => candidate.key === sectionKey);
        if (!section) return;
        const ids = section.projects.map((project) => project.id);
        const from = ids.indexOf(projectId);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= ids.length) return;
        commitSection(sectionKey, moveProjectId(ids, from, to));
    }, [commitSection]);

    // Open on the card the editor was opened from.
    const focusTop = React.useRef<number | null>(null);
    const viewport = React.useRef(0);
    const focused = React.useRef(false);
    const scrollToFocus = React.useCallback(() => {
        if (focused.current || focusTop.current === null || viewport.current <= 0) return;
        focused.current = true;
        const y = Math.max(0, focusTop.current - (viewport.current - ROW_HEIGHT) / 2);
        scrollRef.current?.scrollTo({ y, animated: false });
    }, [scrollRef]);

    // Layout events arrive one section at a time on the JS thread; collect them
    // here and hand the drag the whole map, so no section's entry is lost to
    // another's write.
    const sectionTopsByKey = React.useRef<Record<string, number>>({});
    const handleSectionLayout = React.useCallback((section: EditorSection, event: LayoutChangeEvent) => {
        const rowsTop = event.nativeEvent.layout.y + SECTION_HEADER_HEIGHT;
        sectionTopsByKey.current = { ...sectionTopsByKey.current, [section.key]: rowsTop };
        sectionTops.value = sectionTopsByKey.current;
        const index = focusProjectId ? section.projects.findIndex((project) => project.id === focusProjectId) : -1;
        if (index >= 0) {
            focusTop.current = rowsTop + index * ROW_HEIGHT;
            scrollToFocus();
        }
    }, [focusProjectId, scrollToFocus, sectionTops]);

    const handleListLayout = React.useCallback((event: LayoutChangeEvent) => {
        viewport.current = event.nativeEvent.layout.height;
        viewportHeight.value = event.nativeEvent.layout.height;
        scrollToFocus();
    }, [scrollToFocus, viewportHeight]);

    const handleContentSize = React.useCallback((_width: number, contentH: number) => {
        contentHeight.value = contentH;
    }, [contentHeight]);

    const dialogWidth = Math.min(380, width - 32);
    const listMaxHeight = Math.max(ROW_HEIGHT * 3, Math.min(560, height - insets.top - insets.bottom - 220));

    return (
        <GestureHandlerRootView style={{ width: dialogWidth }}>
            <MobileGlassSurface
                enabled={Platform.OS !== 'web'}
                nativeEffect
                glassEffectStyle="regular"
                intensity={88}
                tintColor={theme.colors.glass.overlayTint}
                style={styles.container}
            >
                <View style={styles.heading}>
                    <Text style={styles.title}>{t('projectOrder.title')}</Text>
                    <Text style={styles.hint}>{t('projectOrder.hint')}</Text>
                </View>
                {sections.length === 0 ? (
                    <Text style={styles.empty}>{t('projectOrder.empty')}</Text>
                ) : (
                    <Animated.ScrollView
                        ref={scrollRef}
                        style={{ maxHeight: listMaxHeight }}
                        contentContainerStyle={styles.listContent}
                        onScroll={onScroll}
                        scrollEventThrottle={16}
                        scrollEnabled={!dragging}
                        onLayout={handleListLayout}
                        onContentSizeChange={handleContentSize}
                    >
                        {sections.map((section) => (
                            <View key={section.key} onLayout={(event) => handleSectionLayout(section, event)}>
                                <View style={styles.sectionHeader}>
                                    <Ionicons name="desktop-outline" size={12} color={theme.colors.textSecondary} />
                                    <Text style={styles.sectionHeaderText} numberOfLines={1}>
                                        {section.machineName}
                                    </Text>
                                    <View style={styles.sectionHeaderLine} />
                                </View>
                                <View style={{ height: section.projects.length * ROW_HEIGHT }}>
                                    {section.projects.map((project, index) => (
                                        <EditorRow
                                            key={project.id}
                                            project={project}
                                            sectionKey={section.key}
                                            index={index}
                                            focused={project.id === focusProjectId}
                                            drag={drag}
                                            onPickUp={handlePickUp}
                                            onDrop={handleDrop}
                                            onMoveBy={moveBy}
                                        />
                                    ))}
                                </View>
                            </View>
                        ))}
                    </Animated.ScrollView>
                )}
                <View style={styles.buttonRow}>
                    <Pressable
                        onPress={onClose}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                    >
                        <Text style={[styles.buttonText, styles.buttonTextConfirm]}>{t('projectOrder.done')}</Text>
                    </Pressable>
                </View>
            </MobileGlassSurface>
        </GestureHandlerRootView>
    );
}

const EditorRow = React.memo(function EditorRow({
    project,
    sectionKey,
    index,
    focused,
    drag,
    onPickUp,
    onDrop,
    onMoveBy,
}: {
    project: EditorProject;
    sectionKey: string;
    index: number;
    focused: boolean;
    drag: DragState;
    onPickUp: () => void;
    onDrop: (sectionKey: string, orderedIds: string[]) => void;
    onMoveBy: (sectionKey: string, projectId: string, delta: number) => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { id } = project;

    const slot = useDerivedValue(() => drag.positions.value[id] ?? index, [drag, id, index]);
    const top = useSharedValue(index * ROW_HEIGHT);
    // Slides out of the way when a dragged row passes it. The dragged row
    // itself is drawn at the finger meanwhile, so its own slot moves without
    // animating — and is already where it lands once it is let go.
    useAnimatedReaction(
        () => slot.value,
        (next, previous) => {
            if (previous === null || drag.activeId.value === id) {
                top.value = next * ROW_HEIGHT;
            } else if (next !== previous) {
                top.value = withTiming(next * ROW_HEIGHT, SHIFT);
            }
        },
        [drag, id],
    );

    const lift = useSharedValue(0);
    const liftedBackground = theme.colors.surfaceHigh;
    const restingBackground = focused ? theme.colors.surfaceSelected : 'transparent';
    const rowStyle = useAnimatedStyle(() => {
        const active = drag.activeId.value === id;
        return {
            top: active ? drag.dragTop.value : top.value,
            zIndex: active ? 2 : 1,
            elevation: 6 * lift.value,
            shadowOpacity: 0.18 * lift.value,
            backgroundColor: active ? liftedBackground : restingBackground,
            transform: [{ scale: 1 + 0.02 * lift.value }],
        };
    }, [drag, id, liftedBackground, restingBackground]);

    const gesture = React.useMemo(() => Gesture.Pan()
        // The handle is the only thing a press here can mean, so the drag
        // starts on touch-down — before the list can claim the touch as a
        // scroll.
        .manualActivation(true)
        .onTouchesDown((_event, manager) => {
            manager.activate();
        })
        .onStart(() => {
            const slotTop = (drag.positions.value[id] ?? 0) * ROW_HEIGHT;
            drag.activeId.value = id;
            drag.startTop.value = slotTop;
            drag.dragTop.value = slotTop;
            drag.startScroll.value = drag.scrollOffset.value;
            drag.translation.value = 0;
            lift.value = withTiming(1, LIFT);
            runOnJS(onPickUp)();
        })
        .onUpdate((event) => {
            drag.translation.value = event.translationY;
            drag.update();
        })
        .onFinalize(() => {
            if (drag.activeId.value !== id) return;
            drag.autoScroll.value = 0;
            lift.value = withTiming(0, SETTLE);
            const slotTop = (drag.positions.value[id] ?? 0) * ROW_HEIGHT;
            drag.dragTop.value = withTiming(slotTop, SETTLE, () => {
                if (drag.activeId.value === id) drag.activeId.value = null;
            });
            runOnJS(onDrop)(sectionKey, sectionIdsInSlotOrder(drag.positions.value, drag.sectionOf.value, sectionKey));
        }), [drag, id, lift, onDrop, onPickUp, sectionKey]);

    return (
        <Animated.View
            style={[styles.row, rowStyle]}
            accessible
            accessibilityLabel={project.name}
            accessibilityActions={[
                { name: 'decrement', label: t('projectOrder.moveUp') },
                { name: 'increment', label: t('projectOrder.moveDown') },
            ]}
            onAccessibilityAction={(event) => {
                onMoveBy(sectionKey, id, event.nativeEvent.actionName === 'increment' ? 1 : -1);
            }}
        >
            <View style={styles.avatarLane}>
                {project.avatar && (
                    <Avatar
                        id={project.avatar.avatarId}
                        size={AVATAR_SIZE}
                        flavor={null}
                        imageUrl={project.avatar.projectAvatarUri}
                        thumbhash={project.avatar.projectAvatarThumbhash}
                    />
                )}
            </View>
            <Text style={styles.name} numberOfLines={1}>{project.name}</Text>
            <GestureDetector gesture={gesture}>
                <View style={styles.handle} testID={`project-order-handle-${id}`}>
                    <Ionicons name="reorder-three" size={24} color={theme.colors.textSecondary} />
                </View>
            </GestureDetector>
        </Animated.View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        borderRadius: 14,
        overflow: 'hidden',
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
    },
    heading: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 8,
        gap: 6,
    },
    title: {
        fontSize: 17,
        textAlign: 'center',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    hint: {
        fontSize: 13,
        lineHeight: 18,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    empty: {
        paddingHorizontal: 20,
        paddingVertical: 24,
        fontSize: 14,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    listContent: {
        paddingHorizontal: 8,
        paddingBottom: 8,
    },
    sectionHeader: {
        height: SECTION_HEADER_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
    },
    sectionHeaderText: {
        maxWidth: '70%',
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    sectionHeaderLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    row: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: ROW_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingLeft: 12,
        borderRadius: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowRadius: 10,
    },
    avatarLane: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
    },
    name: {
        flex: 1,
        minWidth: 0,
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
    handle: {
        width: 48,
        height: ROW_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        ...Platform.select({ web: { cursor: 'grab' } as object, default: {} }),
    },
    buttonRow: {
        flexDirection: 'row',
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    button: {
        flex: 1,
        paddingVertical: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        backgroundColor: theme.colors.divider,
    },
    buttonText: {
        fontSize: 17,
        color: theme.colors.textLink,
        ...Typography.default(),
    },
    buttonTextConfirm: {
        ...Typography.default('semiBold'),
    },
}));
