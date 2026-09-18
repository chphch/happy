/**
 * Builds the document loaded into the sandboxed frame that renders an
 * ```artifact block.
 *
 * The block carries page *content* (no `<html>`/`<head>`/`<body>`), the same
 * contract Claude Code's Artifact tool uses, so a fragment is the common case
 * and gets wrapped in a skeleton here. A full document is passed through
 * unchanged apart from the bridge, so HTML copied verbatim out of a file still
 * renders.
 *
 * The bridge exists because neither host can measure the frame's content from
 * the outside: the web iframe is sandboxed without `allow-same-origin`, so its
 * document is cross-origin to us, and a native WebView has no DOM at all. The
 * content reports its own height instead.
 */

export type ArtifactBridge = 'react-native' | 'window';

export interface ArtifactDocumentOptions {
    content: string;
    theme: 'light' | 'dark';
    bridge: ArtifactBridge;
}

export const ARTIFACT_HEIGHT_MESSAGE = 'artifact-height';

/**
 * The frame's one way to talk back: a single line of text, delivered into the
 * session as an ordinary user message. This is what makes a rendered page
 * interactive — a button, a small form — instead of a picture.
 *
 * The limits below are enforced TWICE on purpose. The helper the frame calls
 * applies them so a page can tell its user "too long" before anything is sent;
 * the host applies them again on arrival because the frame is not trusted to.
 * Page content is authored elsewhere and runs in an opaque origin, so its
 * cooperation is a convenience, never a guarantee.
 */
export const ARTIFACT_TEXT_MESSAGE = 'artifact-message';

/** Longest text one send may carry. A chat message, not a document. */
export const ARTIFACT_MESSAGE_MAX_LENGTH = 2000;

/** Smallest gap between two accepted sends — stops a loop flooding the session. */
export const ARTIFACT_MESSAGE_MIN_INTERVAL_MS = 400;

const FULL_DOCUMENT_RE = /<html[\s>]/i;
const HEAD_OPEN_RE = /<head[^>]*>/i;
const HTML_OPEN_RE = /<html[^>]*>/i;

function bridgeScript(options: ArtifactDocumentOptions): string {
    const send = options.bridge === 'react-native'
        ? 'function (m) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(m); }'
        : "function (m) { parent.postMessage(m, '*'); }";

    return `<script>(function () {
var send = ${send};
try { document.documentElement.setAttribute('data-theme', ${JSON.stringify(options.theme)}); } catch (e) {}
var last = 0;
function report() {
    var body = document.body;
    var h = Math.ceil(Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        body ? body.scrollHeight : 0
    ));
    if (h === last || h === 0) return;
    last = h;
    send(JSON.stringify({ type: ${JSON.stringify(ARTIFACT_HEIGHT_MESSAGE)}, height: h }));
}
document.addEventListener('DOMContentLoaded', report);
window.addEventListener('load', report);
if (window.ResizeObserver) {
    new ResizeObserver(report).observe(document.documentElement);
}
setTimeout(report, 120);
setTimeout(report, 600);
var lastSend = 0;
window.canvasSend = function (text) {
    if (typeof text !== 'string') return false;
    var trimmed = text.trim();
    if (!trimmed || trimmed.length > ${ARTIFACT_MESSAGE_MAX_LENGTH}) return false;
    var now = Date.now();
    if (now - lastSend < ${ARTIFACT_MESSAGE_MIN_INTERVAL_MS}) return false;
    lastSend = now;
    send(JSON.stringify({ type: ${JSON.stringify(ARTIFACT_TEXT_MESSAGE)}, text: trimmed }));
    return true;
};
})();</script>`;
}

function injectIntoDocument(content: string, script: string): string {
    const head = HEAD_OPEN_RE.exec(content);
    if (head) {
        const at = head.index + head[0].length;
        return content.slice(0, at) + script + content.slice(at);
    }
    const html = HTML_OPEN_RE.exec(content);
    if (html) {
        const at = html.index + html[0].length;
        return content.slice(0, at) + script + content.slice(at);
    }
    return content + script;
}

export function buildArtifactDocument(options: ArtifactDocumentOptions): string {
    const script = bridgeScript(options);

    if (FULL_DOCUMENT_RE.test(options.content)) {
        return injectIntoDocument(options.content, script);
    }

    return `<!doctype html>
<html lang="en" data-theme="${options.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: light dark; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
img, svg, video { max-width: 100%; height: auto; }
</style>
${script}
</head>
<body>
${options.content}
</body>
</html>`;
}

/**
 * The document is handed to the WebView as a string, so the only load it should
 * ever perform is that initial one. Anything navigating away — a link tap, a
 * redirect — would leave the sandbox and is refused. The web iframe gets the
 * same guarantee from its `sandbox` attribute instead.
 */
export function isSandboxedNavigation(url: string): boolean {
    return url.startsWith('about:') || url.startsWith('data:');
}

/**
 * Reads a height out of a bridge message. Returns null for anything that is not
 * a well-formed height report, so a page that posts its own unrelated messages
 * (or malformed JSON) cannot resize the frame.
 */
export function parseArtifactHeight(data: unknown): number | null {
    if (typeof data !== 'string') return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const message = parsed as { type?: unknown; height?: unknown };
    if (message.type !== ARTIFACT_HEIGHT_MESSAGE) return null;
    if (typeof message.height !== 'number' || !Number.isFinite(message.height) || message.height <= 0) return null;
    return message.height;
}

/**
 * Reads the text out of a bridge message the frame wants sent to the session,
 * or null for anything that is not one.
 *
 * Every limit the injected helper already applies is re-applied here. The helper
 * runs inside the frame, where the page could simply not call it — posting the
 * message shape directly — so treating its checks as having happened would mean
 * trusting a writer we do not control. Rate limiting is deliberately NOT here:
 * it needs memory across calls, which belongs to the component holding the
 * frame, not to a pure parser.
 */
export function parseArtifactMessage(data: unknown): string | null {
    if (typeof data !== 'string') return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const message = parsed as { type?: unknown; text?: unknown };
    if (message.type !== ARTIFACT_TEXT_MESSAGE) return null;
    if (typeof message.text !== 'string') return null;
    const text = message.text.trim();
    if (!text || text.length > ARTIFACT_MESSAGE_MAX_LENGTH) return null;
    return text;
}
