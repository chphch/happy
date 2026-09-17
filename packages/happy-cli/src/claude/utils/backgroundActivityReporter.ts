/**
 * Owns what happy-cli knows about a session's background work, and answers the
 * app's two different questions about it.
 *
 * The Stop hook is the only place the task list exists, and it fires at turn
 * end. That gives two surfaces with deliberately different freshness:
 *
 * - **`metadata.activity`** — published on every Stop, small enough to ride in
 *   an encrypted blob rewritten under optimistic concurrency. It is what the
 *   session list and the activity bar render without asking anything.
 * - **`background-activity-detail` RPC** — served on demand while the app has
 *   the sheet open. The task *list* is still as of the last turn end (nothing
 *   else knows it), but the progress is re-read from disk on every call, so a
 *   workflow's agent count moves while the user watches.
 *
 * Keeping both here means `runClaude` wires two callbacks instead of holding
 * this state itself.
 */

import { logger } from '@/ui/logger';
import {
    activityEquals,
    isActivityEmpty,
    summarizeBackgroundTasks,
    taskKind,
    toActivityItems,
    truncate,
    type BackgroundTaskItem,
    type BackgroundTaskKind,
    type BackgroundTaskProgress,
    type BackgroundTaskSummary,
    type SessionActivity,
} from './backgroundActivity';
import {
    collectProgress,
    findWorkflowRunDir,
    readSubagentSnapshot,
    readWorkflowJournal,
    sessionDirForTranscript,
    type TaskJournalFacts,
    type WorkflowAgentEntry,
} from './backgroundJournal';

/** A single task, as the detail sheet shows it. Untruncated, unlike the metadata item. */
export interface BackgroundTaskDetail {
    id: string;
    kind: BackgroundTaskKind;
    status: string;
    title: string;
    /** shell: the full command; subagent: its agent type; workflow: its script name. */
    detail?: string;
    startedAt?: number;
    progress?: BackgroundTaskProgress;
    /** workflow only: every sub-agent it has launched so far. */
    agents?: WorkflowAgentEntry[];
    /** subagent only: the newest thing it said. */
    latestText?: string;
    /**
     * Why there is no deeper content, when there is none to be had. A stable
     * code rather than a sentence: the app is localized and happy-cli is not,
     * so prose written here would reach the user in English whatever their
     * language setting says.
     */
    note?: BackgroundTaskNote;
}

/** The reasons a task can have nothing deeper to show. */
export type BackgroundTaskNote =
    | 'workflow-unnamed'
    | 'workflow-journal-missing'
    | 'subagent-no-transcript';

export interface BackgroundActivityDetailResult {
    /** When the task list itself was last known — i.e. the last turn end. */
    listedAt: number;
    items: BackgroundTaskDetail[];
}

const MAX_LATEST_TEXT_CHARS = 2000;

export class BackgroundActivityReporter {
    /** Task id → when this process first saw it. The hook carries no timestamp. */
    private readonly firstSeenAt = new Map<string, number>();
    private tasks: BackgroundTaskSummary[] = [];
    private transcriptPath: string | undefined;
    private listedAt = 0;
    private lastPublished: SessionActivity | undefined;

    /**
     * Fold a Stop hook's task list into `metadata.activity`.
     *
     * Returns the activity to publish, or `null` when it is byte-for-byte what
     * was published last — metadata writes are read-modify-write against the
     * server, so re-sending an unchanged summary on every idle turn is churn.
     */
    async onTasks(tasks: BackgroundTaskSummary[], transcriptPath?: string): Promise<SessionActivity | undefined | null> {
        this.tasks = tasks;
        this.listedAt = Date.now();
        if (transcriptPath) this.transcriptPath = transcriptPath;

        const seen = new Set(tasks.map((task) => task.id));
        for (const id of this.firstSeenAt.keys()) {
            if (!seen.has(id)) this.firstSeenAt.delete(id);
        }
        for (const task of tasks) {
            if (!this.firstSeenAt.has(task.id)) this.firstSeenAt.set(task.id, this.listedAt);
        }

        let facts = new Map<string, TaskJournalFacts>();
        try {
            facts = await collectProgress(this.transcriptPath, tasks);
        } catch (error) {
            logger.debug(`[backgroundActivity] progress read failed: ${error}`);
        }

        const activity = summarizeBackgroundTasks(tasks);
        const items = toActivityItems(tasks, this.firstSeenAt, facts);
        if (items.length > 0) activity.items = items;

        if (activityEquals(activity, this.lastPublished)) return null;
        this.lastPublished = activity;
        // Absent rather than an all-zero object once nothing is running, so a
        // session with no background work carries no activity field at all.
        return isActivityEmpty(activity) ? undefined : activity;
    }

    /**
     * Answer the detail RPC by re-reading the journals now.
     *
     * The task list is whatever the last Stop hook reported — no other source
     * knows it — so `listedAt` is returned alongside and the app says how old
     * the list is rather than implying it is live.
     */
    async detail(): Promise<BackgroundActivityDetailResult> {
        const sessionDir = sessionDirForTranscript(this.transcriptPath);
        const items: BackgroundTaskDetail[] = [];

        for (const task of this.tasks) {
            const kind = taskKind(task.type);
            const base: BackgroundTaskDetail = {
                id: task.id,
                kind,
                status: task.status,
                title: task.description ?? task.name ?? task.type,
                startedAt: this.firstSeenAt.get(task.id),
            };

            if (kind === 'shell') {
                // No note: that a background shell's output is unreadable from
                // here is true of every one of them, so the app states it from
                // the kind alone and still states it while offline.
                base.detail = task.command;
            } else if (kind === 'subagent') {
                base.detail = task.agent_type ?? task.subagent_type;
            } else if (kind === 'workflow') {
                base.detail = task.name;
            }

            if (sessionDir) {
                try {
                    await this.enrich(base, task, kind, sessionDir);
                } catch (error) {
                    logger.debug(`[backgroundActivity] detail read failed for ${task.id}: ${error}`);
                }
            }
            items.push(base);
        }

        return { listedAt: this.listedAt, items };
    }

    private async enrich(
        target: BackgroundTaskDetail,
        task: BackgroundTaskSummary,
        kind: BackgroundTaskKind,
        sessionDir: string,
    ): Promise<void> {
        if (kind === 'workflow') {
            if (!task.name) {
                target.note = 'workflow-unnamed';
                return;
            }
            const runDir = await findWorkflowRunDir(sessionDir, task.name);
            const journal = runDir ? await readWorkflowJournal(runDir) : null;
            if (!journal) {
                target.note = 'workflow-journal-missing';
                return;
            }
            target.agents = journal.agents;
            const done = journal.agents.filter((agent) => agent.done).length;
            const pending = journal.agents.filter((agent) => !agent.done);
            target.progress = {
                done,
                total: journal.agents.length,
                phase: pending[0]?.phase ?? journal.agents[journal.agents.length - 1]?.phase,
                latest: pending[pending.length - 1]?.label,
                updatedAt: journal.updatedAt,
            };
            return;
        }

        if (kind === 'subagent') {
            const snapshot = await readSubagentSnapshot(sessionDir, task.id);
            if (!snapshot) {
                target.note = 'subagent-no-transcript';
                return;
            }
            target.detail = snapshot.agentType ?? target.detail;
            if (!task.description && snapshot.description) target.title = snapshot.description;
            target.progress = { done: snapshot.turns, updatedAt: snapshot.updatedAt };
            if (snapshot.latestText) {
                target.latestText = truncate(snapshot.latestText, MAX_LATEST_TEXT_CHARS);
            }
        }
    }
}

export type { BackgroundTaskItem };
