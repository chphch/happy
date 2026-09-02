/**
 * Fullscreen, zoomable Mermaid diagram viewer (native: iOS / Android).
 *
 * Opened via `Modal.show({ component: MermaidViewer, props: { content } })` from
 * the expand button on an inline diagram. Re-renders the diagram in a fullscreen
 * WebView and zooms the SVG *inside* the WebView. Pinch / pan / double-tap are
 * handled by injected JS, so there's no `svg-pan-zoom` dependency.
 *
 * Zooming is two-phase, and that is the whole point of this file. A CSS
 * `transform: scale()` does not re-render an SVG — Chromium rasterizes the layer
 * once and the compositor stretches that bitmap, and `will-change: transform`
 * pins the raster scale so it never catches up. Measured in Chrome at
 * devicePixelRatio 3 by capturing compositor frames (an ordinary screenshot
 * re-rasterizes on capture and hides the problem entirely): at 8x zoom a glyph
 * edge spanned 12.1 px with `will-change` present versus 2.0 px once the SVG is
 * genuinely re-rendered. The blur grew in proportion to the zoom factor, which
 * is the signature of a 1x bitmap being upscaled.
 *
 * So: while fingers are down we keep the cheap composited transform (smooth),
 * and the moment they lift we *commit* — the SVG's own width/height are set to
 * the zoomed size, the transform scale returns to 1, and `will-change` is
 * released. At rest the diagram is then laid out at its true size and painted at
 * the device's full pixel density at any zoom level, instead of depending on
 * Chromium deciding to re-rasterize a scaled layer.
 *
 * Web has a separate implementation in `MermaidViewer.web.tsx`; it never sets
 * `will-change`, and was measured crisp under the same test.
 */
import * as React from 'react';
import { View, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { zoomableSvgHtml } from './zoomableSvgHtml';

interface MermaidViewerProps {
    content: string;
    onClose: () => void;
}

export function MermaidViewer({ content, onClose }: MermaidViewerProps) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const mermaidContent = JSON.stringify(content);

    const html = zoomableSvgHtml({
        head: '<script src="https://cdn.jsdelivr.net/npm/mermaid@11.12.2/dist/mermaid.min.js"><\/script>',
        populate: `    mermaid.initialize({startOnLoad:false,theme:'dark'});
    var r=await mermaid.render('m',${mermaidContent});
    stage.innerHTML=r.svg;`,
    });

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
                accessibilityLabel="Close diagram"
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
