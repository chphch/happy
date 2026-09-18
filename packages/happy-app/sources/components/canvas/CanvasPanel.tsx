/**
 * The canvas: one document kept beside the chat, edited by both the person and
 * the agent.
 *
 * The document is an ordinary file on the session's machine, so there is no new
 * store, no new sync layer and no new encryption — the agent edits it with the
 * tools it already has, and this panel reads and writes it over the file RPC the
 * app already has.
 *
 * Edits save themselves. That is the whole point of the feature: the person
 * changes a paragraph, says what they want in the chat, and the agent reads the
 * changed file on its next turn. Nothing has to ride along with their message,
 * and nothing is lost by not pressing a button.
 *
 * Both platforms use the same plain multiline input. A prose document does not
 * need syntax colouring, and dropping the web-only editor removes the platform
 * fork that made file editing unavailable on the phone in the first place.
 */
import * as React from 'react';
import { View, TextInput, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useSession } from '@/sync/storage';
import { rigCanWriteFiles } from '@/sync/rig';
import { useRemoteFile } from '@/hooks/useRemoteFile';
import { t } from '@/text';
import { canvasPathFor } from './canvasFile';

/** Idle time after the last keystroke before the edit is written to the machine. */
const AUTOSAVE_IDLE_MS = 1200;

type SaveState = 'clean' | 'pending' | 'saving' | 'saved' | 'conflict' | 'failed';

export const CanvasPanel = React.memo(function CanvasPanel(props: {
    sessionId: string;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const canWrite = rigCanWriteFiles(session?.metadata);
    const filePath = canvasPathFor(session?.metadata);

    const file = useRemoteFile(props.sessionId, filePath, {
        readErrorMessage: t('canvas.notCreatedYet'),
    });
    const [mode, setMode] = React.useState<'edit' | 'preview'>('edit');
    const [saveState, setSaveState] = React.useState<SaveState>('clean');

    // Autosave. The timer is keyed on the text, so every keystroke pushes the
    // write out; it lands once typing pauses.
    const savingRef = React.useRef(false);
    React.useEffect(() => {
        if (!canWrite || !file.hasChanges) return;
        setSaveState('pending');
        const timer = setTimeout(async () => {
            if (savingRef.current) return;
            savingRef.current = true;
            setSaveState('saving');
            try {
                const res = await file.save();
                setSaveState(res.ok ? 'saved' : res.conflict ? 'conflict' : 'failed');
            } finally {
                savingRef.current = false;
            }
        }, AUTOSAVE_IDLE_MS);
        return () => clearTimeout(timer);
    }, [file.editContent, file.hasChanges, canWrite, file.save]);

    // A save that succeeded stops being news after a moment.
    React.useEffect(() => {
        if (saveState !== 'saved') return;
        const timer = setTimeout(() => setSaveState('clean'), 1800);
        return () => clearTimeout(timer);
    }, [saveState]);

    const statusText = React.useMemo(() => {
        switch (saveState) {
            case 'pending': return t('canvas.statusPending');
            case 'saving': return t('canvas.statusSaving');
            case 'saved': return t('canvas.statusSaved');
            case 'conflict': return t('canvas.statusConflict');
            case 'failed': return t('canvas.statusFailed');
            default: return '';
        }
    }, [saveState]);

    const body = (() => {
        if (!filePath) {
            return <Centered>{t('canvas.noWorkingDirectory')}</Centered>;
        }
        if (file.state.kind === 'loading') {
            return (
                <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            );
        }
        if (file.state.kind === 'error') {
            return <Centered>{t('canvas.notCreatedYet')}</Centered>;
        }
        if (file.state.kind === 'binary' || file.state.kind === 'idle') {
            return <Centered>{t('canvas.cannotEdit')}</Centered>;
        }
        if (mode === 'preview') {
            return (
                <ScrollView style={styles.flex} contentContainerStyle={styles.previewInner}>
                    <MarkdownView markdown={file.editContent} sessionId={props.sessionId} />
                </ScrollView>
            );
        }
        return (
            <TextInput
                style={styles.editor}
                value={file.editContent}
                onChangeText={file.setEditContent}
                editable={canWrite}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical="top"
                placeholder={t('canvas.placeholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                scrollEnabled
            />
        );
    })();

    return (
        <View style={styles.root}>
            <View style={styles.header}>
                <Ionicons name="document-text-outline" size={16} color={theme.colors.textSecondary} />
                <Text style={styles.title} numberOfLines={1}>{t('canvas.title')}</Text>
                {statusText ? <Text style={styles.status} numberOfLines={1}>{statusText}</Text> : null}
                <View style={styles.spacer} />
                <Pressable
                    onPress={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={mode === 'edit' ? t('canvas.showPreview') : t('canvas.showEditor')}
                >
                    <Ionicons
                        name={mode === 'edit' ? 'eye-outline' : 'create-outline'}
                        size={18}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
                <Pressable onPress={props.onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('canvas.close')}>
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            {file.externalChange !== null && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText} numberOfLines={2}>{t('canvas.changedOnDisk')}</Text>
                    <Pressable onPress={file.reload} hitSlop={6}>
                        <Text style={styles.bannerAction}>{t('canvas.reload')}</Text>
                    </Pressable>
                    <Pressable onPress={file.dismissExternalChange} hitSlop={6}>
                        <Text style={styles.bannerAction}>{t('canvas.keepMine')}</Text>
                    </Pressable>
                </View>
            )}

            {body}
        </View>
    );
});

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <View style={styles.centered}>
            <Text style={styles.muted}>{children}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    flex: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    status: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    spacer: { flex: 1 },
    banner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.surfaceHigh,
    },
    bannerText: {
        flex: 1,
        fontSize: 12.5,
        color: theme.colors.text,
    },
    bannerAction: {
        fontSize: 12.5,
        fontWeight: '600',
        color: theme.colors.textLink,
    },
    editor: {
        flex: 1,
        padding: 14,
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
        ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : null),
    },
    previewInner: {
        padding: 14,
        paddingBottom: 40,
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    muted: {
        fontSize: 13.5,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));
