import * as React from 'react';
import { createHash } from 'node:crypto';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({ content: '' }));
vi.mock('@/sync/ops', () => ({
    sessionReadFile: async () => ({ success: true, content: rpc.content }),
    sessionWriteFile: async () => ({ success: true }),
}));
vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, data: Uint8Array) => {
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    },
}));

import { computeSHA256, useRemoteFile, type RemoteFileState } from './useRemoteFile';

const TEXT = '# 캔버스\n\nA canvas the agent wrote.\n';

const originalError = console.error;
beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    console.error = (message: unknown, ...rest: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalError(message, ...rest);
    };
});
afterAll(() => { console.error = originalError; });
afterEach(() => vi.unstubAllGlobals());

// The phone's engine has no Web Crypto; this is what the app sees there.
function withoutWebCrypto() {
    vi.stubGlobal('crypto', undefined);
}

it('hashes the way the machine does, without crypto.subtle', async () => {
    withoutWebCrypto();
    const machineHash = createHash('sha256').update(Buffer.from(TEXT, 'utf8')).digest('hex');
    await expect(computeSHA256(TEXT)).resolves.toBe(machineHash);
});

it('loads a file that reads fine, without crypto.subtle', async () => {
    withoutWebCrypto();
    rpc.content = Buffer.from(TEXT, 'utf8').toString('base64');
    const seen: { state: RemoteFileState } = { state: { kind: 'idle' } };
    function Probe() {
        seen.state = useRemoteFile('session-1', '/project/.claude/canvas/abc.md', { pollMs: 0 }).state;
        return null;
    }
    await act(async () => { create(React.createElement(Probe)); });
    expect(seen.state).toEqual({
        kind: 'loaded',
        content: TEXT,
        originalHash: createHash('sha256').update(Buffer.from(TEXT, 'utf8')).digest('hex'),
    });
});
