/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 */

import { join, resolve } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

/**
 * Generate a temporary settings file with SessionStart hook configuration
 * 
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port}`;

    const settings = {
        ultracode: true,
        hooks: {
            SessionStart: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            command: hookCommand
                        }
                    ]
                }
            ]
        }
    };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Toggle the `ultracode` flag inside an already-generated hook settings file,
 * preserving the SessionStart hook. Called per query from claudeRemote so that
 * the 'ultracode' effort (and only that effort) enables Claude Code's ultracode
 * mode — any lower effort turns it off.
 *
 * No-ops when the flag already matches to avoid redundant writes.
 *
 * @param filepath - Path returned by {@link generateHookSettingsFile}
 * @param enabled  - Desired ultracode state for the next Claude query
 */
export function setSettingsUltracode(filepath: string, enabled: boolean): void {
    try {
        const settings = JSON.parse(readFileSync(filepath, 'utf8'));
        if (settings.ultracode === enabled) {
            return;
        }
        settings.ultracode = enabled;
        writeFileSync(filepath, JSON.stringify(settings, null, 2));
        logger.debug(`[generateHookSettings] Set ultracode=${enabled} in ${filepath}`);
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to set ultracode flag: ${error}`);
    }
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}

