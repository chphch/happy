/**
 * Where a session's canvas document lives.
 *
 * A convention rather than a stored setting, on purpose: the agent writes the
 * file and the panel finds it, so nothing has to travel from the agent to the
 * app to open a canvas. That removes the one piece of plumbing this feature
 * would otherwise need.
 *
 * `.claude/` beside the project is the same place this box already keeps
 * per-project agent state (`.claude/task-tree.md`), so a canvas lands where a
 * reader would look for it.
 *
 * One file per session, keyed by the Claude session id. Two sessions in the
 * same folder are usually working on different things, and a shared file let
 * them overwrite each other's document. The Claude id is the key because both
 * sides already know it without new plumbing: the agent gets it as
 * `CLAUDE_CODE_SESSION_ID` and the app gets it as `metadata.claudeSessionId`.
 * The Happy session id would be steadier, but nothing hands it to the agent.
 */
import type { Metadata } from '@/sync/storageTypes';

export const CANVAS_DIR_RELATIVE_PATH = '.claude/canvas';

/**
 * The one-per-folder file used before canvases were per session. Still the
 * canvas for sessions with no Claude id — other agents, or a Claude session
 * whose id has not been reported yet.
 */
export const SHARED_CANVAS_RELATIVE_PATH = '.claude/canvas.md';

// The id becomes a file name, so accept only what a Claude session id looks
// like rather than trusting metadata with a path separator.
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Returns the absolute canvas path for a session, or null when the session has
 * no working directory to anchor it to (nothing to open, rather than a guess).
 */
export function canvasPathFor(metadata: Metadata | null | undefined): string | null {
    const cwd = metadata?.path;
    if (!cwd || typeof cwd !== 'string' || cwd.length === 0) return null;
    const root = cwd.replace(/\/+$/, '');
    const id = metadata?.claudeSessionId;
    if (typeof id === 'string' && SESSION_ID_PATTERN.test(id)) {
        return `${root}/${CANVAS_DIR_RELATIVE_PATH}/${id}.md`;
    }
    return `${root}/${SHARED_CANVAS_RELATIVE_PATH}`;
}
