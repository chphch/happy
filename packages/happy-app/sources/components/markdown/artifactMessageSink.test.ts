import { describe, it, expect } from 'vitest';
import { createArtifactMessageSink } from './artifactMessageSink';
import { ARTIFACT_MESSAGE_MIN_INTERVAL_MS } from './artifactDocument';

const wire = (text: unknown) => JSON.stringify({ type: 'artifact-message', text });

function harness(options: { sessionId?: string | undefined } = {}) {
    const sent: Array<{ sessionId: string; text: string }> = [];
    let sessionId = 'sessionId' in options ? options.sessionId : 'sess-1';
    let clock = 10_000;
    const sink = createArtifactMessageSink({
        getSessionId: () => sessionId,
        send: (target, text) => { sent.push({ sessionId: target, text }); },
        now: () => clock
    });
    return {
        sink,
        sent,
        advance: (ms: number) => { clock += ms; },
        setSession: (next: string | undefined) => { sessionId = next; }
    };
}

describe('createArtifactMessageSink', () => {
    it('delivers accepted text to the current session', () => {
        const h = harness();
        expect(h.sink(wire('§2 를 줄여줘'))).toBe(true);
        expect(h.sent).toEqual([{ sessionId: 'sess-1', text: '§2 를 줄여줘' }]);
    });

    it('accepts the very first message however long the page has been open', () => {
        const h = harness();
        // Guards against seeding the clock with 0, which would make the first
        // send wait out the interval from the epoch.
        expect(h.sink(wire('first'))).toBe(true);
    });

    it('refuses everything when the artifact is not inside a session', () => {
        const h = harness({ sessionId: undefined });
        expect(h.sink(wire('hello'))).toBe(false);
        expect(h.sent).toHaveLength(0);
    });

    it('follows the session it is asked for, rather than the one it started with', () => {
        const h = harness();
        h.sink(wire('to first'));
        h.advance(ARTIFACT_MESSAGE_MIN_INTERVAL_MS);
        h.setSession('sess-2');
        h.sink(wire('to second'));
        expect(h.sent.map((m) => m.sessionId)).toEqual(['sess-1', 'sess-2']);
    });

    it('rate-limits a page sending in a loop, and recovers after the gap', () => {
        const h = harness();
        expect(h.sink(wire('one'))).toBe(true);
        expect(h.sink(wire('two'))).toBe(false);
        h.advance(ARTIFACT_MESSAGE_MIN_INTERVAL_MS - 1);
        expect(h.sink(wire('three'))).toBe(false);
        h.advance(1);
        expect(h.sink(wire('four'))).toBe(true);
        expect(h.sent.map((m) => m.text)).toEqual(['one', 'four']);
    });

    it('does not spend the rate-limit budget on a message it refused', () => {
        const h = harness();
        expect(h.sink('not a message at all')).toBe(false);
        expect(h.sink(wire('real'))).toBe(true);
    });

    it('passes non-messages through so a caller can keep parsing', () => {
        const h = harness();
        expect(h.sink(JSON.stringify({ type: 'artifact-height', height: 300 }))).toBe(false);
        expect(h.sent).toHaveLength(0);
    });
});
