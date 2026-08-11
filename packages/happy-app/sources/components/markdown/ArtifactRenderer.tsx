/**
 * Inline renderer for an ```artifact block (native: iOS / Android).
 *
 * Renders the block's HTML in a WebView sized by the height the content reports
 * over the bridge, capped so a long page cannot take over the chat. Inline
 * scrolling stays off because the chat list swallows that gesture on Android —
 * the expand button opens the full-height viewer instead.
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
const MAX_INLINE_HEIGHT = 480;

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
            setHeight(Math.min(Math.max(reported, MIN_HEIGHT), MAX_INLINE_HEIGHT));
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
