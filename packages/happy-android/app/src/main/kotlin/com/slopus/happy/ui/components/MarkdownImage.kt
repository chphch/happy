package com.slopus.happy.ui.components

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import coil3.ImageLoader
import coil3.request.CachePolicy
import coil3.request.ImageRequest
import com.slopus.happy.R
import com.slopus.happy.conversation.ViewerItem
import com.slopus.happy.ui.conversation.PictureViewer
import com.slopus.happy.ui.conversation.ViewerSource
import com.slopus.happy.ui.conversation.viewerOrigin
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object MarkdownImageSpec {
    val maxWidth = 520.dp
    val marginVertical = 8.dp
    val gap = 8.dp

    /** Before its pixels are known a picture holds 4:3 of the width it may take, as happy-app's did. */
    const val PLACEHOLDER_ASPECT = 4f / 3f
    val radius = 12.dp
    val caption = happyTextStyle(fontSize = 14, lineHeight = 20)
}

object MarkdownImageTags {
    const val BLOCK = "markdown.image"
    const val PICTURE = "markdown.image.picture"
    const val CAPTION = "markdown.image.caption"
}

/**
 * MarkdownView.tsx `RenderImageBlock` with happy-app's sizing and viewer: a
 * column up to 520 wide, left-aligned, 8 above and below, 8 between the
 * picture and its caption. The picture, radius 12 on surfaceHighest and
 * fitted inside (contain), holds 4:3 of the column until its pixels are
 * known, then takes its own shape ([markdownImageBox]): as wide as the
 * column at most, never wider than its pixels one to one. An SVG draws too
 * (the loader's SVG decoder). Described by the alt text or "Markdown
 * image". Once it has loaded, a tap on a picture from the web or a `data:`
 * URL opens it in the viewer. The caption is the alt text, 14/20
 * textSecondary, only when there is one.
 */
@Composable
fun MarkdownImage(alt: String, url: String, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val density = LocalDensity.current
    val key = "markdown:$url"
    var picture by remember(url) { mutableStateOf(MarkdownPictures[url]) }
    var loaded by remember(url) { mutableStateOf(false) }
    var viewing by remember { mutableStateOf(false) }
    val opens = loaded && markdownPictureOpens(url)
    Column(
        modifier = modifier
            .padding(vertical = MarkdownImageSpec.marginVertical)
            .widthIn(max = MarkdownImageSpec.maxWidth)
            .fillMaxWidth()
            .testTag(MarkdownImageTags.BLOCK),
        verticalArrangement = Arrangement.spacedBy(MarkdownImageSpec.gap),
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val (width, height) = markdownImageBox(maxWidth.value, picture)
            val asked = with(density) { width.dp.toPx() to height.dp.toPx() }
            RemoteImage(
                model = url,
                contentDescription = alt.ifEmpty { stringResource(R.string.chat_markdown_image) },
                contentScale = ContentScale.Fit,
                background = colors.surfaceHighest,
                cacheKey = key,
                modifier = Modifier
                    .testTag(MarkdownImageTags.PICTURE)
                    .size(width.dp, height.dp)
                    .viewerOrigin(key, MarkdownImageSpec.radius)
                    .clip(RoundedCornerShape(MarkdownImageSpec.radius))
                    .then(if (opens) Modifier.clickable(role = Role.Image) { viewing = true } else Modifier),
                onState = { loaded = it == RemoteImageState.Success },
                onImage = { image ->
                    // Learnt once, against the box it was first asked to fill: smaller than that, it came whole.
                    if (picture == null && image.width > 0 && image.height > 0) {
                        val whole = image.width < asked.first - 1 && image.height < asked.second - 1
                        MarkdownPicture(image.width, image.height, whole).also {
                            MarkdownPictures[url] = it
                            picture = it
                        }
                    }
                },
            )
        }
        if (alt.isNotEmpty()) {
            Text(alt, style = MarkdownImageSpec.caption, color = colors.textSecondary, modifier = Modifier.testTag(MarkdownImageTags.CAPTION))
        }
    }
    if (viewing) MarkdownPictureViewer(url, key, alt, picture) { viewing = false }
}

/** One markdown picture alone in the viewer, its bytes read again whole. */
@Composable
private fun MarkdownPictureViewer(url: String, key: String, alt: String, picture: MarkdownPicture?, onClose: () -> Unit) {
    val context = LocalContext.current
    val loader = rememberImageLoader()
    val source = remember(url, loader) {
        object : ViewerSource {
            override suspend fun bytes(key: String): ByteArray? = markdownPictureBytes(context, loader, url)
        }
    }
    val whole = picture?.takeIf { it.whole }
    PictureViewer(listOf(ViewerItem(key, alt.ifEmpty { null }, width = whole?.width?.toFloat(), height = whole?.height?.toFloat())), 0, source, onClose = onClose)
}

/** A markdown picture's pixels as decoded, and whether that is all of them (not scaled down to the box it was asked to fill). */
@Immutable
internal data class MarkdownPicture(val width: Int, val height: Int, val whole: Boolean)

/** What markdown pictures turned out to be while the app runs: a row scrolled back keeps its picture's shape. */
internal object MarkdownPictures {
    private val known = LruCache<String, MarkdownPicture>(256)

    operator fun get(url: String): MarkdownPicture? = known.get(url)

    operator fun set(url: String, picture: MarkdownPicture) {
        known.put(url, picture)
    }
}

/**
 * The box a markdown picture takes in [available] dp of width, as happy-app
 * sized one: no wider than [MarkdownImageSpec.maxWidth]; before its pixels
 * are known 4:3 of that width; known, its own shape, never wider than its
 * pixels one to one when it came [MarkdownPicture.whole], else all that width.
 */
internal fun markdownImageBox(available: Float, picture: MarkdownPicture?): Pair<Float, Float> {
    val width = minOf(available, MarkdownImageSpec.maxWidth.value)
    if (picture == null || picture.width <= 0 || picture.height <= 0) return width to width / MarkdownImageSpec.PLACEHOLDER_ASPECT
    val shown = if (picture.whole) minOf(width, picture.width.toFloat()) else width
    return shown to shown * picture.height / picture.width
}

/** Whether a tap opens the picture: one from the web or carried in a `data:` URL, whose bytes the viewer can have. */
internal fun markdownPictureOpens(url: String): Boolean = isRemoteImageUrl(url) || url.startsWith("data:image/", ignoreCase = true)

/** A markdown picture's bytes: a `data:` URL's own, or a web picture's as the loader keeps it on disk, read again if it has let it go. */
internal suspend fun markdownPictureBytes(context: Context, loader: ImageLoader, url: String): ByteArray? = withContext(Dispatchers.IO) {
    if (url.startsWith("data:", ignoreCase = true)) return@withContext dataUrlBytes(url)
    if (!isRemoteImageUrl(url)) return@withContext null
    val disk = loader.diskCache ?: return@withContext null
    fun kept(): ByteArray? = runCatching { disk.openSnapshot(url)?.use { snapshot -> disk.fileSystem.read(snapshot.data) { readByteArray() } } }.getOrNull()
    kept() ?: run {
        loader.execute(ImageRequest.Builder(context).data(url).memoryCachePolicy(CachePolicy.DISABLED).build())
        kept()
    }
}

/** A `data:` URL's bytes, base64 or percent-encoded; null when it isn't one or doesn't decode. */
internal fun dataUrlBytes(url: String): ByteArray? {
    if (!url.startsWith("data:", ignoreCase = true)) return null
    val comma = url.indexOf(',')
    if (comma < 0) return null
    val meta = url.substring(5, comma)
    val payload = url.substring(comma + 1)
    return runCatching {
        if (meta.endsWith(";base64", ignoreCase = true)) Base64.decode(payload, Base64.DEFAULT) else Uri.decode(payload).toByteArray()
    }.getOrNull()
}
