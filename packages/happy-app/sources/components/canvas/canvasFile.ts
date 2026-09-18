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
 */
import type { Metadata } from '@/sync/storageTypes';

export const CANVAS_RELATIVE_PATH = '.claude/canvas.md';

/**
 * Returns the absolute canvas path for a session, or null when the session has
 * no working directory to anchor it to (nothing to open, rather than a guess).
 */
export function canvasPathFor(metadata: Metadata | null | undefined): string | null {
    const cwd = metadata?.path;
    if (!cwd || typeof cwd !== 'string' || cwd.length === 0) return null;
    return `${cwd.replace(/\/+$/, '')}/${CANVAS_RELATIVE_PATH}`;
}
