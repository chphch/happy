/**
 * Fullscreen viewer for an ```artifact block (native: iOS / Android).
 *
 * Opened via `Modal.show({ component: ArtifactViewer, props: { content } })`
 * from the expand button on the inline renderer. Unlike the inline frame this
 * one scrolls, so a page taller than the screen is reachable.
 *
 * Web has a separate implementation in `ArtifactViewer.web.tsx`.
 */
import * as React from 'react';
import { View, Pressable, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { buildArtifactDocument, isSandboxedNavigation } from './artifactDocument';

interface ArtifactViewerProps {
    content: string;
    onClose: () => void;
}

export function ArtifactViewer({ content, onClose }: ArtifactViewerProps) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { theme, rt } = useUnistyles();

    const html = React.useMemo(() => buildArtifactDocument({
        content,
        theme: rt.themeName === 'dark' ? 'dark' : 'light',
        bridge: 'react-native'
    }), [content, rt.themeName]);

    return (
        <View style={[style.root, { width, height }]}>
            <WebView
                source={{ html }}
                originWhitelist={['*']}
                style={style.webview}
                containerStyle={{ backgroundColor: theme.colors.surface }}
                setSupportMultipleWindows={false}
                onShouldStartLoadWithRequest={(request) => isSandboxedNavigation(request.url)}
            />
            <Pressable
                onPress={onClose}
                hitSlop={16}
                style={[style.close, { top: Math.max(insets.top, 12) + 4 }]}
                accessibilityRole="button"
                accessibilityLabel="Close artifact"
            >
                <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
        </View>
    );
}

const style = StyleSheet.create((theme) => ({
    root: {
        backgroundColor: theme.colors.surface
    },
    webview: {
        flex: 1,
        backgroundColor: theme.colors.surface
    },
    close: {
        position: 'absolute',
        right: 12,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)'
    }
}));
