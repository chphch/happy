/**
 * React wrapper over the artifact message policy: binds it to a session and to
 * the sync engine's send.
 *
 * The path this reuses is the one an `<options>` block already takes when its
 * label is tapped (`components/MessageView.tsx`): a plain `sync.sendMessage`.
 * Nothing in the server or the CLI needs to know where the text came from,
 * beyond the `source` tag.
 */
import * as React from 'react';
import { sync } from '@/sync/sync';
import { createArtifactMessageSink } from './artifactMessageSink';

export function useArtifactMessageSink(sessionId?: string): (data: unknown) => boolean {
    // A ref, not a dependency: the sink owns the rate-limit clock, so rebuilding
    // it whenever the session prop changes identity would reset that budget and
    // let a page sidestep the limit by provoking a re-render.
    const sessionIdRef = React.useRef(sessionId);
    sessionIdRef.current = sessionId;

    return React.useMemo(() => createArtifactMessageSink({
        getSessionId: () => sessionIdRef.current,
        send: (target, text) => {
            void sync.sendMessage(target, text, { source: 'artifact' });
        }
    }), []);
}
