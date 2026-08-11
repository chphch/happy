/**
 * Inline renderer for an ```artifact block (native: iOS / Android).
 *
 * Renders the block's HTML in a WebView sized to the full height the content
 * reports over the bridge, so nothing is cropped and the chat scrolls the page
 * as one. Inline scrolling stays off because the chat list swallows that gesture
 * on Android — with the frame at full height there is nothing to scroll anyway.
 *
 * Web has a separate implementation in `ArtifactRenderer.web.tsx`.
 */
import * as React from 'react';
import { View, Pressable } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { buildArtifactDocument, isSandboxedNavigation, parseArtifactHeight } from './artifactDocument';
import { ArtifactViewer } from './ArtifactViewer';

const MIN_HEIGHT = 120;
// Runaway guard on the reported height, NOT a design cap. An earlier 480 cap
// silently cropped every taller page — the same mistake MermaidRenderer made and
// undid. Keep a ceiling only so a bad measurement cannot produce an absurd box.
const MAX_REPORTED_HEIGHT = 8000;

export const ArtifactRenderer = React.memo((props: { content: string }) => {
    const { theme, rt } = useUnistyles();
    const [height, setHeight] = React.useState(MIN_HEIGHT);

    const html = React.useMemo(() => buildArtifactDocument({
        content: props.content,
        theme: rt.themeName === 'dark' ? 'dark' : 'light',
        bridge: 'react-native'
    }), [props.content, rt.themeName]);

    const openViewer = React.useCallback(() => {
        Modal.show({ component: ArtifactViewer, props: { content: props.content } } as any);
    }, [props.content]);

    const onMessage = React.useCallback((event: { nativeEvent: { data: string } }) => {
        const reported = parseArtifactHeight(event.nativeEvent.data);
        if (reported !== null) {
            setHeight(Math.min(Math.max(reported, MIN_HEIGHT), MAX_REPORTED_HEIGHT));
        }
    }, []);

    return (
        <View style={style.container}>
            <View style={[style.frame, { height }]}>
                <WebView
                    source={{ html }}
                    originWhitelist={['*']}
                    style={style.webview}
                    scrollEnabled={false}
                    setSupportMultipleWindows={false}
                    onMessage={onMessage}
                    onShouldStartLoadWithRequest={(request) => isSandboxedNavigation(request.url)}
                />
            </View>
            <Pressable
                onPress={openViewer}
                hitSlop={8}
                style={style.expandBtn}
                accessibilityRole="button"
                accessibilityLabel="Expand artifact"
            >
                <Ionicons name="expand" size={16} color="#fff" />
            </Pressable>
        </View>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%'
    },
    frame: {
        width: '100%',
        borderRadius: 8,
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceHighest
    },
    webview: {
        flex: 1,
        backgroundColor: theme.colors.surfaceHighest
    },
    expandBtn: {
        position: 'absolute',
        top: 12,
        right: 12,
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)'
    }
}));
