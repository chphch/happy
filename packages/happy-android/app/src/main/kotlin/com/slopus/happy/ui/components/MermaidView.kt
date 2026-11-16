package com.slopus.happy.ui.components

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull

object MermaidSpec {
    /** Before the page reports its height. */
    const val INITIAL_HEIGHT = 200

    /** Tall diagrams scroll inside a capped container instead of taking over the chat. */
    const val MAX_HEIGHT = 600
    val marginVertical = 8.dp
    val radius = 8.dp
    const val MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"
}

object MermaidTags {
    const val DIAGRAM = "markdown.mermaid"
    const val EXPAND = "markdown.mermaid.expand"
    const val FULL = "markdown.mermaid.full"
}

/**
 * Whether diagrams render in a WebView. False where there is none to use:
 * Robolectric (which can't run the page) and devices without a WebView
 * provider; the caller's fallback (the code block) shows instead.
 */
val LocalMermaidWebView = staticCompositionLocalOf { mermaidWebViewAvailable() }

private fun mermaidWebViewAvailable(): Boolean =
    Build.FINGERPRINT != "robolectric" && runCatching { WebView.getCurrentWebViewPackage() != null }.getOrDefault(false)

/**
 * MermaidRenderer.tsx's native path: mermaid@11 from jsdelivr in a WebView
 * on the theme's surfaceHighest, the diagram centred and no wider than the
 * view. Spec: full width, 8 above and below; the box radius 8 on
 * surfaceHighest, 200 high until the page reports its diagram's height,
 * then that height, down as well as up, at most 600 (the page scrolls
 * inside past it); the height kept while the app runs, so a row scrolled
 * away and back returns at it. An expand button (a page's, top right)
 * opens the diagram full screen, zoomable ([WebViewScreen]). A link tapped
 * in it opens as a chat link does. A syntax error shows inside the page,
 * as "Diagram error: …" in red mono.
 */
@Composable
fun MermaidView(content: String, modifier: Modifier = Modifier, fallback: @Composable () -> Unit) {
    if (!LocalMermaidWebView.current) {
        fallback()
        return
    }
    val colors = HappyTheme.colors
    val background = colors.surfaceHighest
    val html = remember(content, colors.dark, background) { mermaidHtml(content, colors.dark, background) }
    var height by remember(content) { mutableIntStateOf(PageHeights["mermaid:$content"]?.toInt() ?: MermaidSpec.INITIAL_HEIGHT) }
    var full by remember { mutableStateOf(false) }
    val open = rememberWebLinkOpener()
    val onHeight by rememberUpdatedState<(Int) -> Unit>({ reported ->
        PageHeights["mermaid:$content"] = reported.toFloat()
        height = reported
    })
    Box(
        modifier = modifier
            .padding(vertical = MermaidSpec.marginVertical)
            .fillMaxWidth()
            .height(minOf(height, MermaidSpec.MAX_HEIGHT).dp)
            .clip(RoundedCornerShape(MermaidSpec.radius))
            .background(background)
            .testTag(MermaidTags.DIAGRAM),
    ) {
        AndroidView(
            factory = { context -> mermaidWebView(context, background, colors.dark, onOpen = { open(it) }) { onHeight(it) } },
            update = { view -> view.showDiagram(html) },
            onRelease = WebView::destroy,
            modifier = Modifier.fillMaxSize(),
        )
        ExpandButton(onClick = { full = true }, tag = MermaidTags.EXPAND, modifier = Modifier.align(Alignment.TopEnd))
    }
    if (full) {
        WebViewScreen(
            onClose = { full = false },
            tag = MermaidTags.FULL,
            create = { context -> mermaidWebView(context, background, colors.dark, onOpen = { open(it) }, zoom = true) {} },
            show = { view -> view.showDiagram(html) },
        )
    }
}

/** [html] loaded unless it is the one shown. */
private fun WebView.showDiagram(html: String) {
    if (tag == html) return
    tag = html
    loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
}

@SuppressLint("SetJavaScriptEnabled")
private fun mermaidWebView(
    context: Context,
    background: Color,
    dark: Boolean,
    onOpen: (String) -> Unit,
    zoom: Boolean = false,
    onHeight: (Int) -> Unit,
) = themedWebView(context, background, dark).apply {
    settings.javaScriptEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    if (zoom) {
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
    }
    // The page calls window.ReactNativeWebView.postMessage, as in happy-app.
    addJavascriptInterface(MermaidBridge(onHeight), "ReactNativeWebView")
    webViewClient = MermaidClient(onOpen)
}

/** A diagram's client: a link tapped in it opens as a chat link does and the diagram stays; a renderer gone takes only this view. */
private class MermaidClient(private val onOpen: (String) -> Unit) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.isForMainFrame && request.hasGesture()) onOpen(request.url.toString())
        return true
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true
}

/** The page's messages: `{type: "dimensions", height}` in CSS px (dp). Delivered on the main thread. */
class MermaidBridge(private val onHeight: (Int) -> Unit) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postMessage(data: String) {
        val height = parseMermaidHeight(data) ?: return
        main.post { onHeight(height) }
    }
}

internal fun parseMermaidHeight(data: String): Int? {
    val message = runCatching { Json.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return null
    if ((message["type"] as? JsonPrimitive)?.content != "dimensions") return null
    return (message["height"] as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 }
}

/**
 * MermaidRenderer.tsx's page. The diagram goes in as a JSON string, as
 * there; `<` is escaped too so a `</script>` in the diagram can't end the
 * script element.
 */
fun mermaidHtml(content: String, dark: Boolean, background: Color): String {
    val json = JsonPrimitive(content).toString().replace("<", "\\u003c")
    val css = "#%06X".format(background.toArgb() and 0xFFFFFF)
    return """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="${MermaidSpec.MERMAID_URL}"></script>
            <style>
                body { margin: 0; padding: 16px; background-color: $css; }
                #mermaid-container { display: flex; justify-content: center; align-items: center; width: 100%; }
                #mermaid-container svg { max-width: 100%; height: auto; }
                .error { color: #ff6b6b; font-family: monospace; white-space: pre-wrap; }
            </style>
        </head>
        <body>
            <div id="mermaid-container"></div>
            <script>
                function reportHeight() {
                    // The diagram's own height and the body's padding, not the document's, which is never below the view's.
                    const height = Math.ceil(document.getElementById('mermaid-container').getBoundingClientRect().height + 32);
                    if (window.ReactNativeWebView) {
                        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dimensions', height: height }));
                    }
                }
                (async function() {
                    const content = $json;
                    const container = document.getElementById('mermaid-container');
                    try {
                        mermaid.initialize({ startOnLoad: false, theme: '${if (dark) "dark" else "default"}' });
                        const { svg } = await mermaid.render('mermaid-diagram', content);
                        container.innerHTML = svg;
                    } catch (error) {
                        container.innerHTML = '<div class="error">Diagram error: ' +
                            (error.message || String(error)).replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                            '</div>';
                    }
                    requestAnimationFrame(() => { reportHeight(); setTimeout(reportHeight, 200); });
                })();
            </script>
        </body>
        </html>
    """.trimIndent()
}
