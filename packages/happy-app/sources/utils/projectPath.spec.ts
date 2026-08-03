import { describe, expect, it } from 'vitest';
import { compareProjectsByStar, projectKey, projectStarKey } from './projectPath';

const proj = (path: string, displayPath = path) => ({ path, displayPath });

describe('projectStarKey', () => {
    it('keys a plain checkout by its own path', () => {
        expect(projectStarKey('m1', '/Users/me/repo')).toBe(projectKey('m1', '/Users/me/repo'));
    });

    it('keys a worktree by its repo, so it inherits the repo star', () => {
        expect(projectStarKey('m1', '/Users/me/repo/.dev/worktree/feature-x'))
            .toBe(projectKey('m1', '/Users/me/repo'));
    });

    it('separates the same path on different machines', () => {
        expect(projectStarKey('m1', '/repo')).not.toBe(projectStarKey('m2', '/repo'));
    });
});

describe('compareProjectsByStar', () => {
    const sort = (items: ReturnType<typeof proj>[], starred: string[]) =>
        [...items]
            .sort((a, b) => compareProjectsByStar(a, b, 'm1', new Set(starred)))
            .map((p) => p.path);

    it('falls back to alphabetical order when nothing is starred', () => {
        expect(sort([proj('/b'), proj('/c'), proj('/a')], [])).toEqual(['/a', '/b', '/c']);
    });

    it('lifts starred projects above unstarred ones', () => {
        expect(sort([proj('/a'), proj('/b'), proj('/c')], [projectKey('m1', '/c')]))
            .toEqual(['/c', '/a', '/b']);
    });

    it('keeps starred projects alphabetical among themselves', () => {
        const starred = [projectKey('m1', '/c'), projectKey('m1', '/b')];
        expect(sort([proj('/a'), proj('/b'), proj('/c')], starred)).toEqual(['/b', '/c', '/a']);
    });

    it('lifts a worktree because its repo is starred', () => {
        const items = [proj('/repo/.dev/worktree/wt', 'repo/wt'), proj('/other', 'other')];
        expect(sort(items, [projectKey('m1', '/repo')])).toEqual(['/repo/.dev/worktree/wt', '/other']);
    });

    it('ignores a star belonging to another machine', () => {
        expect(sort([proj('/a'), proj('/z')], [projectKey('m2', '/z')])).toEqual(['/a', '/z']);
    });
});
