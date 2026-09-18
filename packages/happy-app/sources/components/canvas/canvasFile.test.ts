import { describe, it, expect } from 'vitest';
import type { Metadata } from '@/sync/storageTypes';
import { canvasPathFor } from './canvasFile';

function meta(fields: Partial<Metadata>): Metadata {
    return { path: '/work/proj', host: 'box', ...fields } as Metadata;
}

describe('canvasPathFor', () => {
    it('gives each Claude session its own file', () => {
        const a = canvasPathFor(meta({ claudeSessionId: '933059c6-a885-4a09-9bb7-4fb7d4f84a8c' }));
        const b = canvasPathFor(meta({ claudeSessionId: '8a7c6bb7-c94f-4078-ab5a-45fd05b4f19d' }));
        expect(a).toBe('/work/proj/.claude/canvas/933059c6-a885-4a09-9bb7-4fb7d4f84a8c.md');
        expect(b).toBe('/work/proj/.claude/canvas/8a7c6bb7-c94f-4078-ab5a-45fd05b4f19d.md');
    });

    it('falls back to the shared file when there is no Claude session id', () => {
        expect(canvasPathFor(meta({}))).toBe('/work/proj/.claude/canvas.md');
    });

    it('refuses an id that could leave the canvas folder', () => {
        expect(canvasPathFor(meta({ claudeSessionId: '../../etc/passwd' }))).toBe('/work/proj/.claude/canvas.md');
    });

    it('drops a trailing slash on the working directory', () => {
        expect(canvasPathFor(meta({ path: '/work/proj/', claudeSessionId: 'abc' }))).toBe('/work/proj/.claude/canvas/abc.md');
    });

    it('opens nothing without a working directory', () => {
        expect(canvasPathFor(null)).toBeNull();
        expect(canvasPathFor(meta({ path: '' }))).toBeNull();
    });
});
