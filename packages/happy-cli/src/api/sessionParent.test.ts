import { describe, expect, it } from 'vitest';

import { checkLineage } from './sessionParent';

/** Build a parent-link graph the way `readLineageGraph` produces one. */
function graph(links: Record<string, string | null>): Map<string, string | null> {
    return new Map(Object.entries(links));
}

describe('checkLineage', () => {
    it('treats promotion to top level as clean without walking anything', () => {
        expect(checkLineage('a', null, graph({}))).toEqual({ status: 'clean', depth: 0 });
    });

    it('passes a chain that terminates at a root', () => {
        // c -> b -> a(root); re-parenting 'd' under 'c' cannot cycle.
        const verdict = checkLineage('d', 'c', graph({ a: null, b: 'a', c: 'b', d: null }));
        expect(verdict).toEqual({ status: 'clean', depth: 3 });
    });

    it('rejects making a session its own ancestor', () => {
        // b is already a child of a; re-parenting a under b would close the loop.
        const verdict = checkLineage('a', 'b', graph({ a: null, b: 'a' }));
        expect(verdict.status).toBe('cycle');
        if (verdict.status === 'cycle') {
            expect(verdict.via).toEqual(['b', 'a']);
        }
    });

    it('rejects a longer cycle, not just the adjacent one', () => {
        const verdict = checkLineage('a', 'd', graph({ a: null, b: 'a', c: 'b', d: 'c' }));
        expect(verdict.status).toBe('cycle');
        if (verdict.status === 'cycle') {
            expect(verdict.via).toEqual(['d', 'c', 'b', 'a']);
        }
    });

    it('reports unverified — NOT clean — when an ancestor is unreadable', () => {
        // 'b' is not in the cache, so whether 'a' sits above it is unknowable. The
        // distinction matters: an unreadable ancestor is exactly where a cycle hides,
        // so this must not come back looking like a pass.
        const verdict = checkLineage('a', 'b', graph({ a: null }));
        expect(verdict.status).toBe('unverified');
        if (verdict.status === 'unverified') {
            expect(verdict.reason).toContain('not in this machine');
            expect(verdict.walked).toEqual(['b']);
        }
    });

    it('reports unverified when the existing lineage is already cyclic above the target', () => {
        // b <-> c loop that does not involve 'a'. Applying the change would not create
        // the cycle, but the app's lineage walk would still spin, so this is not clean.
        const verdict = checkLineage('a', 'b', graph({ a: null, b: 'c', c: 'b' }));
        expect(verdict.status).toBe('unverified');
        if (verdict.status === 'unverified') {
            expect(verdict.reason).toContain('already contains a cycle');
        }
    });

    it('bounds the walk instead of spinning on a very deep chain', () => {
        const links: Record<string, string | null> = {};
        for (let i = 0; i < 200; i++) {
            links[`s${i}`] = `s${i + 1}`;
        }
        links.s200 = null;
        const verdict = checkLineage('target', 's0', graph(links));
        expect(verdict.status).toBe('unverified');
        if (verdict.status === 'unverified') {
            expect(verdict.reason).toContain('exceeded');
        }
    });
});
