import { describe, it, expect, vi } from 'vitest';
import { parseMarkdown } from './parseMarkdown';
import {
    ARTIFACT_MESSAGE_MAX_LENGTH,
    ARTIFACT_MESSAGE_MIN_INTERVAL_MS,
    buildArtifactDocument,
    isSandboxedNavigation,
    parseArtifactHeight,
    parseArtifactMessage
} from './artifactDocument';

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

describe('parseArtifactMessage', () => {
    const wire = (text: unknown) => JSON.stringify({ type: 'artifact-message', text });

    it('accepts a line of text and hands it back trimmed', () => {
        expect(parseArtifactMessage(wire('  §2 를 줄여줘  '))).toBe('§2 를 줄여줘');
    });

    it('refuses a height report, so the two message types cannot be confused', () => {
        expect(parseArtifactMessage(JSON.stringify({ type: 'artifact-height', height: 240 }))).toBeNull();
        expect(parseArtifactHeight(wire('hello'))).toBeNull();
    });

    it('refuses empty and whitespace-only text', () => {
        expect(parseArtifactMessage(wire(''))).toBeNull();
        expect(parseArtifactMessage(wire('   \n\t '))).toBeNull();
    });

    it('re-applies the length limit the frame helper already applied', () => {
        expect(parseArtifactMessage(wire('a'.repeat(ARTIFACT_MESSAGE_MAX_LENGTH)))).toHaveLength(ARTIFACT_MESSAGE_MAX_LENGTH);
        expect(parseArtifactMessage(wire('a'.repeat(ARTIFACT_MESSAGE_MAX_LENGTH + 1)))).toBeNull();
    });

    it('refuses anything that is not a well-formed message', () => {
        expect(parseArtifactMessage(wire(42))).toBeNull();
        expect(parseArtifactMessage(JSON.stringify({ type: 'other', text: 'x' }))).toBeNull();
        expect(parseArtifactMessage('not json')).toBeNull();
        expect(parseArtifactMessage(null)).toBeNull();
        expect(parseArtifactMessage({ type: 'artifact-message', text: 'x' })).toBeNull();
    });
});

describe('the injected send helper', () => {
    /**
     * Actually executes the injected bridge script against stub globals, rather
     * than asserting that the document contains the right substrings. The helper
     * is the only part of this feature that never runs in a test environment on
     * its own — it lives inside a sandboxed frame — so proving the string is
     * present proves nothing about whether it works.
     */
    function runBridge(bridge: 'window' | 'react-native') {
        const html = buildArtifactDocument({ content: '<p>x</p>', theme: 'light', bridge });
        const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];

        const sent: string[] = [];
        const post = (message: string) => { sent.push(message); };
        const win: Record<string, any> = {
            addEventListener: () => {},
            ...(bridge === 'react-native' ? { ReactNativeWebView: { postMessage: post } } : {})
        };
        const doc = {
            documentElement: { setAttribute: () => {}, scrollHeight: 0 },
            body: { scrollHeight: 0 },
            addEventListener: () => {}
        };
        const parent = { postMessage: post };

        new Function('window', 'document', 'parent', 'setTimeout', script)(
            win, doc, parent, () => 0);

        return { send: win.canvasSend as (text: unknown) => boolean, sent };
    }

    it('posts the message shape the host parser accepts', () => {
        const { send, sent } = runBridge('window');
        expect(send('  §2 줄여줘  ')).toBe(true);
        expect(sent).toHaveLength(1);
        expect(parseArtifactMessage(sent[0])).toBe('§2 줄여줘');
    });

    it('reaches the native host over its own channel', () => {
        const { send, sent } = runBridge('react-native');
        expect(send('hello')).toBe(true);
        expect(parseArtifactMessage(sent[0])).toBe('hello');
    });

    it('refuses empty, non-string and over-long input before sending anything', () => {
        const { send, sent } = runBridge('window');
        expect(send('')).toBe(false);
        expect(send('   ')).toBe(false);
        expect(send(42)).toBe(false);
        expect(send('a'.repeat(ARTIFACT_MESSAGE_MAX_LENGTH + 1))).toBe(false);
        expect(sent).toHaveLength(0);
    });

    it('rate-limits a page that sends in a loop, and recovers after the gap', () => {
        vi.useFakeTimers();
        try {
            const { send, sent } = runBridge('window');
            expect(send('first')).toBe(true);
            expect(send('second')).toBe(false);
            vi.advanceTimersByTime(ARTIFACT_MESSAGE_MIN_INTERVAL_MS + 1);
            expect(send('third')).toBe(true);
            expect(sent.map((m) => parseArtifactMessage(m))).toEqual(['first', 'third']);
        } finally {
            vi.useRealTimers();
        }
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
