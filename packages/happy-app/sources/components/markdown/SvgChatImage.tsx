/**
 * Inline renderer for an SVG chat image (native: iOS / Android).
 *
 * Why this exists rather than `SvgUri`/`SvgXml` used directly: react-native-svg
 * parses some attribute values in NATIVE code at draw time and throws there on
 * anything it does not understand. On Android that is an exception on the UI
 * thread inside `SvgView.onDraw` — unreachable by any JS error boundary — so a
 * single chat message can take the whole app down. It did: an
 * `orient="auto-start-reverse"` arrowhead killed the app with a
 * `NumberFormatException` out of `MarkerView.renderMarker`, measured on an
 * emulator 2026-09-02.
 *
 * So the markup is never handed over raw. `sanitizeSvgMarkup` rewrites the
 * constructs the native parser refuses, and that means the markup has to exist
 * in JS first — which is why a remote `.svg` is fetched here instead of by
 * `SvgUri`, whose fetch and parse both happen natively where we cannot see or
 * fix the payload.
 *
 * The fix lives in JS on purpose. There is also a node_modules patch for the
 * same parser, but it is Java: it ships only in a new APK, and an OTA update
 * carries JS alone. Every phone still on an older build keeps crashing until it
 * reinstalls. This path reaches all of them on the next launch.
 */
import * as React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { parseSvgImageSource } from './svgImageSource';
import { sanitizeSvgMarkup } from './sanitizeSvgMarkup';

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
}

export function SvgChatImage({ uri, accessibilityLabel }: SvgChatImageProps) {
    const source = React.useMemo(() => parseSvgImageSource(uri), [uri]);

    // Inline markup needs no fetch — sanitize it and we are done, on the first
    // render, with no empty frame in between.
    const inlineXml = React.useMemo(() => {
        if (!source || source.kind !== 'xml') return null;
        try {
            return sanitizeSvgMarkup(source.xml);
        } catch {
            return null;
        }
    }, [source]);

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
                const xml = sanitizeSvgMarkup(text);
                remember(source.uri, xml);
                if (!cancelled) setFetchedXml(xml);
            } catch {
                // A diagram that cannot be fetched, or is too big, stays an empty
                // box — the same thing the user saw before any of this existed.
                // Never fall back to handing the raw source to the native
                // renderer: that is the crash this component exists to prevent.
                if (!cancelled) setFetchedXml(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [source]);

    const xml = inlineXml ?? fetchedXml;
    if (!xml) {
        return <View accessible accessibilityLabel={accessibilityLabel} />;
    }
    return (
        <View accessible accessibilityLabel={accessibilityLabel} style={{ flex: 1 }}>
            <SvgXml xml={xml} width="100%" height="100%" />
        </View>
    );
}
