/**
 * Inline renderer for an SVG chat image (native: iOS / Android).
 *
 * Why this exists rather than `SvgUri` used directly: the chat sizes an SVG
 * from its own proportions, and those live in the markup (`width`/`height` or
 * `viewBox`). `SvgUri` fetches and parses a remote `.svg` natively, so the
 * markup never reaches JS. Fetching it here and drawing it with `SvgXml` puts
 * the markup in hand, and its size comes out of the same string at no extra
 * cost.
 *
 * The markup is handed to react-native-svg as it is. The one input known to
 * crash its native parser — an `orient="auto-start-reverse"` marker, which threw
 * a `NumberFormatException` out of `MarkerView.renderMarker` on the UI thread —
 * is fixed in the renderer itself by
 * `patches/fix-react-native-svg-marker-orient.cjs`, shipped in every APK from
 * 2062 on.
 */
import * as React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { parseSvgImageSource } from './svgImageSource';
import { parseSvgIntrinsicSize, type SvgIntrinsicSize } from './svgIntrinsicSize';

/**
 * Remote SVGs are fetched once per URL and kept, so scrolling a long chat back
 * and forth does not refetch the same diagram on every remount. Bounded because
 * this holds decoded markup: a chat can accumulate many images over a session.
 */
const MAX_CACHED = 24;
const cache = new Map<string, string>();

function remember(uri: string, xml: string) {
    if (cache.has(uri)) cache.delete(uri);
    cache.set(uri, xml);
    while (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/**
 * A diagram is markup, so it is small; anything this large is not something we
 * want to hold decoded in memory, nor hand to a renderer that lays out every
 * element as a native draw op.
 */
const MAX_BYTES = 2 * 1024 * 1024;

interface SvgChatImageProps {
    uri: string;
    accessibilityLabel: string;
    /** Reports the SVG's own proportions once the markup is in hand, so the
     *  caller can size the box the way it sizes a raster image. */
    onIntrinsicSize?: (size: SvgIntrinsicSize) => void;
}

export function SvgChatImage({ uri, accessibilityLabel, onIntrinsicSize }: SvgChatImageProps) {
    const source = React.useMemo(() => parseSvgImageSource(uri), [uri]);

    // Inline markup needs no fetch — it is ready on the first render, with no
    // empty frame in between.
    const inlineXml = source && source.kind === 'xml' ? source.xml : null;

    const [fetchedXml, setFetchedXml] = React.useState<string | null>(() =>
        source && source.kind === 'uri' ? cache.get(source.uri) ?? null : null,
    );

    React.useEffect(() => {
        if (!source || source.kind !== 'uri') return;
        const cached = cache.get(source.uri);
        if (cached !== undefined) {
            setFetchedXml(cached);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(source.uri);
                if (!res.ok) throw new Error(`svg fetch ${res.status}`);
                const declared = Number(res.headers.get('content-length') ?? '0');
                if (declared > MAX_BYTES) throw new Error('svg too large');
                const text = await res.text();
                if (text.length > MAX_BYTES) throw new Error('svg too large');
                remember(source.uri, text);
                if (!cancelled) setFetchedXml(text);
            } catch {
                // A diagram that cannot be fetched, or is too big, stays an empty
                // box — the same thing the user saw before any of this existed.
                if (!cancelled) setFetchedXml(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [source]);

    const xml = inlineXml ?? fetchedXml;

    // The markup is already here, so the size costs a parse rather than a
    // second load. Reported in an effect, not during render, because it moves
    // the parent's layout.
    React.useEffect(() => {
        if (!xml || !onIntrinsicSize) return;
        const size = parseSvgIntrinsicSize(xml);
        if (size) onIntrinsicSize(size);
    }, [xml, onIntrinsicSize]);

    if (!xml) {
        return <View accessible accessibilityLabel={accessibilityLabel} />;
    }
    return (
        <View accessible accessibilityLabel={accessibilityLabel} style={{ flex: 1 }}>
            <SvgXml xml={xml} width="100%" height="100%" />
        </View>
    );
}
