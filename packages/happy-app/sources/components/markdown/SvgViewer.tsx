/**
 * Fullscreen, pinch-to-zoom viewer for an SVG chat image (native: iOS /
 * Android).
 *
 * It runs the same WebView page as MermaidViewer rather than the native
 * ImageViewer, because zoom quality here is bounded by who rasterises: a
 * native SVG view draws one offscreen bitmap sized to the zoom, so detail
 * stops arriving at the point Android refuses the allocation, whereas the
 * browser re-rasterises in tiles and keeps going at constant memory.
 *
 * The SVG is handed to the page as an `<img>`, never as inline markup. An SVG
 * loaded through `<img>` cannot run scripts, and this markup arrives from
 * chat — so the WebView never executes anything the sender wrote.
 */
import * as React from 'react';
import { View, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import { zoomableSvgHtml } from './zoomableSvgHtml';
import { parseSvgImageSource } from './svgImageSource';

interface SvgViewerProps {
    uri: string;
    onClose: () => void;
}

export function SvgViewer({ uri, onClose }: SvgViewerProps) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();

    const html = React.useMemo(() => {
        const svg = parseSvgImageSource(uri);
        // A data URI reaches us already decoded, so re-encode it; a remote .svg
        // is handed to the <img> as-is and fetched by the WebView.
        const src = svg && svg.kind === 'xml'
            ? `data:image/svg+xml;base64,${encodeBase64(encodeUTF8(svg.xml))}`
            : (svg ? svg.uri : uri);
        return zoomableSvgHtml({
            head: '',
            populate: `    var im=document.createElement('img');
    im.src=${JSON.stringify(src)};
    im.onerror=function(){ stage.innerHTML='<div class="error">Could not load image</div>'; };
    stage.appendChild(im);`,
        });
    }, [uri]);

    return (
        <View style={[styles.root, { width, height }]}>
            <WebView
                source={{ html }}
                style={styles.webview}
                scrollEnabled={false}
                originWhitelist={['*']}
            />
            <Pressable
                onPress={onClose}
                hitSlop={16}
                style={[styles.close, { top: Math.max(insets.top, 12) + 4 }]}
                accessibilityRole="button"
                accessibilityLabel="Close image"
            >
                <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { backgroundColor: '#000' },
    webview: { flex: 1, backgroundColor: '#000' },
    close: {
        position: 'absolute',
        right: 12,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
});
