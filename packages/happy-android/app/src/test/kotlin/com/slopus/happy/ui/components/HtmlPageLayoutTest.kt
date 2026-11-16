package com.slopus.happy.ui.components

import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.artifacts.HEIGHT_BRIDGE
import com.slopus.happy.ui.artifacts.Heights
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MarkdownTags
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

/**
 * A ```` ```artifact ```` fence's page: full width with 8 above and below,
 * radius 8 on surfaceHighest, 120 high until the page measures itself, then
 * as tall as its content, kept for the next row that shows the same page;
 * an expand button 40 square in its top right corner that opens it full
 * screen with a 44 close button. Static: served under a policy that runs no
 * script and fetches nothing, every other request refused. Where there is
 * no WebView (Robolectric) the fence stays an "artifact" code block.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class HtmlPageLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun fence(html: String) = "```artifact\n$html\n```"

    @Test
    fun robolectricFallsBackToTheCodeBlock() {
        rule.setHappyContent { MarkdownView(parseMarkdown(fence("<p>fallback</p>")), Modifier.fillMaxWidth()) }
        rule.node(MarkdownTags.CODE_BLOCK).assertExists()
        rule.node(HtmlPageTags.PAGE).assertDoesNotExist()
        rule.onNode(hasText("artifact"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun pageStartsAt120AndTakesItsContentsHeight() {
        var root: View? = null
        rule.setHappyContent {
            root = LocalView.current
            CompositionLocalProvider(LocalHtmlPageWebView provides true) {
                MarkdownView(parseMarkdown(fence("<h1>Report</h1>\n<p>All green.</p>")), Modifier.fillMaxWidth())
            }
        }
        rule.node(MarkdownTags.CODE_BLOCK).assertDoesNotExist()
        assertBox("page", rule.node(HtmlPageTags.PAGE).bounds, 0.dp, 8.dp, 411.dp, 120.dp)
        assertBox("expand reach", rule.node(HtmlPageTags.EXPAND).bounds, 371.dp, 8.dp, 40.dp, 40.dp)

        val web = findWebView(root!!.rootView)!!
        val shadow = shadowOf(web)
        assertTrue(shadow.lastLoadedUrl.startsWith("$HTML_PAGE_ORIGIN/"))
        assertTrue("script, for the app's own measuring", web.settings.javaScriptEnabled)
        assertFalse(web.settings.allowFileAccess)
        assertFalse(web.settings.allowContentAccess)
        assertFalse(web.settings.domStorageEnabled)
        val heights = shadow.getJavascriptInterface(HEIGHT_BRIDGE) as Heights

        heights.height(300.4)
        settle()
        assertBox("measured", rule.node(HtmlPageTags.PAGE).bounds, 0.dp, 8.dp, 411.dp, 301.dp)
        // Unlike a diagram it follows its content down too: it never scrolls inside.
        heights.height(180.0)
        settle()
        assertBox("shrunk", rule.node(HtmlPageTags.PAGE).bounds, 0.dp, 8.dp, 411.dp, 180.dp)
        heights.height(0.0)
        settle()
        assertBox("no height is none", rule.node(HtmlPageTags.PAGE).bounds, 0.dp, 8.dp, 411.dp, 180.dp)
    }

    @Test
    fun aRowScrolledBackComesBackAtItsHeight() {
        var root: View? = null
        var shown by mutableStateOf(true)
        val html = "<p>kept ${System.nanoTime()}</p>"
        rule.setHappyContent {
            root = LocalView.current
            CompositionLocalProvider(LocalHtmlPageWebView provides true) {
                if (shown) MarkdownView(parseMarkdown(fence(html)), Modifier.fillMaxWidth())
            }
        }
        (shadowOf(findWebView(root!!.rootView)!!).getJavascriptInterface(HEIGHT_BRIDGE) as Heights).height(240.0)
        settle()
        shown = false
        settle()
        rule.node(HtmlPageTags.PAGE).assertDoesNotExist()
        shown = true
        settle()
        assertBox("again", rule.node(HtmlPageTags.PAGE).bounds, 0.dp, 8.dp, 411.dp, 240.dp)
    }

    @Test
    fun expandOpensThePageFullScreenAndCloseLeaves() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalHtmlPageWebView provides true) {
                MarkdownView(parseMarkdown(fence("<p>wide</p>")), Modifier.fillMaxWidth())
            }
        }
        rule.node(HtmlPageTags.FULL).assertDoesNotExist()
        rule.node(HtmlPageTags.EXPAND).performClick()
        rule.waitForIdle()
        rule.node(HtmlPageTags.FULL).assertExists()
        assertEquals(44f, rule.node(HtmlPageTags.CLOSE).bounds.let { (it.right - it.left).value }, 0.34f)
        rule.node(HtmlPageTags.CLOSE).performClick()
        rule.waitForIdle()
        rule.node(HtmlPageTags.FULL).assertDoesNotExist()
    }

    @Test
    fun theClientServesOnlyThePageUnderItsPolicy() {
        val opened = ArrayList<String>()
        val client = HtmlPageClient(onLoaded = {}, onOpen = { opened += it })
        client.document = "<p>x</p>"
        val web = WebView(ApplicationProvider.getApplicationContext())

        val page = client.shouldInterceptRequest(web, request("$HTML_PAGE_ORIGIN/?1", mainFrame = true))
        assertEquals(200, page.statusCode)
        assertEquals(HTML_PAGE_POLICY, page.responseHeaders["Content-Security-Policy"])
        assertEquals("<p>x</p>", page.data.readBytes().decodeToString())
        assertTrue(HTML_PAGE_POLICY.startsWith("default-src 'none';"))
        assertTrue(HTML_PAGE_POLICY.contains("script-src 'none';"))

        // Anything else, a picture or a page elsewhere, is refused here and never fetched.
        assertEquals(403, client.shouldInterceptRequest(web, request("https://example.com/x.png", mainFrame = false)).statusCode)
        assertEquals(403, client.shouldInterceptRequest(web, request("https://example.com/", mainFrame = true)).statusCode)

        // A tapped link opens where a chat link would; one the page follows by itself goes nowhere.
        assertTrue(client.shouldOverrideUrlLoading(web, request("https://example.com/", mainFrame = true, gesture = true)))
        assertTrue(client.shouldOverrideUrlLoading(web, request("https://example.org/", mainFrame = true, gesture = false)))
        assertEquals(listOf("https://example.com/"), opened)
    }

    @Test
    fun aFragmentGetsTheAppsSchemeAWholeDocumentStaysItsOwn() {
        val dark = htmlPageDocument("<p>x</p>", dark = true, text = Color(0xFFEEEEEE), background = Color(0xFF282828))
        assertTrue(dark.startsWith("<!DOCTYPE html>\n<html data-theme=\"dark\">"))
        assertTrue(dark.contains(":root { color-scheme: dark; background: #282828; }"))
        assertTrue(dark.contains("color: #EEEEEE;"))
        assertTrue(dark.contains("<body>\n<p>x</p>\n</body>"))
        val light = htmlPageDocument("<p>x</p>", dark = false, text = Color(0xFF111111), background = Color(0xFFF0F0F0))
        assertTrue(light.contains("<html data-theme=\"light\">"))
        assertTrue(light.contains(":root { color-scheme: light; background: #F0F0F0; }"))
        val whole = "<!DOCTYPE html>\n<HTML lang=\"en\"><body>hi</body></HTML>"
        assertEquals(whole, htmlPageDocument(whole, dark = true, text = Color.White, background = Color.Black))
    }

    private fun request(url: String, mainFrame: Boolean, gesture: Boolean = false) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = mainFrame
        override fun isRedirect() = false
        override fun hasGesture() = gesture
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    private fun settle() {
        ShadowLooper.idleMainLooper()
        rule.waitForIdle()
    }

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }
}
