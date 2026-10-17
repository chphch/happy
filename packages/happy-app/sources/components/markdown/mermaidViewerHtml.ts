/**
 * The page the native Mermaid viewer (`MermaidViewer.tsx`) loads into its WebView.
 * It is a pure function so a unit test can read the exact HTML the WebView gets.
 *
 * Zooming is two-phase, and that is the whole point of this file. A CSS
 * `transform: scale()` does not re-render an SVG — Chromium rasterizes the layer
 * once and the compositor stretches that bitmap, and `will-change: transform`
 * pins the raster scale so it never catches up. Measured in Chrome at
 * devicePixelRatio 3 by capturing compositor frames (an ordinary screenshot
 * re-rasterizes on capture and hides the problem entirely): at 8x zoom a glyph
 * edge spanned 12.1 px with `will-change` present versus 2.0 px once the SVG is
 * genuinely re-rendered. The blur grew in proportion to the zoom factor, which
 * is the signature of a 1x bitmap being upscaled.
 *
 * So: while fingers are down we keep the cheap composited transform (smooth),
 * and the moment they lift we *commit* — the SVG's own width/height are set to
 * the zoomed size, the transform scale returns to 1, and `will-change` is
 * released. At rest the diagram is then laid out at its true size and painted at
 * the device's full pixel density at any zoom level, instead of depending on
 * Chromium deciding to re-rasterize a scaled layer.
 */

import { zoomableSvgHtml } from './zoomableSvgHtml';

/**
 * A JS string literal that is safe to place inside an inline `<script>`.
 *
 * `JSON.stringify` alone is not safe there, because it leaves `<` as it is. A
 * diagram containing `</script>` then ends the script element early and the rest
 * of the text is parsed as HTML. The diagram comes from chat (agent output, files,
 * artifacts), so that lets whoever wrote it run markup and script in the WebView.
 * Escaping `<` as `\u003c` leaves no way to write `</script` or `<!--`, and the
 * literal still evaluates to the original text. U+2028 and U+2029 are escaped too:
 * JSON leaves them raw, and older JS engines treat them as line terminators inside
 * a string literal.
 */
export function jsLiteral(value: string): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

/**
 * The viewer's HTML for one diagram. `content` is Mermaid source that came from
 * chat, so it enters the page only through `jsLiteral`.
 */
export function mermaidViewerHtml(content: string): string {
    const mermaidContent = jsLiteral(content);

    // Fork delta: the page is the zoomable page the SVG chat-image viewer
    // shares (zoomableSvgHtml.ts); only the renderer script and the code that
    // fills the stage are Mermaid's.
    return zoomableSvgHtml({
        head: '<script src="https://cdn.jsdelivr.net/npm/mermaid@11.12.2/dist/mermaid.min.js"><\/script>',
        populate: `    mermaid.initialize({startOnLoad:false,theme:'dark'});
    var r=await mermaid.render('m',${mermaidContent});
    stage.innerHTML=r.svg;`,
    });
}
