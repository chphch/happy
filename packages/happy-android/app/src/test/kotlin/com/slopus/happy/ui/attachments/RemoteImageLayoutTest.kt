package com.slopus.happy.ui.attachments

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil3.ImageLoader
import coil3.intercept.Interceptor
import coil3.request.ErrorResult
import coil3.request.ImageResult
import coil3.test.FakeImage
import coil3.test.FakeImageLoaderEngine
import com.slopus.happy.model.Profile
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.LocalImageLoader
import com.slopus.happy.ui.components.MarkdownImage
import com.slopus.happy.ui.components.MarkdownImageTags
import com.slopus.happy.ui.components.MarkdownPicture
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.dataUrlBytes
import com.slopus.happy.ui.components.markdownImageBox
import com.slopus.happy.ui.components.markdownPictureOpens
import com.slopus.happy.ui.conversation.PictureViewerTags
import com.slopus.happy.ui.components.RemoteImageState
import com.slopus.happy.ui.components.RemoteImageTags
import com.slopus.happy.ui.components.isRemoteImageUrl
import com.slopus.happy.ui.node
import com.slopus.happy.ui.settings.ProfileAvatar
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/** The shared image loader's three users: profile pictures, markdown images, and its own states. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class RemoteImageLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val requested = CopyOnWriteArrayList<Any>()
    private val broken = "https://example.com/broken.png"
    private val large = "https://example.com/large.png"

    private val loader = ImageLoader.Builder(ApplicationProvider.getApplicationContext())
        .components {
            add(
                FakeImageLoaderEngine.Builder()
                    .intercept({ it == broken }, object : FakeImageLoaderEngine.OptionalInterceptor {
                        override suspend fun intercept(chain: Interceptor.Chain): ImageResult = ErrorResult(null, chain.request, IOException("404"))
                    })
                    .intercept({ requested += it; false }, FakeImage())
                    .intercept({ it == large }, FakeImage(width = 4000, height = 2000))
                    .default(FakeImage(width = 64, height = 64))
                    .build(),
            )
        }
        .build()

    @Test
    fun onlyHttpUrlsAreRemote() {
        assertTrue(isRemoteImageUrl("https://avatars.githubusercontent.com/u/1"))
        assertTrue(isRemoteImageUrl("HTTP://x/y.png"))
        listOf(null, "data:image/png;base64,AAAA", "file:///x.jpg", "/relative.png").forEach { assertFalse("$it", isRemoteImageUrl(it)) }
    }

    @Test
    fun statesAreReported() {
        val states = CopyOnWriteArrayList<RemoteImageState>()
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box {
                    RemoteImage("https://example.com/a.png", null, Modifier.size(10.dp), onState = { states += it })
                }
            }
        }
        rule.waitUntil(5_000) { RemoteImageState.Success in states }
    }

    @Test
    fun errorsAreReported() {
        val states = CopyOnWriteArrayList<RemoteImageState>()
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box { RemoteImage(broken, null, Modifier.size(10.dp), onState = { states += it }) }
            }
        }
        rule.waitUntil(5_000) { RemoteImageState.Error in states }
    }

    @Test
    fun theProfilePictureLoadsByUrl() {
        val profile = Profile(
            id = "account-1", timestamp = 0, firstName = "Ada", lastName = null, avatar = null,
            github = null, connectedServices = emptyList(),
        )
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                ProfileAvatar(profile.copy(avatar = com.slopus.happy.model.ImageRef(1.0, 1.0, "", "p", "https://cdn.example/a.jpg")), 90.dp)
            }
        }
        rule.waitUntil(5_000) { "https://cdn.example/a.jpg" in requested }
        assertBox("picture", rule.node(RemoteImageTags.IMAGE).getUnclippedBoundsInRoot(), 0.dp, 0.dp, 90.dp, 90.dp)
    }

    @Test
    fun aGeneratedAvatarLoadsNothing() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) { Avatar(id = "x", size = 48.dp) }
        }
        rule.waitForIdle()
        rule.node(RemoteImageTags.IMAGE).assertDoesNotExist()
    }

    @Test
    fun aMarkdownPictureHolds4To3OfTheColumnUntilItsPixelsAreKnown() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box(Modifier.fillMaxWidth()) { MarkdownImage("Never arrives", broken) }
            }
        }
        rule.waitForIdle()
        val block = rule.node(MarkdownImageTags.BLOCK).getUnclippedBoundsInRoot()
        val image = rule.node(MarkdownImageTags.PICTURE).getUnclippedBoundsInRoot()
        val caption = rule.node(MarkdownImageTags.CAPTION).getUnclippedBoundsInRoot()
        // 411 wide phone: the whole width at 4:3, 8 above, 8 to the caption.
        assertBox("placeholder", image, 0.dp, 8.dp, 411.dp, 308.25.dp)
        assertEquals(image.bottom + 8.dp, caption.top)
        assertEquals(caption.bottom, block.bottom)
        // Nothing loaded, nothing to open.
        rule.node(MarkdownImageTags.PICTURE).performClick()
        rule.waitForIdle()
        rule.node(PictureViewerTags.VIEWER).assertDoesNotExist()
    }

    @Test
    fun aSmallPictureIsNeverEnlarged() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box(Modifier.fillMaxWidth()) { MarkdownImage("A badge", "https://example.com/badge.png") }
            }
        }
        rule.waitUntil(5_000) { pictureWidth() < 100.dp }
        // 64 × 64 pixels, one to one.
        assertBox("whole", rule.node(MarkdownImageTags.PICTURE).getUnclippedBoundsInRoot(), 0.dp, 8.dp, 64.dp, 64.dp)
    }

    @Test
    fun aLargePictureTakesTheColumnInItsOwnShape() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box(Modifier.fillMaxWidth()) { MarkdownImage("Wide", large) }
            }
        }
        rule.waitUntil(5_000) { rule.node(MarkdownImageTags.PICTURE).getUnclippedBoundsInRoot().let { it.bottom - it.top } < 300.dp }
        // 4000 × 2000: all 411 of the column at 2:1.
        assertBox("wide", rule.node(MarkdownImageTags.PICTURE).getUnclippedBoundsInRoot(), 0.dp, 8.dp, 411.dp, 205.5.dp)
    }

    @Test
    fun markdownPicturesStopAt520AndHaveNoCaptionWithoutAlt() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box(Modifier.wrapContentWidth(unbounded = true).requiredWidth(700.dp)) { MarkdownImage("", large) }
            }
        }
        rule.waitUntil(5_000) { rule.node(MarkdownImageTags.PICTURE).getUnclippedBoundsInRoot().let { it.bottom - it.top } < 300.dp }
        assertBox("capped", rule.node(MarkdownImageTags.PICTURE).getUnclippedBoundsInRoot(), 0.dp, 8.dp, 520.dp, 260.dp)
        rule.node(MarkdownImageTags.CAPTION).assertDoesNotExist()
    }

    @Test
    fun aLoadedPictureOpensInTheViewer() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box(Modifier.fillMaxWidth()) { MarkdownImage("A plot", "https://example.com/plot.png") }
            }
        }
        rule.waitUntil(5_000) { pictureWidth() < 100.dp }
        rule.node(PictureViewerTags.VIEWER).assertDoesNotExist()
        rule.node(MarkdownImageTags.PICTURE).performClick()
        rule.waitForIdle()
        rule.node(PictureViewerTags.VIEWER).assertExists()
    }

    @Test
    fun aDataUrlsBytesAreItsOwn() {
        assertEquals("abc", dataUrlBytes("data:text/plain;base64,YWJj")!!.decodeToString())
        assertEquals("<svg/>", dataUrlBytes("data:image/svg+xml,%3Csvg%2F%3E")!!.decodeToString())
        assertEquals(null, dataUrlBytes("https://example.com/a.png"))
        assertTrue(markdownPictureOpens("https://example.com/a.png"))
        assertTrue(markdownPictureOpens("data:image/png;base64,AAAA"))
        listOf("file:///x.png", "/relative.png", "content://x/y").forEach { assertFalse(it, markdownPictureOpens(it)) }
    }

    @Test
    fun aPicturesBox() {
        assertEquals(411f to 308.25f, markdownImageBox(411f, null))
        assertEquals(520f to 390f, markdownImageBox(700f, null))
        // Whole: its pixels one to one, at most the column; scaled down when decoded: all the column.
        assertEquals(64f to 32f, markdownImageBox(411f, MarkdownPicture(64, 32, whole = true)))
        assertEquals(411f to 822f, markdownImageBox(411f, MarkdownPicture(500, 1000, whole = true)))
        assertEquals(411f to 102.75f, markdownImageBox(411f, MarkdownPicture(1079, 270, whole = false)))
    }

    private fun pictureWidth() = rule.node(MarkdownImageTags.PICTURE).getUnclippedBoundsInRoot().let { it.right - it.left }
}
