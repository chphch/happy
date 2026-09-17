/**
 * One in-flight background task, as the background-work screen draws it.
 *
 * Each kind can say a different amount, and the card shows exactly what that
 * kind actually knows rather than a uniform row with blanks in it:
 *
 * - a **workflow** knows how many sub-agents it launched and how many returned,
 *   so it gets a real bar and an expandable list;
 * - a **backgrounded agent** knows how much it has said but not how much is
 *   left, so it gets a turn count and its latest sentence — never a bar, which
 *   would invent a finish line;
 * - a **background shell** keeps its output inside Claude Code, so it gets its
 *   command and an honest note that the output is not readable from here.
 */

import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    progressFraction,
    type BackgroundTaskDetail,
    type BackgroundWorkflowAgent,
} from '@/sync/backgroundActivity';
import {
    agentsForCollapsedView,
    formatElapsed,
    formatLastMovement,
    iconForKind,
    isRunningStatus,
    looksStalled,
} from '@/utils/backgroundActivityFormat';

/** How many sub-agents a collapsed workflow card lists before "show more". */
const COLLAPSED_AGENT_LIMIT = 4;

/**
 * The explanatory line under a task.
 *
 * A shell's is derived from its kind rather than sent by the agent: it is true
 * of every background shell, so deriving it keeps one owner for the string and
 * keeps it on screen when the session is offline and only metadata is available.
 * The rest describe a particular task's state, so they can only come from the agent.
 */
function noteText(task: BackgroundTaskDetail): string | null {
    if (task.kind === 'shell') return t('backgroundActivity.notes.shellOutputUnavailable');
    switch (task.note) {
        case 'workflow-unnamed': return t('backgroundActivity.notes.workflowUnnamed');
        case 'workflow-journal-missing': return t('backgroundActivity.notes.workflowJournalMissing');
        case 'subagent-no-transcript': return t('backgroundActivity.notes.subagentNoTranscript');
        default: return null;
    }
}

function kindLabel(kind: BackgroundTaskDetail['kind']): string {
    switch (kind) {
        case 'shell': return t('backgroundActivity.kinds.shell');
        case 'subagent': return t('backgroundActivity.kinds.subagent');
        case 'workflow': return t('backgroundActivity.kinds.workflow');
        default: return t('backgroundActivity.kinds.other');
    }
}

const ProgressBar = React.memo(function ProgressBar({ fraction }: { fraction: number }) {
    const { theme } = useUnistyles();
    return (
        <View style={{
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.colors.divider,
            overflow: 'hidden',
            marginTop: 8,
        }}>
            <View style={{
                width: `${Math.round(fraction * 100)}%`,
                height: '100%',
                borderRadius: 2,
                backgroundColor: theme.colors.success,
            }} />
        </View>
    );
});

const AgentRow = React.memo(function AgentRow({ agent }: { agent: BackgroundWorkflowAgent }) {
    const { theme } = useUnistyles();
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 }}>
            <Ionicons
                name={agent.done ? 'checkmark-circle' : 'ellipse-outline'}
                size={13}
                color={agent.done ? theme.colors.success : theme.colors.textSecondary}
            />
            <Text
                numberOfLines={1}
                style={{
                    flex: 1,
                    fontSize: 12,
                    color: agent.done ? theme.colors.textSecondary : theme.colors.text,
                    ...Typography.default(),
                }}
            >
                {agent.label}
            </Text>
            {agent.phase ? (
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {agent.phase}
                </Text>
            ) : null}
        </View>
    );
});

export const BackgroundTaskCard = React.memo(function BackgroundTaskCard({
    task,
    now,
}: {
    task: BackgroundTaskDetail;
    now: number;
}) {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const [copied, setCopied] = React.useState(false);

    const onCopy = React.useCallback(async () => {
        if (!task.detail) return;
        await Clipboard.setStringAsync(task.detail);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [task.detail]);

    const running = isRunningStatus(task.status);
    const elapsed = formatElapsed(task, now);
    const lastMovement = formatLastMovement(task, now);
    const stalled = running && looksStalled(task, now);
    const fraction = progressFraction(task);
    const note = noteText(task);
    const agents = task.agents;
    // Collapsed shows what is still working; expanded keeps launch order, which
    // reads as a progress list with the phases in sequence.
    const visibleAgents = agents && (expanded ? agents : agentsForCollapsedView(agents, COLLAPSED_AGENT_LIMIT));

    return (
        <View style={{
            backgroundColor: theme.colors.surface,
            borderRadius: 12,
            padding: 14,
            marginHorizontal: 16,
            marginTop: 10,
        }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <Ionicons
                    name={iconForKind(task.kind) as never}
                    size={17}
                    color={running ? theme.colors.text : theme.colors.textSecondary}
                    style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {task.title}
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 2, ...Typography.default() }}>
                        {kindLabel(task.kind)}
                        {task.kind !== 'shell' && task.detail ? ` · ${task.detail}` : ''}
                        {running ? '' : ` · ${t('backgroundActivity.queued')}`}
                    </Text>
                </View>
                {elapsed ? (
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {elapsed}
                    </Text>
                ) : null}
            </View>

            {task.kind === 'shell' && task.detail ? (
                <View style={{
                    backgroundColor: theme.colors.surfaceHigh,
                    borderRadius: 8,
                    padding: 10,
                    marginTop: 10,
                }}>
                    <Text
                        numberOfLines={expanded ? undefined : 4}
                        style={{ fontSize: 12, color: theme.colors.text, ...Typography.mono() }}
                    >
                        {task.detail}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 }}>
                        <Pressable onPress={onCopy} hitSlop={8}>
                            <Text style={{ fontSize: 12, color: theme.colors.textLink, ...Typography.default() }}>
                                {copied ? t('backgroundActivity.copied') : t('backgroundActivity.copyCommand')}
                            </Text>
                        </Pressable>
                        {task.truncated ? (
                            // Say it rather than trailing off: a command can end in
                            // an ellipsis, so the character alone proves nothing.
                            <Text style={{ fontSize: 12, color: theme.colors.textSecondary, flex: 1, ...Typography.default() }}>
                                {t('backgroundActivity.shortened')}
                            </Text>
                        ) : null}
                    </View>
                </View>
            ) : null}

            {fraction !== null ? <ProgressBar fraction={fraction} /> : null}

            {task.progress ? (
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 6, ...Typography.default() }}>
                    {task.progress.total !== undefined
                        ? t('backgroundActivity.agentsDone', { done: task.progress.done, total: task.progress.total })
                        : t('backgroundActivity.turns', { count: task.progress.done })}
                    {task.progress.phase ? ` · ${task.progress.phase}` : ''}
                    {lastMovement ? ` · ${t('backgroundActivity.lastMoved', { ago: lastMovement })}` : ''}
                </Text>
            ) : null}

            {stalled ? (
                <Text style={{ fontSize: 12, color: theme.colors.warningCritical, marginTop: 4, ...Typography.default() }}>
                    {t('backgroundActivity.stalled')}
                </Text>
            ) : null}

            {task.latestText ? (
                <Text
                    numberOfLines={expanded ? undefined : 3}
                    style={{ fontSize: 13, color: theme.colors.text, marginTop: 8, ...Typography.default() }}
                >
                    {task.latestText}
                </Text>
            ) : null}

            {visibleAgents && visibleAgents.length > 0 ? (
                <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.divider, paddingTop: 6 }}>
                    {visibleAgents.map((agent) => <AgentRow key={agent.agentId} agent={agent} />)}
                </View>
            ) : null}

            {note ? (
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 8, ...Typography.default() }}>
                    {note}
                </Text>
            ) : null}

            {(agents && agents.length > COLLAPSED_AGENT_LIMIT) || task.latestText || (task.kind === 'shell' && task.detail) ? (
                <Pressable
                    onPress={() => setExpanded((value) => !value)}
                    hitSlop={8}
                    style={{ marginTop: 8 }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.textLink, ...Typography.default() }}>
                        {expanded ? t('backgroundActivity.showLess') : t('backgroundActivity.showMore')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});
