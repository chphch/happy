/**
 * Unit coverage for the 'ultracode' effort wiring:
 *   - toSdkEffort() collapses the Happy-only 'ultracode' level to the SDK's 'xhigh'.
 *   - setSettingsUltracode() flips the `ultracode` flag in the hook settings file
 *     while preserving the SessionStart hook, so the effort drives ultracode mode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toSdkEffort } from '../loop';
import { setSettingsUltracode } from './generateHookSettings';

describe('toSdkEffort', () => {
    it("maps 'ultracode' to the SDK's 'xhigh' thinking level", () => {
        expect(toSdkEffort('ultracode')).toBe('xhigh');
    });

    it("maps 'auto' to undefined (omit the SDK effort option)", () => {
        expect(toSdkEffort('auto')).toBeUndefined();
    });

    it('passes every real SDK effort through unchanged', () => {
        for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
            expect(toSdkEffort(e)).toBe(e);
        }
    });

    it('passes undefined through (SDK default)', () => {
        expect(toSdkEffort(undefined)).toBeUndefined();
    });
});

describe('setSettingsUltracode', () => {
    let dir: string;
    let file: string;
    const base = {
        ultracode: true,
        hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node forwarder.cjs 1234' }] }] },
    };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ultracode-test-'));
        file = join(dir, 'settings.json');
        writeFileSync(file, JSON.stringify(base, null, 2));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('turns the ultracode flag off while preserving the SessionStart hook', () => {
        setSettingsUltracode(file, false);
        const out = JSON.parse(readFileSync(file, 'utf8'));
        expect(out.ultracode).toBe(false);
        expect(out.hooks).toEqual(base.hooks);
    });

    it('turns the ultracode flag back on', () => {
        setSettingsUltracode(file, false);
        setSettingsUltracode(file, true);
        expect(JSON.parse(readFileSync(file, 'utf8')).ultracode).toBe(true);
    });

    it('does not throw on a missing file', () => {
        expect(() => setSettingsUltracode(join(dir, 'nope.json'), true)).not.toThrow();
    });
});
