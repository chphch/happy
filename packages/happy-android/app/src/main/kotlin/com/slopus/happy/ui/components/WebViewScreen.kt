package com.slopus.happy.ui.components

import android.content.Context
import android.util.LruCache
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R
import com.slopus.happy.ui.browser.LocalLinkOpener
import com.slopus.happy.ui.theme.HappyTheme

object WebViewScreenSpec {
    /** The expand button: a code block's quiet copy button's box, radius, inset, glyph and reach. */
    val expandBox = 24.dp
    val expandRadius = 6.dp
    val expandInset = 6.dp
    val expandIcon = 14.dp
    val expandReach = 40.dp

    /** Full screen's close button: the picture viewer's, 44 round, 8 in from the safe area's top right. */
    val closeSize = 44.dp
    val closeIcon = 24.dp
    val closeInset = 8.dp
}

object WebViewScreenTags {
    const val CLOSE = "webview.screen.close"
}

/**
 * A WebView full screen on surfaceHighest, edge to edge with its content
 * inside the safe area; a close button, 44 round on the surface with a 24
 * close glyph, 8 in from the safe area's top right. Back or the button
 * leaves. [create] makes the WebView, [show] loads it.
 */
@Composable
internal fun WebViewScreen(onClose: () -> Unit, tag: String, create: (Context) -> WebView, show: (WebView) -> Unit) {
    val colors = HappyTheme.colors
    PageDialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(colors.surfaceHighest).testTag(tag)) {
            AndroidView(
                factory = create,
                update = show,
                onRelease = { view ->
                    view.stopLoading()
                    view.destroy()
                },
                modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing),
            )
            val label = stringResource(R.string.browser_close)
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .windowInsetsPadding(WindowInsets.safeDrawing)
                    .padding(WebViewScreenSpec.closeInset)
                    .size(WebViewScreenSpec.closeSize)
                    .clip(CircleShape)
                    .background(colors.surface)
                    .clickable(role = Role.Button, onClick = onClose)
                    .clearAndSetSemantics {
                        contentDescription = label
                        role = Role.Button
                        testTag = WebViewScreenTags.CLOSE
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ionicon.Close, WebViewScreenSpec.closeIcon, colors.text)
            }
        }
    }
}

/**
 * The button that opens a page or a diagram full screen: a code block's
 * quiet copy button with the expand glyph, a 24 box radius 6 on
 * surfaceHighest 6 in from its corner, a 14 glyph in textSecondary,
 * reached 40 around; described "Open full screen".
 */
@Composable
internal fun ExpandButton(onClick: () -> Unit, tag: String, modifier: Modifier) {
    val colors = HappyTheme.colors
    val label = stringResource(R.string.side_chat_expand)
    Box(
        modifier = modifier
            .size(WebViewScreenSpec.expandReach)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                testTag = tag
            },
    ) {
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = WebViewScreenSpec.expandInset, end = WebViewScreenSpec.expandInset)
                .size(WebViewScreenSpec.expandBox)
                .clip(RoundedCornerShape(WebViewScreenSpec.expandRadius))
                .background(colors.surfaceHighest),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Ionicon.ExpandOutline, WebViewScreenSpec.expandIcon, colors.textSecondary)
        }
    }
}

/** Where a link tapped in a page or a diagram goes: where a chat link would ([LocalLinkOpener]), else the system. */
@Composable
internal fun rememberWebLinkOpener(): (String) -> Unit {
    val opener = LocalLinkOpener.current
    val system = LocalUriHandler.current
    return remember(opener, system) {
        { url ->
            if (opener != null) opener.open(url) else runCatching { system.openUri(url) }
            Unit
        }
    }
}

/**
 * What pages and diagrams measured while the app runs, so a row scrolled
 * away and back returns at its height. Keyed by what was drawn ("page:" or
 * "mermaid:" and its source).
 */
internal object PageHeights {
    private val heights = LruCache<String, Float>(256)

    private fun key(source: String) = "${source.length}:${source.hashCode()}"

    operator fun get(source: String): Float? = heights.get(key(source))

    operator fun set(source: String, height: Float) {
        heights.put(key(source), height)
    }
}
