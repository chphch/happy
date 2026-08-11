import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './parseMarkdown';
import { buildArtifactDocument, isSandboxedNavigation, parseArtifactHeight } from './artifactDocument';

describe('artifact fence parsing', () => {
    it('routes an artifact fence to its own block type', () => {
        const md = ['```artifact', '<h1>Hi</h1>', '```'].join('\n');
        expect(parseMarkdown(md)).toEqual([{ type: 'artifact', content: '<h1>Hi</h1>' }]);
    });

    it('leaves a plain html fence as a code block', () => {
        const md = ['```html', '<h1>Hi</h1>', '```'].join('\n');
        expect(parseMarkdown(md)).toEqual([{ type: 'code-block', language: 'html', content: '<h1>Hi</h1>' }]);
    });
});

describe('buildArtifactDocument', () => {
    it('wraps a fragment in a skeleton carrying the theme', () => {
        const html = buildArtifactDocument({ content: '<p>hello</p>', theme: 'dark', bridge: 'window' });
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('data-theme="dark"');
        expect(html).toContain('<p>hello</p>');
    });

    it('does not wrap a full document a second time', () => {
        const source = '<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>';
        const html = buildArtifactDocument({ content: source, theme: 'light', bridge: 'window' });
        expect(html.match(/<html/gi)).toHaveLength(1);
        expect(html).toContain('<title>t</title>');
    });

    it('injects the bridge inside head so the theme is set before the body renders', () => {
        const source = '<html><head><style>p{color:red}</style></head><body><p>x</p></body></html>';
        const html = buildArtifactDocument({ content: source, theme: 'dark', bridge: 'window' });
        expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<style>'));
        expect(html).toContain("setAttribute('data-theme', \"dark\")");
    });

    it('still injects the bridge when the document has no head', () => {
        const html = buildArtifactDocument({ content: '<html><body><p>x</p></body></html>', theme: 'light', bridge: 'window' });
        expect(html).toContain('artifact-height');
    });

    it('uses the host-appropriate postMessage channel', () => {
        const native = buildArtifactDocument({ content: '<p>x</p>', theme: 'light', bridge: 'react-native' });
        const web = buildArtifactDocument({ content: '<p>x</p>', theme: 'light', bridge: 'window' });
        expect(native).toContain('window.ReactNativeWebView');
        expect(native).not.toContain('parent.postMessage');
        expect(web).toContain('parent.postMessage');
        expect(web).not.toContain('window.ReactNativeWebView');
    });
});

describe('parseArtifactHeight', () => {
    it('accepts a well-formed height report', () => {
        expect(parseArtifactHeight(JSON.stringify({ type: 'artifact-height', height: 240 }))).toBe(240);
    });

    it('rejects anything else the page may post', () => {
        expect(parseArtifactHeight(JSON.stringify({ type: 'other', height: 240 }))).toBeNull();
        expect(parseArtifactHeight(JSON.stringify({ type: 'artifact-height', height: '240' }))).toBeNull();
        expect(parseArtifactHeight(JSON.stringify({ type: 'artifact-height', height: -1 }))).toBeNull();
        expect(parseArtifactHeight('not json')).toBeNull();
        expect(parseArtifactHeight(null)).toBeNull();
        expect(parseArtifactHeight({ type: 'artifact-height', height: 240 })).toBeNull();
    });
});

describe('isSandboxedNavigation', () => {
    it('allows only the frame\'s own initial load', () => {
        expect(isSandboxedNavigation('about:blank')).toBe(true);
        expect(isSandboxedNavigation('data:text/html,x')).toBe(true);
        expect(isSandboxedNavigation('https://example.com')).toBe(false);
        expect(isSandboxedNavigation('file:///etc/passwd')).toBe(false);
    });
});
