/**
 * Inline renderer for an ```artifact block (web).
 *
 * The HTML goes into an iframe sandboxed WITHOUT `allow-same-origin`, so the
 * page runs in an opaque origin: it cannot reach this document, our storage, or
 * the session key. That isolation is also why the height arrives over
 * postMessage rather than by measuring the frame's document. Metro resolves this
 * over `ArtifactRenderer.tsx` on web.
 */
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { buildArtifactDocument, parseArtifactHeight } from './artifactDocument';
import { ArtifactViewer } from './ArtifactViewer';

const MIN_HEIGHT = 120;
// Runaway guard on the reported height, NOT a design cap — see ArtifactRenderer.tsx.
const MAX_REPORTED_HEIGHT = 8000;

export const ArtifactRenderer = React.memo((props: { content: string }) => {
    const { theme, rt } = useUnistyles();
    const iframeRef = React.useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = React.useState(MIN_HEIGHT);

    const html = React.useMemo(() => buildArtifactDocument({
        content: props.content,
        theme: rt.themeName === 'dark' ? 'dark' : 'light',
        bridge: 'window'
    }), [props.content, rt.themeName]);

    React.useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            // The frame has an opaque origin, so `event.origin` is "null" for every
            // sandboxed page — identity has to come from the source window instead.
            if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
            const reported = parseArtifactHeight(event.data);
            if (reported !== null) {
                setHeight(Math.min(Math.max(reported, MIN_HEIGHT), MAX_REPORTED_HEIGHT));
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    const openViewer = React.useCallback(() => {
        Modal.show({ component: ArtifactViewer, props: { content: props.content } } as any);
    }, [props.content]);

    return (
        <div style={{ position: 'relative', width: '100%', marginTop: 8, marginBottom: 8 }}>
            <iframe
                ref={iframeRef}
                srcDoc={html}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                title="Artifact"
                style={{
                    width: '100%',
                    height,
                    border: 'none',
                    borderRadius: 8,
                    display: 'block',
                    backgroundColor: theme.colors.surfaceHighest
                }}
            />
            <button
                onClick={openViewer}
                aria-label="Expand artifact"
                style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    border: 'none',
                    background: 'rgba(0,0,0,0.45)',
                    color: '#fff',
                    fontSize: 15,
                    lineHeight: '15px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}
            >
                ⤢
            </button>
        </div>
    );
});
