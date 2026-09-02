import { describe, it, expect } from 'vitest';
import { sanitizeSvgMarkup, needsSvgSanitizing } from './sanitizeSvgMarkup';

/**
 * The value under test is what react-native-svg's NATIVE renderer receives.
 * `orient="auto-start-reverse"` reaching it is a process kill on Android
 * (NumberFormatException out of SvgView.onDraw), so "does the output still
 * contain that string" is the assertion that matters most here.
 */
const MARKER = (orient: string, id = 'g') =>
    `<marker id="${id}" viewBox="0 0 10 8" refX="9" refY="4" orient="${orient}"><path d="M0,0 L10,4 L0,8Z"/></marker>`;

const doc = (defs: string, body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${body}</svg>`;

describe('sanitizeSvgMarkup', () => {
    it('leaves markup with no marker untouched', () => {
        const xml = '<svg><path d="M0 0 L10 10"/></svg>';
        expect(sanitizeSvgMarkup(xml)).toBe(xml);
    });

    it('leaves a valid orient untouched', () => {
        for (const orient of ['auto', '0', '45', '-90.5', '1e2', '.5']) {
            const xml = doc(MARKER(orient), '<path marker-end="url(#g)"/>');
            expect(sanitizeSvgMarkup(xml)).toBe(xml);
        }
    });

    it('rewrites auto-start-reverse to auto', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path d="M0 0" marker-end="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out).not.toContain('auto-start-reverse');
        expect(out).toContain('orient="auto"');
    });

    it('does not add a clone when the marker is only an end marker', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path marker-end="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out.match(/<marker\b/g)).toHaveLength(1);
        expect(out).toContain('marker-end="url(#g)"');
    });

    it('emits a 180-rotated clone and repoints marker-start', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path marker-start="url(#g)" marker-end="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out.match(/<marker\b/g)).toHaveLength(2);
        expect(out).toContain('id="g-happy-start-reverse"');
        expect(out).toContain('<g transform="rotate(180 9 4)">');
        // start goes to the rotated clone, end stays on the original
        expect(out).toContain('marker-start="url(#g-happy-start-reverse)"');
        expect(out).toContain('marker-end="url(#g)"');
        expect(out).not.toContain('auto-start-reverse"');
    });

    it('falls back to the initial value 0 for an unparseable orient', () => {
        const xml = doc(MARKER('sideways'), '<path marker-end="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out).toContain('orient="0"');
        expect(out).not.toContain('sideways');
    });

    it('rejects a number the native parser would also reject', () => {
        // parseFloat would accept "12px"; Double.parseDouble does not.
        const out = sanitizeSvgMarkup(doc(MARKER('12px'), '<path marker-end="url(#g)"/>'));
        expect(out).toContain('orient="0"');
    });

    it('handles several markers independently', () => {
        const xml = doc(
            MARKER('auto-start-reverse', 'a') + MARKER('auto', 'b') + MARKER('nonsense', 'c'),
            '<path marker-end="url(#a)"/><path marker-end="url(#b)"/><path marker-end="url(#c)"/>',
        );
        const out = sanitizeSvgMarkup(xml);
        expect(out).not.toContain('auto-start-reverse');
        expect(out).not.toContain('nonsense');
        expect(out.match(/orient="auto"/g)).toHaveLength(2);
        expect(out).toContain('orient="0"');
    });

    it('leaves a self-closing marker parseable', () => {
        const xml = doc('<marker id="g" refX="1" refY="2" orient="auto-start-reverse"/>', '<path marker-start="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out).not.toContain('auto-start-reverse');
        // No children to rotate, so no clone is invented.
        expect(out.match(/<marker\b/g)).toHaveLength(1);
    });

    it('does not touch an unterminated marker element', () => {
        const xml = '<svg><defs><marker id="g" orient="auto-start-reverse"><path/></defs></svg>';
        expect(sanitizeSvgMarkup(xml)).toBe(xml);
    });

    it('accepts single-quoted attributes', () => {
        const xml = "<svg><defs><marker id='g' refX='9' refY='4' orient='auto-start-reverse'><path/></marker></defs><path marker-end='url(#g)'/></svg>";
        const out = sanitizeSvgMarkup(xml);
        expect(out).not.toContain('auto-start-reverse');
        expect(out).toContain('orient="auto"');
    });

    it('is idempotent', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path marker-start="url(#g)"/>');
        const once = sanitizeSvgMarkup(xml);
        expect(sanitizeSvgMarkup(once)).toBe(once);
    });

    it('reports whether markup needs rewriting', () => {
        expect(needsSvgSanitizing(doc(MARKER('auto'), ''))).toBe(false);
        expect(needsSvgSanitizing(doc(MARKER('auto-start-reverse'), ''))).toBe(true);
    });

    it('handles the diagram that actually crashed the app', () => {
        // Shape of equisplit_node_lifecycle.svg: four auto-start-reverse markers,
        // referenced only as marker-end. Measured 2026-09-02: this file killed
        // the Android app inside MarkerView.renderMarker.
        const defs = ['g', 'r', 'o', 'd'].map((id) => MARKER('auto-start-reverse', id)).join('');
        const body = '<path marker-end="url(#g)"/><path marker-end="url(#r)"/><path marker-end="url(#o)"/><path marker-end="url(#d)"/>';
        const out = sanitizeSvgMarkup(doc(defs, body));
        expect(out).not.toContain('auto-start-reverse');
        expect(out.match(/<marker\b/g)).toHaveLength(4);
        expect(out.match(/orient="auto"/g)).toHaveLength(4);
    });
});
