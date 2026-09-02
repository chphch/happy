/**
 * Fullscreen, pinch-to-zoom image viewer (native: iOS / Android).
 *
 * Opened via `Modal.show({ component: ImageViewer, props: { uri } })`. Because
 * it is presented inside React Native's `<Modal>` (via BaseModal), gestures
 * only work if the content is wrapped in its OWN `GestureHandlerRootView` — the
 * app-root one does not extend into the modal's separate native hierarchy.
 *
 * Web has a separate implementation in `ImageViewer.web.tsx` (wheel + drag).
 */
import * as React from 'react';
import { StyleSheet, useWindowDimensions, Pressable, Platform } from 'react-native';
import { Image } from 'expo-image';
import { SvgUri, SvgXml } from 'react-native-svg';
import { parseSvgImageSource } from './markdown/svgImageSource';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView, GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;

interface ImageViewerProps {
    uri: string;
    onClose: () => void;
}

export function ImageViewer({ uri, onClose }: ImageViewerProps) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    // expo-image decodes raster formats only, so an SVG goes through
    // react-native-svg instead.
    const svg = React.useMemo(() => parseSvgImageSource(uri), [uri]);
    const isSvg = svg !== null;

    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const tx = useSharedValue(0);
    const ty = useSharedValue(0);
    const savedTx = useSharedValue(0);
    const savedTy = useSharedValue(0);

    // Transform alone does not re-draw an SVG: the renderer rasterises its
    // paths once at the layout size and the gesture then magnifies that
    // raster, so it blurs exactly like a bitmap (measured at 4x: 3.0 px edge
    // spread, identical to the PNG of the same picture). So once a gesture
    // settles we COMMIT — the SVG is re-rendered at the zoomed size and the
    // transform drops back to 1, the same trick MermaidViewer uses.
    // `committedSv` mirrors the state for the worklet, which cannot read
    // React state.
    const committedSv = useSharedValue(1);
    const [committed, setCommitted] = React.useState(1);
    // react-native-svg draws into an offscreen bitmap (SvgView.onDraw ->
    // drawBitmap), so the committed size is bounded by Android's 100 MB canvas
    // limit: bytes grow with the square of the multiplier, and 4x of a
    // 1080x2340 screen is 143 MB — a hard RuntimeException, measured. Cap the
    // bake with headroom and let the transform cover any zoom past it (blurry
    // beyond the cap, but never a crash).
    const maxCommit = React.useMemo(() => {
        const bytesAt1x = width * height * 4;
        const budget = 60 * 1024 * 1024;
        return Math.max(1, Math.min(MAX_SCALE, Math.sqrt(budget / bytesAt1x)));
    }, [width, height]);
    const commit = React.useCallback((next: number) => {
        const capped = Math.min(next, maxCommit);
        committedSv.value = capped;
        setCommitted(capped);
    }, [committedSv, maxCommit]);

    // Keep the image from being panned entirely off-screen: at scale S the
    // image overflows the viewport by (S-1) on each axis, so allow half of
    // that overflow as translation in each direction.
    const clamp = (val: number, scaleVal: number, dim: number) => {
        'worklet';
        const max = (dim * (scaleVal - 1)) / 2;
        return Math.min(max, Math.max(-max, val));
    };

    const pinch = Gesture.Pinch()
        .onUpdate((e) => {
            scale.value = Math.min(MAX_SCALE, Math.max(0.8, savedScale.value * e.scale));
        })
        .onEnd(() => {
            if (scale.value <= 1) {
                scale.value = withTiming(1);
                tx.value = withTiming(0);
                ty.value = withTiming(0);
                savedScale.value = 1;
                savedTx.value = 0;
                savedTy.value = 0;
                if (isSvg) {
                    runOnJS(commit)(1);
                }
            } else {
                savedScale.value = scale.value;
                tx.value = clamp(tx.value, scale.value, width);
                ty.value = clamp(ty.value, scale.value, height);
                savedTx.value = tx.value;
                savedTy.value = ty.value;
                if (isSvg) {
                    runOnJS(commit)(scale.value);
                }
            }
        });

    const pan = Gesture.Pan()
        .onUpdate((e) => {
            if (savedScale.value <= 1) return; // pan only when zoomed in
            tx.value = clamp(savedTx.value + e.translationX, savedScale.value, width);
            ty.value = clamp(savedTy.value + e.translationY, savedScale.value, height);
        })
        .onEnd(() => {
            savedTx.value = tx.value;
            savedTy.value = ty.value;
        });

    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
            if (scale.value > 1) {
                scale.value = withTiming(1);
                tx.value = withTiming(0);
                ty.value = withTiming(0);
                savedScale.value = 1;
                savedTx.value = 0;
                savedTy.value = 0;
                if (isSvg) {
                    runOnJS(commit)(1);
                }
            } else {
                scale.value = withTiming(DOUBLE_TAP_SCALE);
                savedScale.value = DOUBLE_TAP_SCALE;
                if (isSvg) {
                    runOnJS(commit)(DOUBLE_TAP_SCALE);
                }
            }
        });

    // Race so pan/pinch activate immediately on movement (no double-tap delay);
    // a real double-tap has no movement so it wins the race instead.
    const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: tx.value },
            { translateY: ty.value },
            // The committed part of an SVG's zoom already lives in its own
            // width/height, so the transform carries only the remainder.
            { scale: scale.value / committedSv.value },
        ],
    }));

    return (
        <GestureHandlerRootView style={[styles.root, { width, height }]}>
            <GestureDetector gesture={gesture}>
                <Animated.View style={[styles.imageWrap, animatedStyle, { width, height }]}>
                    {svg ? (
                        svg.kind === 'xml' ? (
                            <SvgXml xml={svg.xml} width={width * committed} height={height * committed} />
                        ) : (
                            <SvgUri uri={svg.uri} width={width * committed} height={height * committed} />
                        )
                    ) : (
                        <Image
                            source={{ uri }}
                            style={{ width, height }}
                            contentFit="contain"
                            transition={Platform.OS === 'android' ? 0 : 120}
                        />
                    )}
                </Animated.View>
            </GestureDetector>
            <Pressable
                onPress={onClose}
                hitSlop={16}
                style={[styles.close, { top: Math.max(insets.top, 12) + 4 }]}
                accessibilityRole="button"
                accessibilityLabel="Close image"
            >
                <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    root: {
        backgroundColor: '#000',
        alignItems: 'center',
        justifyContent: 'center',
    },
    imageWrap: {
        alignItems: 'center',
        justifyContent: 'center',
    },
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
