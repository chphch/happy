/**
 * The accept/reject policy for text an artifact frame wants delivered into the
 * session as a user message.
 *
 * Deliberately free of React and of the sync engine: four components host an
 * artifact frame — the inline renderer and the fullscreen viewer, each with a
 * web and a native implementation — and every one needs identical rules. If they
 * drifted, the difference would be a security difference between platforms
 * rather than a style one. Keeping the rules here also makes them testable
 * without a DOM, which this package has no environment for.
 *
 * The React wrapper is `useArtifactMessageSink.ts`; it supplies the session id
 * and the actual send.
 */
import { ARTIFACT_MESSAGE_MIN_INTERVAL_MS, parseArtifactMessage } from './artifactDocument';

export interface ArtifactMessageSinkDeps {
    /**
     * Read late, never captured: the component installs its frame listener once,
     * so a session id captured at creation would still be the old one after a
     * re-render — messages would go to the previous session.
     */
    getSessionId: () => string | undefined;
    send: (sessionId: string, text: string) => void;
    /** Injectable only so tests can control the rate-limit clock. */
    now?: () => number;
}

/**
 * Returns a handler for raw bridge data. It answers whether the message was
 * accepted, so a caller that also parses heights can tell "handled" from "not
 * for me" without parsing twice.
 *
 * Refuses when there is no session: an artifact can be rendered outside one — a
 * changelog entry, a standalone note — and there is no sensible destination for
 * text from there.
 */
export function createArtifactMessageSink(deps: ArtifactMessageSinkDeps): (data: unknown) => boolean {
    const clock = deps.now ?? Date.now;
    let lastAcceptedAt = Number.NEGATIVE_INFINITY;

    return (data: unknown): boolean => {
        const text = parseArtifactMessage(data);
        if (text === null) return false;

        const sessionId = deps.getSessionId();
        if (!sessionId) return false;

        const at = clock();
        if (at - lastAcceptedAt < ARTIFACT_MESSAGE_MIN_INTERVAL_MS) return false;
        lastAcceptedAt = at;

        deps.send(sessionId, text);
        return true;
    };
}
