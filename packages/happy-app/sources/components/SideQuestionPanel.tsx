import * as React from 'react';
import {
    View,
    Text,
    TextInput,
    ScrollView,
    Pressable,
    Platform,
    ActivityIndicator,
    useWindowDimensions,
    type LayoutChangeEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { storage, useSession } from '@/sync/storage';
import { forkAndSpawn, sessionSideQuestion } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { HappyError } from '@/utils/errors';
import { getSessionForkSource } from '@/utils/sessionFork';
import {
    createSideQuestionThreads,
    type SideQuestionExchange,
    type SideQuestionNotice,
    type SideQuestionThread,
} from '@/sync/sideQuestionThreads';
import { MarkdownView } from './markdown/MarkdownView';
import { MessageCopyButton } from './MessageView';
import { MobileGlassSurface } from './MobileGlass';

const sideQuestionThreads = createSideQuestionThreads({
    ask: sessionSideQuestion,
    isOnline: (sessionId) => storage.getState().sessions[sessionId]?.presence === 'online',
});

/**
 * `/btw <question>` in a chat: shows the chat's side thread and asks
 * `question` in it. The thread stays until its panel is closed, whatever
 * screens the user visits in between.
 */
export const openSideQuestion = sideQuestionThreads.open;

/** Share of the room below the panel's top it may take, so the chat and its composer stay in view. */
const MAX_HEIGHT_SHARE = 0.6;
/** Keeps the header and the field usable when the keyboard leaves little room. */
const MIN_HEIGHT = 160;

/**
 * Claude Code's `/btw` panel for one chat: the questions asked on the side,
 * their answers, and a field for follow-ups. Answers come from the current
 * context without tools and are never added to the chat, so they can be asked
 * mid-turn.
 *
 * It floats over the top of the chat instead of covering the screen, so the
 * session list, the chat and its composer all stay usable while it is open. It
 * draws the thread kept in sideQuestionThreads.ts rather than holding it, which
 * is what lets it come and go with the chat: leaving the chat leaves the thread
 * running, and coming back shows it again, with any answer that arrived in the
 * meantime.
 */
export const SideQuestionPanel = React.memo(function SideQuestionPanel(props: {
    sessionId: string;
    /** Where the chat's content starts, below any header drawn over it. */
    top: number;
}) {
    const thread = sideQuestionThreads.useThread(props.sessionId);
    if (!thread) {
        return null;
    }
    return <SideQuestionPanelView sessionId={props.sessionId} top={props.top} thread={thread} />;
});

function SideQuestionPanelView({ sessionId, top, thread }: {
    sessionId: string;
    top: number;
    thread: SideQuestionThread;
}) {
    const { theme } = useUnistyles();
    const window = useWindowDimensions();
    const keyboard = useKeyboardState();
    const [room, setRoom] = React.useState(0);
    const scrollRef = React.useRef<ScrollView>(null);
    const hasScrolled = React.useRef(false);

    // The keyboard rises over the screen rather than shrinking it, so the
    // panel leaves it out of its own room
    const keyboardHeight = keyboard.isVisible ? keyboard.height : 0;
    const maxHeight = Math.max(MIN_HEIGHT, Math.round(((room || window.height - top) - keyboardHeight) * MAX_HEIGHT_SHARE));

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = Math.round(event.nativeEvent.layout.height);
        setRoom((current) => (current === height ? current : height));
    }, []);

    const handleContentSizeChange = React.useCallback(() => {
        // A thread shown again on the way back starts at its latest answer
        scrollRef.current?.scrollToEnd({ animated: hasScrolled.current });
        hasScrolled.current = true;
    }, []);

    const handleChangeDraft = React.useCallback((draft: string) => {
        sideQuestionThreads.setDraft(sessionId, draft);
    }, [sessionId]);
    const handleSend = React.useCallback(() => {
        sideQuestionThreads.sendDraft(sessionId);
    }, [sessionId]);
    const handleClose = React.useCallback(() => {
        sideQuestionThreads.close(sessionId);
    }, [sessionId]);

    const canSend = thread.draft.trim().length > 0;

    return (
        <View pointerEvents="box-none" style={[styles.overlay, { top }]} onLayout={handleLayout}>
            <View style={[styles.card, { maxHeight }]}>
                <MobileGlassSurface
                    enabled={Platform.OS !== 'web'}
                    nativeEffect
                    glassEffectStyle="regular"
                    intensity={88}
                    tintColor={theme.colors.glass.overlayTint}
                    style={[styles.panel, { maxHeight }]}
                >
                    <View style={styles.header}>
                        <View style={styles.headerText}>
                            <Text style={styles.title}>{t('sideQuestion.title')}</Text>
                            <Text style={styles.subtitle}>{t('sideQuestion.subtitle')}</Text>
                        </View>
                        <Pressable
                            onPress={handleClose}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('sideQuestion.close')}
                            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                        >
                            <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>

                    {thread.exchanges.length > 0 && (
                        <ScrollView
                            ref={scrollRef}
                            style={styles.thread}
                            contentContainerStyle={styles.threadContent}
                            keyboardShouldPersistTaps="handled"
                            onContentSizeChange={handleContentSizeChange}
                        >
                            {thread.exchanges.map((exchange, index) => (
                                <View key={index} style={styles.exchange}>
                                    <View style={styles.questionBubble}>
                                        <Text style={styles.questionText} selectable>{exchange.question}</Text>
                                    </View>
                                    <ExchangeAnswer exchange={exchange} sessionId={sessionId} />
                                </View>
                            ))}
                        </ScrollView>
                    )}

                    <View style={styles.composer}>
                        <TextInput
                            style={styles.input}
                            value={thread.draft}
                            onChangeText={handleChangeDraft}
                            placeholder={t('sideQuestion.followUpPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            returnKeyType="send"
                            submitBehavior="submit"
                            onSubmitEditing={handleSend}
                        />
                        <Pressable
                            onPress={handleSend}
                            disabled={!canSend}
                            accessibilityRole="button"
                            accessibilityLabel={t('sideQuestion.send')}
                            style={({ pressed }) => [styles.sendButton, !canSend && styles.disabled, pressed && styles.pressed]}
                        >
                            <Ionicons name="arrow-up" size={18} color={theme.colors.button.primary.tint} />
                        </Pressable>
                    </View>
                </MobileGlassSurface>
            </View>
        </View>
    );
}

function ExchangeAnswer({ exchange, sessionId }: { exchange: SideQuestionExchange; sessionId: string }) {
    const { state } = exchange;
    const settled = state.status !== 'queued' && state.status !== 'asking';
    const answer = state.status === 'answered' && state.response !== null && !state.synthetic
        ? state.response
        : null;
    return (
        <View>
            <AnswerBody exchange={exchange} sessionId={sessionId} />
            {settled && (
                <View style={styles.answerActions}>
                    {/* Copies the answer alone, as `c` does in Claude Code's panel, to paste into the chat */}
                    {answer !== null && <MessageCopyButton text={answer} />}
                    <ForkButton sessionId={sessionId} question={exchange.question} />
                </View>
            )}
        </View>
    );
}

// The glyph is small, so the touch target reaches well past it
const FORK_HIT_SLOP = { top: 14, bottom: 14, left: 10, right: 14 };

/**
 * Takes the question further in a new session: forks this chat into one that
 * carries the same conversation, asks the question there as its first
 * message, where Claude has its tools, and opens it. Claude Code's `f` hands
 * the question to a forked subagent instead, which only its terminal UI can
 * start; a forked session is how the app gets the question the same reach.
 */
function ForkButton({ sessionId, question }: { sessionId: string; question: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const navigateToSession = useNavigateToSession();
    const forkSource = session ? getSessionForkSource(session) : null;
    const [forking, fork] = useHappyAction(async () => {
        if (!forkSource) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        const result = await forkAndSpawn(forkSource);
        if (result.type !== 'success') {
            throw new HappyError(result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric'), false);
        }
        await sync.sendMessage(result.sessionId, question, { source: 'chat' });
        navigateToSession(result.sessionId);
    });
    if (!forkSource) {
        return null;
    }
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('sideQuestion.fork')}
            hitSlop={FORK_HIT_SLOP}
            onPress={fork}
            disabled={forking}
            style={({ pressed }) => [styles.forkAction, pressed && styles.pressed]}
        >
            {forking
                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                : <Ionicons name="git-branch-outline" size={16} color={theme.colors.text} />}
        </Pressable>
    );
}

function AnswerBody({ exchange, sessionId }: { exchange: SideQuestionExchange; sessionId: string }) {
    const { theme } = useUnistyles();
    const { state } = exchange;
    switch (state.status) {
        case 'queued':
            return <Text style={styles.mutedText}>{t('sideQuestion.queued')}</Text>;
        case 'asking':
            return (
                <View style={styles.answering}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    <Text style={styles.mutedText}>{t('sideQuestion.answering')}</Text>
                </View>
            );
        case 'notice':
            return <Text style={styles.mutedText}>{describeNotice(state.notice)}</Text>;
        case 'failed':
            return <Text style={styles.failedText} selectable>{t('sideQuestion.failed', { error: state.error })}</Text>;
        case 'answered':
            if (state.response === null) {
                return <Text style={styles.mutedText}>{t('sideQuestion.noAnswer')}</Text>;
            }
            // Claude Code's stand-in for an answer the model could not give
            if (state.synthetic) {
                return <Text style={styles.mutedText}>{state.response}</Text>;
            }
            return <MarkdownView markdown={state.response} sessionId={sessionId} />;
    }
}

function describeNotice(notice: SideQuestionNotice): string {
    switch (notice) {
        case 'local':
            return t('sideQuestion.terminalMode');
        case 'not-started':
            return t('sideQuestion.notStarted');
        case 'cli-outdated':
            return t('sideQuestion.cliOutdated');
        case 'offline':
            return t('sideQuestion.offline');
    }
}

const styles = StyleSheet.create((theme) => ({
    overlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        paddingHorizontal: 16,
        zIndex: 990,
    },
    // Carries the shadow, which the clipped panel inside would cut off
    card: {
        width: '100%',
        maxWidth: 560,
        borderRadius: 16,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.18,
        shadowRadius: 18,
    },
    panel: {
        flexShrink: 1,
        minHeight: 0,
        // Opaque wherever there is no blur, since the chat now shows through
        backgroundColor: Platform.select({
            ios: theme.colors.glass.overlay,
            default: theme.colors.surface,
        }),
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: Platform.select({
            ios: theme.colors.glass.border,
            default: theme.colors.divider,
        }),
        elevation: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    headerText: {
        flex: 1,
    },
    title: {
        fontSize: 17,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 4,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    closeButton: {
        padding: 2,
    },
    thread: {
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
    },
    threadContent: {
        paddingHorizontal: 20,
        paddingVertical: 12,
        gap: 16,
    },
    exchange: {
        gap: 8,
    },
    questionBubble: {
        alignSelf: 'flex-end',
        maxWidth: '90%',
        backgroundColor: theme.colors.userMessageBackground,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
    },
    questionText: {
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.text,
    },
    answering: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    mutedText: {
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.textSecondary,
    },
    failedText: {
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.textDestructive,
    },
    composer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    input: {
        flex: 1,
        height: 40,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 12,
        fontSize: 15,
        color: theme.colors.text,
        backgroundColor: theme.colors.input.background,
    },
    sendButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
    disabled: {
        opacity: 0.4,
    },
    pressed: {
        opacity: 0.7,
    },
    answerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 18,
    },
    forkAction: {
        height: 20,
        justifyContent: 'center',
    },
}));
