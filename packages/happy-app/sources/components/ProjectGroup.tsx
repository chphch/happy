import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ProjectGroupData, ProjectWorkspaceGroup, useIsProjectStarred, useLocalSettingMutable, useSetting, storage } from '@/sync/storage';
import { projectWorkspaceCollapseKey } from '@/sync/projectGroups';
import { orderSessionRowsByForkLineage } from '@/utils/forkLineage';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';
import { Avatar } from './Avatar';
import { requestHomeDockFocus } from './homeDockFocus';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { getRepoPath, isWorktreePath } from '@/utils/worktreePaths';

interface ProjectGroupProps {
    project: ProjectGroupData;
    selectedSessionId?: string;
}

/**
 * One project and its sessions, split into the primary checkout and any named
 * worktrees reported by Rig or created through Happy. Each worktree gets its
 * own header and card: the worktree name reads as a second line under the
 * project, so the card itself stays a plain list of sessions.
 */
export const ProjectGroup = React.memo(({ project, selectedSessionId }: ProjectGroupProps) => {
    const styles = stylesheet;

    // Only path-grouped cards are starrable: the star key is machine-and-path,
    // and Rig projects have a durable id instead of one working directory.
    const starProjectsEnabled = useSetting('expStarProjects');
    // Star the repo, not the worktree: every worktree of a repo shares its star,
    // and the store keys stars on the path it is handed verbatim.
    const starPath = project.path ? getRepoPath(project.path) : null;
    const canStar = starProjectsEnabled && !!project.machineId && !!starPath;
    const isStarred = useIsProjectStarred(project.machineId, starPath);
    const handleToggleStar = React.useCallback(() => {
        if (!project.machineId || !starPath) return;
        storage.getState().toggleProjectStarred(project.machineId, starPath);
    }, [project.machineId, starPath]);

    return (
        <View style={styles.container}>
            {project.workspaces.map((workspace, index) => (
                <WorkspaceSection
                    key={workspace.id || 'primary'}
                    project={project}
                    workspace={workspace}
                    selectedSessionId={selectedSessionId}
                    showStar={canStar && index === 0}
                    isStarred={isStarred}
                    onToggleStar={handleToggleStar}
                />
            ))}
        </View>
    );
});

const WorkspaceSection = React.memo(({ project, workspace, selectedSessionId, showStar, isStarred, onToggleStar }: {
    project: ProjectGroupData;
    workspace: ProjectWorkspaceGroup;
    selectedSessionId?: string;
    // The star belongs to the project, so only the first section renders one.
    showStar?: boolean;
    isStarred?: boolean;
    onToggleStar?: () => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const firstSession = workspace.sessions[0];
    // The primary checkout is the project itself, so naming it twice adds
    // nothing. Only a real worktree earns the second line.
    const worktreeName = workspace.name ?? (workspace.id || null);

    // Collapsing follows the header, and the header is per checkout: a project
    // with three worktrees renders four of these sections, so one toggle folds
    // exactly the card it sits on rather than every checkout of the project.
    const collapseKey = projectWorkspaceCollapseKey(project.id, workspace.id);
    const [collapsedProjects, setCollapsedProjects] = useLocalSettingMutable('collapsedProjects');
    const collapsed = !!collapsedProjects[collapseKey];
    const toggleCollapsed = React.useCallback(() => {
        setCollapsedProjects({ ...collapsedProjects, [collapseKey]: !collapsed });
    }, [collapsed, collapsedProjects, collapseKey, setCollapsedProjects]);

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
    const expForkNesting = useSetting('expForkNesting');
    const sessions = React.useMemo(
        () => (expForkNesting ? orderSessionRowsByForkLineage(workspace.sessions) : workspace.sessions),
        [expForkNesting, workspace.sessions],
    );

    return (
        <View style={styles.section}>
            <View style={styles.header}>
                <Pressable
                    onPress={toggleCollapsed}
                    hitSlop={{ top: 8, bottom: 8 }}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: !collapsed }}
                    accessibilityLabel={worktreeName ? `${project.name} / ${worktreeName}` : project.name}
                    style={styles.headerPress}
                >
                    <Ionicons
                        name={collapsed ? 'chevron-forward' : 'chevron-down'}
                        size={14}
                        color={theme.colors.textSecondary}
                    />
                    {firstSession && (
                        <Avatar id={firstSession.avatarId} size={24} flavor={null} />
                    )}
                    <View style={styles.headerText}>
                        <Text style={styles.title} numberOfLines={1}>
                            {project.name}
                        </Text>
                        {worktreeName && (
                            <View style={styles.worktreeRow}>
                                <Text style={styles.worktreeTitle} numberOfLines={1}>
                                    {worktreeName}
                                </Text>
                                <MaterialCommunityIcons
                                    name="source-branch"
                                    size={11}
                                    color={theme.colors.textSecondary}
                                />
                            </View>
                        )}
                    </View>
                    {collapsed && (
                        <Text style={styles.count}>
                            {workspace.sessions.length}
                        </Text>
                    )}
                </Pressable>
                {showStar && (
                    <Pressable
                        onPress={onToggleStar}
                        hitSlop={{ top: 15, bottom: 15, left: 8, right: 8 }}
                        style={styles.starButton}
                        accessibilityRole="button"
                        accessibilityLabel={isStarred ? t('common.unstar') : t('common.star')}
                    >
                        <Ionicons
                            name={isStarred ? 'star' : 'star-outline'}
                            size={14}
                            // Not theme.colors.warning — that is #8E8E93 (grey), which
                            // makes a starred project indistinguishable by colour.
                            color={isStarred ? '#f5a623' : theme.colors.textSecondary}
                        />
                    </Pressable>
                )}
                <Pressable
                    onPress={handleNewSession}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.newSession')}
                    style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
                >
                    <Ionicons name="add" size={20} color={theme.colors.textSecondary} />
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
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        gap: 8,
    },
    headerPress: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
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
    starButton: {
        padding: 4,
    },
    worktreeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    worktreeTitle: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    addButton: {
        width: 28,
        height: 28,
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
