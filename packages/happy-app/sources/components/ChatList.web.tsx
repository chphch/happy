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
        if (!hasRestoredRef.current) return;
        const scrollTop = e.currentTarget.scrollTop;
        sessionScrollOffsets.set(props.sessionId, scrollTop);
        const next = Math.abs(scrollTop) > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
    }, [props.sessionId]);

    const scrollToBottom = React.useCallback(() => {
        const node = scrollRef.current;
        if (!node) return;
        node.scrollTo({ top: 0, behavior: 'smooth' });
    }, []);

    // Restore on mount, then retry as content height grows. column-reverse
    // <div> starts with scrollTop=0 at the visual bottom; scrolling up takes
    // scrollTop negative. Cached values are negative for non-bottom positions.
    //
    // Why a retry loop: messages render asynchronously (virtualized
    // MessageView children may settle their height after layout). The first
    // attempt to set scrollTop=cached may be clamped by the browser if
    // scrollHeight isn't large enough yet. We keep retrying on each new
    // messages.length / content resize until the actual scrollTop matches
    // (or content has stabilised), then mark restored.
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
        node.scrollTop = cached;
        // Mark restored only once the browser accepted the value. Negative
        // scrollTop values get clamped toward 0 if content isn't tall enough.
        if (Math.abs(node.scrollTop - cached) < 1) {
            hasRestoredRef.current = true;
        }
    }, [props.sessionId, props.messages.length]);

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
                {props.messages.map((message) => (
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
