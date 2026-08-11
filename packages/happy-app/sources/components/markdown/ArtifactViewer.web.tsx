/**
 * Fullscreen viewer for an ```artifact block (web).
 *
 * Same sandboxed iframe as the inline renderer, sized to the window so the page
 * scrolls inside itself. Esc or × closes. Metro resolves this over
 * `ArtifactViewer.tsx` on web.
 */
import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { buildArtifactDocument } from './artifactDocument';

interface ArtifactViewerProps {
    content: string;
    onClose: () => void;
}

export function ArtifactViewer({ content, onClose }: ArtifactViewerProps) {
    const { width, height } = useWindowDimensions();
    const { theme, rt } = useUnistyles();

    const html = React.useMemo(() => buildArtifactDocument({
        content,
        theme: rt.themeName === 'dark' ? 'dark' : 'light',
        bridge: 'window'
    }), [content, rt.themeName]);

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div style={{ width, height, position: 'relative', background: theme.colors.surface }}>
            <iframe
                srcDoc={html}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                title="Artifact"
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            />
            <button
                onClick={onClose}
                aria-label="Close artifact"
                style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    border: 'none',
                    background: 'rgba(0,0,0,0.45)',
                    color: '#fff',
                    fontSize: 24,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}
            >
                ×
            </button>
        </div>
    );
}
