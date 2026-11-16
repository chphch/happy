package com.slopus.happy.ui.components

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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
import androidx.compose.runtime.mutableFloatStateOf
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.slopus.happy.R
import com.slopus.happy.ui.artifacts.HEIGHT_BRIDGE
import com.slopus.happy.ui.artifacts.Heights
import com.slopus.happy.ui.artifacts.MEASURE_SCRIPT
import com.slopus.happy.ui.artifacts.hostScript
import com.slopus.happy.ui.theme.HappyTheme
import java.io.ByteArrayInputStream
import kotlin.math.abs
import kotlin.math.ceil

object HtmlPageSpec {
    /** Before the page has measured itself, as an inline artifact's page (iOS `ChatPlanner.pageHeight`). */
    val initialHeight = 120.dp

    /** Only guards against a runaway measurement: a page shows whole, never scrolling inside. */
    const val MAX_HEIGHT = 8000f
    val marginVertical = 8.dp
    val radius = 8.dp
}

object HtmlPageTags {
    const val PAGE = "markdown.page"
    const val WEB = "markdown.page.web"
    const val EXPAND = "markdown.page.expand"
    const val FULL = "markdown.page.full"

    /** The page's state description once its document has loaded. */
    const val LOADED = "loaded"
}

/**
 * Whether pages draw in a WebView. False where there is none to use
 * (Robolectric, a device without a WebView provider); the caller's fallback,
 * the fence's source as code, shows instead.
 */
val LocalHtmlPageWebView = staticCompositionLocalOf { webViewAvailable() }

private fun webViewAvailable(): Boolean =
    Build.FINGERPRINT != "robolectric" && runCatching { WebView.getCurrentWebViewPackage() != null }.getOrDefault(false)

/**
 * A ```` ```artifact ```` fence's page in the chat (happy-app's artifact
 * frame), static: the fence's HTML and CSS, no script of its own, nothing
 * from the network. Spec: full width, 8 above and below; radius 8 on
 * surfaceHighest; 120 high until the page measures itself, then as tall as
 * its content (it never scrolls inside), the height kept for the app's
 * life so a row scrolled away and back returns at it. An expand button,
 * a 24 box radius 6 on surfaceHighest 6 in from the top right with a 14
 * expand glyph in textSecondary, reached 40 around, opens the page full
 * screen, scrolling and zoomable ([WebViewScreen]). A link tapped in the page opens as a chat link
 * does and the page stays where it is. A theme change loads the page again
 * in the new scheme. Where there is no WebView, [fallback] shows instead.
 */
@SuppressLint("JavascriptInterface")
@Composable
fun HtmlPageView(html: String, modifier: Modifier = Modifier, fallback: @Composable () -> Unit) {
    if (!LocalHtmlPageWebView.current) {
        fallback()
        return
    }
    val colors = HappyTheme.colors
    val background = colors.surfaceHighest
    val document = remember(html, colors.dark, background, colors.text) { htmlPageDocument(html, colors.dark, colors.text, background) }
    var height by remember(html) { mutableFloatStateOf(PageHeights["page:$html"] ?: HtmlPageSpec.initialHeight.value) }
    var loaded by remember(document) { mutableStateOf(false) }
    var full by remember { mutableStateOf(false) }
    val open = rememberWebLinkOpener()
    val measured by rememberUpdatedState<(Float) -> Unit>({ reported ->
        val rounded = ceil(reported).coerceIn(1f, HtmlPageSpec.MAX_HEIGHT)
        PageHeights["page:$html"] = rounded
        if (abs(rounded - height) >= 1f) height = rounded
    })
    val onLoaded by rememberUpdatedState<(WebView) -> Unit>({ view ->
        view.evaluateJavascript(hostScript(colors), null)
        view.evaluateJavascript(MEASURE_SCRIPT, null)
        loaded = true
    })
    val label = stringResource(R.string.chat_markdown_page)
    Box(
        modifier = modifier
            .padding(vertical = HtmlPageSpec.marginVertical)
            .testTag(HtmlPageTags.PAGE)
            .fillMaxWidth()
            .height(height.dp)
            .clip(RoundedCornerShape(HtmlPageSpec.radius))
            .background(background)
            .semantics {
                contentDescription = label
                if (loaded) stateDescription = HtmlPageTags.LOADED
            },
    ) {
        AndroidView(
            factory = { context ->
                htmlPageWebView(context, background, colors.dark, full = false, onLoaded = { onLoaded(it) }, onOpen = { open(it) }).apply {
                    addJavascriptInterface(Heights { value -> post { measured(value) } }, HEIGHT_BRIDGE)
                }
            },
            update = { view -> view.show(document) },
            onRelease = { view ->
                view.stopLoading()
                view.destroy()
            },
            modifier = Modifier.fillMaxSize().testTag(HtmlPageTags.WEB),
        )
        ExpandButton(onClick = { full = true }, tag = HtmlPageTags.EXPAND, modifier = Modifier.align(Alignment.TopEnd))
    }
    if (full) {
        WebViewScreen(
            onClose = { full = false },
            tag = HtmlPageTags.FULL,
            create = { context ->
                htmlPageWebView(context, colors.surfaceHighest, colors.dark, full = true, onLoaded = { it.evaluateJavascript(hostScript(colors), null) }, onOpen = { open(it) })
            },
            show = { view -> view.show(document) },
        )
    }
}

/** Where a page's document is served from: a name that never resolves, answered only by [HtmlPageClient]. */
internal const val HTML_PAGE_ORIGIN = "https://page.happy-markdown.invalid"

/**
 * What a page may load: nothing but itself and what it carries as `data:`
 * or `blob:`; no script of its own runs. A header, so it holds from the
 * document's first byte whatever the fence's HTML puts first.
 */
internal const val HTML_PAGE_POLICY =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data: blob:; " +
        "media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'"

private val PAGE_HEADERS = mapOf(
    "Content-Security-Policy" to HTML_PAGE_POLICY,
    "X-DNS-Prefetch-Control" to "off",
    "Referrer-Policy" to "no-referrer",
    "Cache-Control" to "no-store",
)

private val WHOLE_DOCUMENT = Regex("<html[\\s>]", RegexOption.IGNORE_CASE)

/**
 * The document a fence's [html] makes: a whole document as it is; a
 * fragment in happy-app's frame skeleton, in the app's scheme (`data-theme`
 * and `color-scheme`) on [background], [text] coloured 16/1.5 in the app's
 * face with 12 padding, pictures no wider than the page.
 */
internal fun htmlPageDocument(html: String, dark: Boolean, text: Color, background: Color): String {
    if (WHOLE_DOCUMENT.containsMatchIn(html)) return html
    val scheme = if (dark) "dark" else "light"
    fun css(color: Color) = "#%06X".format(color.toArgb() and 0xFFFFFF)
    val head = """
        <!DOCTYPE html>
        <html data-theme="$scheme">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        :root { color-scheme: $scheme; background: ${css(background)}; }
        body { margin: 0; padding: 12px; color: ${css(text)}; font: 16px/1.5 Roboto, system-ui, sans-serif; overflow-wrap: anywhere; }
        img, svg, video, canvas { max-width: 100%; height: auto; }
        </style>
        </head>
        <body>
    """.trimIndent()
    return "$head\n$html\n</body>\n</html>\n"
}

/**
 * A page's client: its document served from [HTML_PAGE_ORIGIN] under
 * [HTML_PAGE_POLICY], every other request answered 403, so nothing reaches
 * the network; a tapped link handed to [onOpen] while the page stays put.
 */
internal class HtmlPageClient(
    private val onLoaded: (WebView) -> Unit,
    private val onOpen: (String) -> Unit,
) : WebViewClient() {
    /** The document served next; read on WebView's own thread. */
    @Volatile var document: String? = null

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
        val document = document
        if (request.isForMainFrame && document != null && request.url.toString().startsWith("$HTML_PAGE_ORIGIN/")) {
            return WebResourceResponse("text/html", "utf-8", 200, "OK", PAGE_HEADERS, ByteArrayInputStream(document.toByteArray()))
        }
        return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.isForMainFrame && request.hasGesture()) onOpen(request.url.toString())
        return true
    }

    override fun onPageFinished(view: WebView, url: String?) {
        if (url?.startsWith("$HTML_PAGE_ORIGIN/") == true) onLoaded(view)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true
}

/** [document] loaded unless it is the one shown: a page loads once, whole. */
private fun WebView.show(document: String) {
    if (tag == document) return
    tag = document
    (webViewClient as? HtmlPageClient)?.document = document
    loadUrl("$HTML_PAGE_ORIGIN/?${document.hashCode()}")
}

/**
 * A WebView for a page: no files, storage, geolocation or windows; only
 * [HtmlPageClient]'s document. Script is on for the app's own measuring
 * alone: the page's policy runs none of its own. Inline it never scrolls;
 * [full] screen scrolls and zooms.
 */
@SuppressLint("SetJavaScriptEnabled")
internal fun htmlPageWebView(
    context: Context,
    background: Color,
    dark: Boolean,
    full: Boolean,
    onLoaded: (WebView) -> Unit,
    onOpen: (String) -> Unit,
): WebView = themedWebView(context, background, dark).apply {
    settings.javaScriptEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.domStorageEnabled = false
    settings.setGeolocationEnabled(false)
    settings.javaScriptCanOpenWindowsAutomatically = false
    settings.setSupportMultipleWindows(false)
    if (full) {
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
    } else {
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
    }
    webViewClient = HtmlPageClient(onLoaded, onOpen)
}
