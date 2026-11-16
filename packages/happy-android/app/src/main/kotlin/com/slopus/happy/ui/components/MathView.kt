package com.slopus.happy.ui.components

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.json.JsonPrimitive

object MathSpec {
    /** Before the page reports the formula's height: about one line of display math. */
    const val INITIAL_HEIGHT = 48

    /** Only guards against a runaway measurement: a formula shows whole. */
    const val MAX_HEIGHT = 2000
    val marginVertical = 4.dp

    /** KaTeX, the renderer desktop and happy-app draw math with, from jsdelivr as Mermaid's library comes. */
    const val KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist"
}

object MathTags {
    const val BLOCK = "markdown.math"
}

/**
 * Whether display math draws in a WebView. False where there is none to use
 * (Robolectric, a device without a WebView provider); the caller's fallback,
 * the TeX as code, shows instead.
 */
val LocalMathWebView = staticCompositionLocalOf { mathWebViewAvailable() }

private fun mathWebViewAvailable(): Boolean =
    Build.FINGERPRINT != "robolectric" && runCatching { WebView.getCurrentWebViewPackage() != null }.getOrDefault(false)

/**
 * Display math (`$$…$$`, `\[…\]`) drawn by KaTeX in a see-through WebView on
 * the conversation's own surface: the formula centred in the text colour,
 * one wider than the column scrolling sideways inside. Spec: full width, 4
 * above and below; 48 high until the page reports the formula's height,
 * then that height, kept while the app runs so a row scrolled back returns
 * at it ([PageHeights]). Described by its TeX. A formula KaTeX can't read
 * shows its error in red mono inside the page; with KaTeX unreachable the
 * TeX itself shows there. Nothing in it navigates (KaTeX's `trust` stays
 * off). Where there is no WebView, [fallback] shows instead.
 */
@Composable
fun MathView(tex: String, modifier: Modifier = Modifier, fallback: @Composable () -> Unit) {
    if (!LocalMathWebView.current) {
        fallback()
        return
    }
    val colors = HappyTheme.colors
    val html = remember(tex, colors.text) { mathHtml(tex, colors.text) }
    var height by remember(tex) { mutableIntStateOf(PageHeights["math:$tex"]?.toInt() ?: MathSpec.INITIAL_HEIGHT) }
    val onHeight by rememberUpdatedState<(Int) -> Unit>({ reported ->
        val kept = reported.coerceIn(1, MathSpec.MAX_HEIGHT)
        PageHeights["math:$tex"] = kept.toFloat()
        height = kept
    })
    Box(
        modifier = modifier
            .padding(vertical = MathSpec.marginVertical)
            .testTag(MathTags.BLOCK)
            .fillMaxWidth()
            .height(height.dp)
            .semantics { contentDescription = tex },
    ) {
        AndroidView(
            factory = { context -> mathWebView(context, colors.dark) { onHeight(it) } },
            update = { view ->
                if (view.tag != html) {
                    view.tag = html
                    view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
                }
            },
            onRelease = WebView::destroy,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun mathWebView(context: Context, dark: Boolean, onHeight: (Int) -> Unit) = themedWebView(context, Color.Transparent, dark).apply {
    settings.javaScriptEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    isVerticalScrollBarEnabled = false
    // The page posts its height as a diagram's does.
    addJavascriptInterface(MermaidBridge(onHeight), "ReactNativeWebView")
    webViewClient = MathClient
}

/** Nothing in a formula navigates; a gone renderer takes only its view. */
private object MathClient : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true
}

/** The formula's page. [tex] goes in as a JSON string with `<` escaped, as a diagram's does. */
fun mathHtml(tex: String, text: Color): String {
    val json = JsonPrimitive(tex).toString().replace("<", "\\u003c")
    val color = "#%06X".format(text.toArgb() and 0xFFFFFF)
    return """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link rel="stylesheet" href="${MathSpec.KATEX}/katex.min.css">
            <script src="${MathSpec.KATEX}/katex.min.js"></script>
            <style>
                html, body { margin: 0; padding: 0; background: transparent; color: $color; font-size: 16px; }
                #math { padding: 4px 0; }
                #math .katex-display { margin: 0; padding: 2px 0; overflow-x: auto; overflow-y: hidden; }
                .source { font-family: monospace; white-space: pre-wrap; }
                .error { color: #ff6b6b; }
            </style>
        </head>
        <body>
            <div id="math"></div>
            <script>
                const math = document.getElementById('math');
                function reportHeight() {
                    const height = Math.ceil(math.getBoundingClientRect().height);
                    if (window.ReactNativeWebView && height > 0) {
                        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dimensions', height: height }));
                    }
                }
                const tex = $json;
                if (typeof katex === 'undefined') {
                    math.className = 'source';
                    math.textContent = tex;
                } else {
                    try {
                        katex.render(tex, math, { displayMode: true, throwOnError: false, trust: false });
                    } catch (error) {
                        math.className = 'source error';
                        math.textContent = String(error.message || error);
                    }
                }
                new ResizeObserver(reportHeight).observe(math);
                if (document.fonts) document.fonts.ready.then(reportHeight);
                requestAnimationFrame(() => { reportHeight(); setTimeout(reportHeight, 300); });
            </script>
        </body>
        </html>
    """.trimIndent()
}
