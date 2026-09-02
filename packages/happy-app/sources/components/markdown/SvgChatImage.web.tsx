/**
 * Inline SVG chat image on web — unchanged from what this always did.
 *
 * The native file next to this one fetches and rewrites the markup because
 * react-native-svg parses it in Java/ObjC and throws there on anything it does
 * not implement, killing the process. On web there is no such parser: the
 * markup reaches the browser's own SVG engine, which implements the whole
 * spec and renders an unsupported-by-native construct correctly. So web keeps
 * the direct path — and keeps letting the browser fetch a remote `.svg`, which
 * avoids putting a cross-origin `fetch` (and the CORS headers it would need) on
 * a path that has never had one.
 */
import * as React from 'react';
import { View } from 'react-native';
import { SvgUri, SvgXml } from 'react-native-svg';
import { parseSvgImageSource } from './svgImageSource';

interface SvgChatImageProps {
    uri: string;
    accessibilityLabel: string;
}

export function SvgChatImage({ uri, accessibilityLabel }: SvgChatImageProps) {
    const source = React.useMemo(() => parseSvgImageSource(uri), [uri]);
    if (!source) {
        return <View accessible accessibilityLabel={accessibilityLabel} />;
    }
    return (
        <View accessible accessibilityLabel={accessibilityLabel} style={{ flex: 1 }}>
            {source.kind === 'xml' ? (
                <SvgXml xml={source.xml} width="100%" height="100%" />
            ) : (
                <SvgUri uri={source.uri} width="100%" height="100%" />
            )}
        </View>
    );
}
