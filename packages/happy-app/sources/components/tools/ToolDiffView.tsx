import * as React from 'react';
import { View } from 'react-native';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { useSetting } from '@/sync/storage';

/**
 * Default cap on inline-rendered diff lines for chat tool views. A pending
 * Write/Edit permission for a large file would otherwise render the whole
 * file as synchronous <Text> nodes on session entry and peg the JS thread
 * (frozen taps, dead back button, unrendered history). Full-screen views
 * opt out by passing `maxLines={Number.POSITIVE_INFINITY}`.
 */
export const INLINE_DIFF_MAX_LINES = 200;

interface ToolDiffViewProps {
    /** Pre-built unified-diff patch string. Preferred when available. */
    patch?: string;
    /** Pair used to derive a patch if `patch` isn't supplied. */
    oldText?: string;
    newText?: string;
    /** File name — used for language detection in syntax highlighting. */
    fileName?: string;
    style?: any;
    /** No-op in the new renderer (pierre/diffs always draws line numbers via gutter). Kept for source compat. */
    showLineNumbers?: boolean;
    /** No-op in the new renderer; pierre/diffs uses classic indicators. */
    showPlusMinusSymbols?: boolean;
    /**
     * Native-only cap on inline-rendered diff lines. Defaults to
     * `INLINE_DIFF_MAX_LINES`. Full-screen views pass
     * `Number.POSITIVE_INFINITY` to render the complete diff.
     */
    maxLines?: number;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({
    patch,
    oldText,
    newText,
    fileName,
    style,
    showLineNumbers,
    maxLines = INLINE_DIFF_MAX_LINES,
}) => {
    const wrapLines = useSetting('wrapLinesInDiffs');
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');

    const effectiveFileName = fileName ?? 'file.txt';

    // Chat tool diffs are always inline unified — the split view lives on the
    // dedicated InlineFileDiff pane (controlled via the diffStyle setting).
    const common = {
        overflow: wrapLines ? ('wrap' as const) : ('scroll' as const),
        disableLineNumbers: !(showLineNumbers ?? showLineNumbersInToolViews),
        disableFileHeader: true,
        diffStyle: 'unified' as const,
    };

    if (patch) {
        return (
            <View style={[{ flex: 1 }, style]}>
                <PierreDiffView patch={patch} maxLines={maxLines} {...common} />
            </View>
        );
    }

    return (
        <View style={[{ flex: 1 }, style]}>
            <PierreDiffView
                oldFile={{ name: effectiveFileName, contents: oldText ?? '' }}
                newFile={{ name: effectiveFileName, contents: newText ?? '' }}
                maxLines={maxLines}
                {...common}
            />
        </View>
    );
});
