package com.slopus.happy.ui.components

import android.view.View
import android.view.ViewGroup
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.MarkdownSpan
import com.slopus.happy.chat.markdown.SpanStyle
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MarkdownTags
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.chat.spansToAnnotatedString
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
 * Display math: KaTeX in a see-through WebView, full width with 4 above
 * and below, 48 high until the page reports the formula's height, then that
 * height, kept for the next row with the same formula. Where there is no
 * WebView (Robolectric) it is a "latex" code block. Math inside a sentence
 * is its symbols in the italic serif.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class MathLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun robolectricFallsBackToALatexCodeBlock() {
        rule.setHappyContent { MarkdownView(parseMarkdown("\$\$ E = mc^2 \$\$"), Modifier.fillMaxWidth()) }
        rule.node(MarkdownTags.CODE_BLOCK).assertExists()
        rule.node(MathTags.BLOCK).assertDoesNotExist()
        rule.onNode(hasText("latex"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun aFormulaStartsAt48AndKeepsItsReportedHeight() {
        var root: View? = null
        var shown by mutableStateOf(true)
        val tex = "\\int_0^1 x^{${System.nanoTime() % 1000}} dx"
        rule.setHappyContent {
            root = LocalView.current
            CompositionLocalProvider(LocalMathWebView provides true) {
                if (shown) MarkdownView(parseMarkdown("\$\$ $tex \$\$"), Modifier.fillMaxWidth())
            }
        }
        rule.node(MarkdownTags.CODE_BLOCK).assertDoesNotExist()
        assertBox("formula", rule.node(MathTags.BLOCK).bounds, 0.dp, 4.dp, 411.dp, 48.dp)

        val web = findWebView(root!!.rootView)!!
        val page = shadowOf(web).lastLoadDataWithBaseURL.data
        assertTrue(page.contains("${MathSpec.KATEX}/katex.min.js"))
        assertTrue(page.contains("trust: false"))
        assertFalse(web.settings.allowFileAccess)
        (shadowOf(web).getJavascriptInterface("ReactNativeWebView") as MermaidBridge).postMessage("""{"type":"dimensions","height":72}""")
        settle()
        assertBox("measured", rule.node(MathTags.BLOCK).bounds, 0.dp, 4.dp, 411.dp, 72.dp)

        // Scrolled away and back, it is at its height from the first frame.
        shown = false
        settle()
        shown = true
        settle()
        assertBox("again", rule.node(MathTags.BLOCK).bounds, 0.dp, 4.dp, 411.dp, 72.dp)
    }

    @Test
    fun theTexGoesInSafely() {
        val page = mathHtml("a </script><b> b", Color(0xFF101010))
        assertFalse("no raw </script> from the formula", page.contains("</script><b>"))
        assertTrue(page.contains("const tex = \"a \\u003c/script>\\u003cb> b\";"))
        assertTrue(page.contains("color: #101010;"))
    }

    @Test
    fun mathInsideASentenceIsTheItalicSerif() {
        val style = spansToAnnotatedString(listOf(MarkdownSpan(setOf(SpanStyle.Math), "x²"))).spanStyles.single().item
        assertEquals(FontStyle.Italic, style.fontStyle)
        assertEquals(FontFamily.Serif, style.fontFamily)
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
