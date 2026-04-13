import * as React from 'react';
import { useSession, useSessionMessages } from '@/sync/storage';
import { Pressable, View } from 'react-native';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const SCROLL_THRESHOLD = 300;

// Render windowing. The web variant renders messages into a plain
// column-reverse <div> with no list virtualization (unlike the native
// ChatList.tsx FlatList). Without a cap, every loaded message becomes a live
// DOM node + React fiber — and prefetchOlderMessagesInBackground keeps growing
// the store to the full session history, so a long session mounts thousands of
// MessageViews on open and re-mounts all of them on every session switch.
//
// Fix: render only the newest INITIAL_WINDOW messages on mount, then reveal
// WINDOW_STEP more whenever the user scrolls within REVEAL_THRESHOLD_PX of the
// oldest rendered message. Messages are newest-first, so slice(0, n) is the
// newest n — stable as background prefetch appends older messages to the tail,
// which means that growth no longer triggers any re-render of the visible slice.
const INITIAL_WINDOW = 50;
const WINDOW_STEP = 50;
const REVEAL_THRESHOLD_PX = 1500;

// Per-session scroll offset cache (module scope, in-memory only).
// Mirrors the native ChatList.tsx cache. SessionView mounts
// <ChatList key={sessionId} ...> via expo-router's Stack, so navigating
// away unmounts this component and the <div>'s scrollTop is destroyed.
// Without this cache, returning to a session always renders at the visual
// bottom (scrollTop 0 in column-reverse), losing the user's prior position.
//
// Values are the column-reverse scrollTop — i.e. 0 at the visual bottom and
// progressively negative as the user scrolls up to read older messages.
const sessionScrollOffsets: Map<string, number> = new Map();

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
        />
    );
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null;
    sessionId: string;
    messages: Message[];
}) => {
    const { theme } = useUnistyles();
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    const session = useSession(props.sessionId)!;
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const hasRestoredRef = React.useRef(false);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    // Tracks current showScrollButton value so we only call setState when the
    // threshold is actually crossed, not on every scroll frame. Mirrors the
    // guard in ChatList.tsx.
    const showScrollButtonRef = React.useRef(false);

    // How many of the newest messages to actually render. Grows as the user
    // scrolls toward older messages (see handleScroll / restore effect). Resets
    // to INITIAL_WINDOW on every mount — ChatList is keyed by sessionId, so a
    // session switch remounts and the window starts small again.
    const [renderLimit, setRenderLimit] = React.useState(INITIAL_WINDOW);
    // Debounces reveal: one window grow per committed render, so a single
    // momentum scroll gesture (many onScroll frames before React re-renders)
    // cannot stack several setRenderLimit updates into an over-reveal.
    const revealPendingRef = React.useRef(false);
    React.useEffect(() => {
        revealPendingRef.current = false;
    }, [renderLimit]);

    // The newest `renderLimit` messages — the only ones mounted as DOM nodes.
    const visibleMessages = React.useMemo(
        () => props.messages.slice(0, renderLimit),
        [props.messages, renderLimit],
    );

    // Save scroll position on every scroll event. Skip writes while the
    // restore loop below is still in progress: during restore we set
    // scrollTop programmatically, which fires onScroll with the clamped
    // value (browser caps to current scrollHeight, which is still growing
    // as messages render). Writing those clamped values back would poison
    // the cache before we finish restoring.
    //
    // column-reverse: scrollTop=0 at visual bottom, |scrollTop| grows as the
    // user scrolls up toward older messages. Sign varies by browser (Chromium
    // returns negative values, others positive), so abs() to be safe.
    const handleScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const node = e.currentTarget;
        const scrollTop = node.scrollTop;

        // Reveal older messages as the user approaches the oldest rendered one.
        // column-reverse: the visual top is reached as |scrollTop| approaches
        // (scrollHeight - clientHeight). Reveal a buffer early so older content
        // is already mounted before it scrolls into view. revealPendingRef caps
        // a single momentum gesture to one WINDOW_STEP grow.
        if (!revealPendingRef.current && renderLimit < props.messages.length) {
            const distanceToTop = node.scrollHeight - node.clientHeight - Math.abs(scrollTop);
            if (distanceToTop < REVEAL_THRESHOLD_PX) {
                revealPendingRef.current = true;
                setRenderLimit((prev) => Math.min(prev + WINDOW_STEP, props.messages.length));
            }
        }

        if (!hasRestoredRef.current) return;
        sessionScrollOffsets.set(props.sessionId, scrollTop);
        const next = Math.abs(scrollTop) > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
    }, [props.sessionId, props.messages.length, renderLimit]);

    const scrollToBottom = React.useCallback(() => {
        const node = scrollRef.current;
        if (!node) return;
        node.scrollTo({ top: 0, behavior: 'smooth' });
    }, []);

    // Restore on mount, then retry as content height grows. column-reverse
    // <div> starts with scrollTop=0 at the visual bottom; scrolling up takes
    // scrollTop negative. Cached values are negative for non-bottom positions.
    //
    // Why a retry loop: a deep cached position may sit above the initial render
    // window. Setting scrollTop=cached would be clamped by the browser while
    // scrollHeight is still too short, so we first grow renderLimit until the
    // rendered slice is tall enough to contain the cached offset, then set it.
    // The effect re-runs on renderLimit / messages.length changes until the
    // actual scrollTop matches (or there are no more messages to reveal).
    React.useLayoutEffect(() => {
        if (hasRestoredRef.current) return;
        const node = scrollRef.current;
        if (!node) return;
        if (props.messages.length === 0) return;
        const cached = sessionScrollOffsets.get(props.sessionId);
        if (cached === undefined || cached >= 0) {
            // No cached scroll (or cached at bottom) — nothing to restore.
            hasRestoredRef.current = true;
            return;
        }
        // Grow the window until the rendered content can reach the cached
        // offset, instead of clamping to a wrong (too-shallow) position.
        const needed = Math.abs(cached) + node.clientHeight;
        if (node.scrollHeight < needed && renderLimit < props.messages.length) {
            setRenderLimit((prev) => Math.min(prev + WINDOW_STEP, props.messages.length));
            return; // retry after the wider slice renders (renderLimit in deps)
        }
        node.scrollTop = cached;
        // Mark restored only once the browser accepted the value. Negative
        // scrollTop values get clamped toward 0 if content isn't tall enough.
        if (Math.abs(node.scrollTop - cached) < 1) {
            hasRestoredRef.current = true;
        }
    }, [props.sessionId, props.messages.length, renderLimit]);

    // Capture the final position right before unmount so re-mounting this
    // session can restore. onScroll already keeps the cache fresh during
    // normal use, but if the unmount fires between a scroll event and the
    // next paint we want the very last value.
    React.useEffect(() => {
        return () => {
            const node = scrollRef.current;
            if (!node) return;
            sessionScrollOffsets.set(props.sessionId, node.scrollTop);
        };
    }, [props.sessionId]);

    // flex-direction: column-reverse gives us native browser reversed scroll
    // without scaleY(-1), so middle-click auto-scroll and wheel work correctly.
    // Messages are already newest-first from the store, which matches column-reverse order.
    return (
        <View style={{ flex: 1 }}>
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                style={{
                    display: 'flex',
                    flexDirection: 'column-reverse',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    height: '100%',
                    WebkitOverflowScrolling: 'touch',
                    scrollbarWidth: 'thin',
                }}
            >
                {/* In column-reverse, first DOM element = visual bottom */}
                <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
                {visibleMessages.map((message) => (
                    <MessageView
                        key={message.id}
                        message={message}
                        metadata={props.metadata}
                        sessionId={props.sessionId}
                    />
                ))}
                {/* Top spacer for header — last in DOM = visual top */}
                <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
            </div>
            {showScrollButton && (
                <View style={styles.scrollButtonContainer}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.scrollButton,
                            pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                        ]}
                        onPress={scrollToBottom}
                    >
                        <Octicons name="arrow-down" size={14} color={theme.colors.text} />
                    </Pressable>
                </View>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    scrollButtonContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 12,
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'box-none',
    },
    scrollButton: {
        borderRadius: 16,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2,
        shadowOpacity: theme.colors.shadow.opacity * 0.5,
        elevation: 2,
    },
    scrollButtonDefault: {
        backgroundColor: theme.colors.surface,
        opacity: 0.9,
    },
    scrollButtonPressed: {
        backgroundColor: theme.colors.surface,
        opacity: 0.7,
    },
}));
