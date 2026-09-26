import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ProjectGroupData, ProjectWorkspaceGroup, useLocalSettingMutable, useSessionGitStatus } from '@/sync/storage';
import { projectCollapseKey, projectWorkspaceCollapseKey } from '@/sync/projectGroups';
import { orderSessionRowsByForkLineage } from '@/utils/forkLineage';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';
import { Avatar } from './Avatar';
import { requestHomeDockFocus } from './homeDockFocus';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { visibleRigGitLineChanges } from '@/utils/rigGitLineChanges';
import { GitLineChanges } from './GitLineChanges';
import { getRepoPath, isWorktreePath } from '@/utils/worktreePaths';
import { openProjectOrderEditor } from './ProjectOrderEditor';

// Tall enough to span the name and branch lines together.
const HEADER_AVATAR_SIZE = 30;
// Roughly 70% of the composer attachment "+": same feel, less presence in a
// list header. hitSlop keeps the touch target comfortable.
const ADD_BUTTON_SIZE = 30;
const ADD_ICON_SIZE = 18;

interface ProjectGroupProps {
    project: ProjectGroupData;
    selectedSessionId?: string;
    /**
     * Fold the project as one unit instead of one checkout at a time. The
     * first checkout's header carries the only chevron and it hides every
     * checkout, which is how the list folded before it was rebuilt around
     * worktrees. The other headers keep their name and `+` but lose the
     * chevron, so there is never more than one fold control per project.
     */
    foldWholeProject?: boolean;
}

/** What the header at the top of one checkout does about folding. */
type SectionFold =
    | { chevron: false }
    | { chevron: true; collapsed: boolean; count: number; onToggle: () => void };

/**
 * One project and its sessions, split into the primary checkout and any named
 * worktrees reported by Rig or created through Happy. Each worktree gets its
 * own header and card: the worktree name reads as a second line under the
 * project, so the card itself stays a plain list of sessions.
 */
export const ProjectGroup = React.memo(({ project, selectedSessionId, foldWholeProject = false }: ProjectGroupProps) => {
    const styles = stylesheet;

    // Folding state lives here, not in the section, because the whole-project
    // mode needs one decision for every checkout — and reading the setting once
    // per project beats one subscription per checkout either way.
    const [collapsedProjects, setCollapsedProjects] = useLocalSettingMutable('collapsedProjects');
    const setCollapsed = React.useCallback((key: string, collapsed: boolean) => {
        setCollapsedProjects({ ...collapsedProjects, [key]: collapsed });
    }, [collapsedProjects, setCollapsedProjects]);

    const wholeProjectKey = projectCollapseKey(project.id);
    const wholeProjectCollapsed = foldWholeProject && !!collapsedProjects[wholeProjectKey];
    const totalSessions = React.useMemo(
        () => project.workspaces.reduce((total, workspace) => total + workspace.sessions.length, 0),
        [project.workspaces],
    );

    // Collapsed as one project: only the header that carries the chevron stays
    // on screen, so the whole project reads as a single folded row.
    const workspaces = wholeProjectCollapsed ? project.workspaces.slice(0, 1) : project.workspaces;

    const foldFor = (workspace: ProjectWorkspaceGroup, index: number): SectionFold => {
        if (foldWholeProject) {
            if (index > 0) return { chevron: false };
            return {
                chevron: true,
                collapsed: wholeProjectCollapsed,
                count: totalSessions,
                onToggle: () => setCollapsed(wholeProjectKey, !wholeProjectCollapsed),
            };
        }
        const key = projectWorkspaceCollapseKey(project.id, workspace.id);
        const collapsed = !!collapsedProjects[key];
        return {
            chevron: true,
            collapsed,
            count: workspace.sessions.length,
            onToggle: () => setCollapsed(key, !collapsed),
        };
    };

    return (
        <View style={styles.container}>
            {workspaces.map((workspace, index) => (
                <WorkspaceSection
                    key={workspace.id || 'primary'}
                    project={project}
                    workspace={workspace}
                    selectedSessionId={selectedSessionId}
                    fold={foldFor(workspace, index)}
                    showReorder={index === 0}
                />
            ))}
        </View>
    );
});

const WorkspaceSection = React.memo(({ project, workspace, selectedSessionId, fold, showReorder = false }: {
    project: ProjectGroupData;
    workspace: ProjectWorkspaceGroup;
    fold: SectionFold;
    selectedSessionId?: string;
    // The order belongs to the project, so only its first header offers it.
    showReorder?: boolean;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const firstSession = workspace.sessions[0];
    const worktreeName = workspace.name ?? (workspace.id || null);

    // The branch line belongs to the checkout, so it reads from the live git
    // status the daemon reports, through the workspace's own name, down to the
    // "main" every repo has when nothing better is known.
    const gitStatus = useSessionGitStatus(firstSession?.id ?? '');
    const branchName = worktreeName
        ?? gitStatus?.branch
        ?? 'main';
    const liveInsertions = gitStatus?.unstagedLinesAdded ?? 0;
    const liveDeletions = gitStatus?.unstagedLinesRemoved ?? 0;
    const changes = liveInsertions > 0 || liveDeletions > 0
        ? { approximate: false, insertions: liveInsertions, deletions: liveDeletions }
        : firstSession && firstSession.gitChangedFiles !== null
            ? visibleRigGitLineChanges({
                changedFiles: firstSession.gitChangedFiles,
                countsExact: firstSession.gitCountsExact,
                deletions: firstSession.gitDeletions ?? 0,
                insertions: firstSession.gitInsertions ?? 0,
            })
            : null;

    // What folding means here is decided by the parent: per checkout (a project
    // with three worktrees renders four of these sections, each folding the card
    // it sits on) or per project (only the first header has a chevron and it
    // folds all of them).
    const collapsed = fold.chevron && fold.collapsed;

    // Point the draft at this exact checkout before opening the composer, so
    // the dock's machine, project and worktree rows already read correctly.
    // `setMachineId` clears the path and worktree, so the order matters.
    const handleNewSession = React.useCallback(() => {
        const draft = useNewSessionDraft.getState();
        const sessionPath = firstSession?.path ?? '';
        const worktree = isWorktreePath(sessionPath);
        const repoPath = worktree ? getRepoPath(sessionPath) : sessionPath;

        if (firstSession?.machineId) {
            draft.setMachineId(firstSession.machineId);
        }
        if (repoPath) {
            draft.setPath(formatPathRelativeToHome(repoPath, firstSession?.homeDir ?? undefined));
        }
        draft.setSessionType(worktree ? 'worktree' : 'simple');
        draft.setWorktreeKey(worktree ? sessionPath : null);

        // Nothing is listening in the sidebar layout or on web, where the dock
        // is never mounted; those fall back to the standalone screen.
        if (!requestHomeDockFocus()) {
            router.navigate('/new');
        }
    }, [firstSession, router]);

    // Nesting runs here, not where the list data is built: the list is filtered
    // after that (archive toggle, search box), and a depth stamped before the
    // filter leaves a child indented under a parent that is no longer on screen.
    // What this section receives is exactly what renders.
    const sessions = React.useMemo(
        () => orderSessionRowsByForkLineage(workspace.sessions),
        [workspace.sessions],
    );

    // Opens the dialog that arranges the project cards, on this one. Besides
    // the button, the header itself opens it: a long press on a phone, a right
    // click on the web — the same gestures that open a session row's menu.
    const openReorder = React.useCallback(() => {
        openProjectOrderEditor(project.id);
    }, [project.id]);
    const reorderGestureProps = !showReorder
        ? {}
        : Platform.OS === 'web'
            ? {
                onContextMenu: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
                    event.preventDefault?.();
                    event.stopPropagation?.();
                    openReorder();
                },
            } as any
            : { onLongPress: openReorder };

    return (
        <View style={styles.section}>
            <View style={styles.header}>
                <Pressable
                    {...reorderGestureProps}
                    onPress={fold.chevron ? fold.onToggle : undefined}
                    disabled={!fold.chevron}
                    hitSlop={{ top: 8, bottom: 8 }}
                    accessibilityRole={fold.chevron ? 'button' : 'header'}
                    accessibilityState={fold.chevron ? { expanded: !collapsed } : undefined}
                    accessibilityLabel={worktreeName ? `${project.name} / ${worktreeName}` : project.name}
                    style={styles.headerPress}
                >
                    {fold.chevron ? (
                        <Ionicons
                            name={collapsed ? 'chevron-forward' : 'chevron-down'}
                            size={14}
                            color={theme.colors.textSecondary}
                        />
                    ) : (
                        // Keeps every header's name on the same left edge, with
                        // or without a chevron.
                        <View style={styles.chevronSpacer} />
                    )}
                    {firstSession && (
                        <Avatar id={firstSession.avatarId} size={HEADER_AVATAR_SIZE} flavor={null} imageUrl={firstSession.projectAvatarUri} thumbhash={firstSession.projectAvatarThumbhash} />
                    )}
                    <View style={styles.headerText}>
                        <Text style={styles.title} numberOfLines={1}>
                            {project.name}
                        </Text>
                        <View style={styles.branchLine}>
                            <Text style={styles.branchText} numberOfLines={1}>
                                {branchName}
                            </Text>
                            <GitLineChanges changes={changes} />
                        </View>
                    </View>
                    {collapsed && fold.chevron && (
                        <Text style={styles.count}>
                            {fold.count}
                        </Text>
                    )}
                </Pressable>
                {showReorder && (
                    <Pressable
                        onPress={openReorder}
                        hitSlop={{ top: 15, bottom: 15, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('projectOrder.title')}
                        style={({ pressed }) => [styles.reorderButton, pressed && styles.addButtonPressed]}
                    >
                        <Ionicons name="swap-vertical" size={15} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
                <Pressable
                    onPress={handleNewSession}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.newSession')}
                    style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
                >
                    <Ionicons name="add" size={ADD_ICON_SIZE} color={theme.colors.text} />
                </Pressable>
            </View>

            {!collapsed && (
                <View style={styles.workspaceCard}>
                    {sessions.map((session, index) => (
                        <CompactSessionRow
                            key={session.id}
                            session={session}
                            selected={session.id === selectedSessionId}
                            showBorder={index < workspace.sessions.length - 1}
                        />
                    ))}
                </View>
            )}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: 'transparent',
        marginBottom: 4,
    },
    section: {
        backgroundColor: 'transparent',
    },
    // Pulled toward the screen edges: the "+" sits so its center shares an x
    // with the status dot inside the card rows below (see
    // trailingIndicatorSlot in ActiveSessionsGroupCompact). The right inset
    // compensates for the button being narrower than it once was.
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingLeft: Platform.select({ ios: 20, default: 16 }),
        paddingRight: Platform.select({ ios: 26, default: 22 }),
        gap: 8,
    },
    headerPress: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    // Same width as the chevron so a header without one still lines its name up
    // with the headers that have it.
    chevronSpacer: {
        width: 14,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    count: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    title: {
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        ...Typography.default('regular'),
    },
    reorderButton: {
        padding: 4,
    },
    branchLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    branchText: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    // Filled like the composer's resting send button so it reads as a control,
    // not an ornament.
    addButton: {
        width: ADD_BUTTON_SIZE,
        height: ADD_BUTTON_SIZE,
        borderRadius: ADD_BUTTON_SIZE / 2,
        backgroundColor: theme.colors.surfaceHighest,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addButtonPressed: {
        opacity: 0.5,
    },
    workspaceCard: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        marginBottom: 8,
        borderRadius: Platform.select({ web: 16, default: 18 }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
        overflow: 'hidden',
        shadowColor: Platform.select({ web: theme.colors.shadow.color, default: 'transparent' }),
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: Platform.select({ web: theme.colors.shadow.opacity, default: 0 }),
        shadowRadius: 0,
        elevation: Platform.select({ web: 1, default: 0 }),
    },
}));
