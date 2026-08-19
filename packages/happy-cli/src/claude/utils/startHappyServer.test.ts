import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHappyServer } from './startHappyServer';
import { spawnDaemonSession } from '@/daemon/controlClient';
import type { ApiSessionClient } from '@/api/apiSession';

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    spawnDaemonSession: vi.fn(),
}));

describe('startHappyServer MCP tools', () => {
    let server: Awaited<ReturnType<typeof startHappyServer>> | null = null;
    let client: Client | null = null;

    beforeEach(() => {
        vi.mocked(spawnDaemonSession).mockReset();
    });

    afterEach(async () => {
        try { await client?.close(); } catch { /* ignore */ }
        client = null;
        server?.stop();
        server = null;
    });

    function fakeSession(summaries: string[], sessionId = 'self-session'): ApiSessionClient {
        return {
            sessionId,
            getMetadata: () => ({ path: '/tmp/fake-project' }),
            sendClaudeSessionMessage: (message: unknown) => {
                if (message && typeof message === 'object' && (message as { type?: string }).type === 'summary') {
                    summaries.push(String((message as { summary?: string }).summary ?? ''));
                }
            },
        } as unknown as ApiSessionClient;
    }

    async function connect(url: string): Promise<Client> {
        const c = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
        await c.connect(new StreamableHTTPClientTransport(new URL(url)));
        return c;
    }

    it('registers change_title, open_session, archive_session, archive_self, set_parent', async () => {
        server = await startHappyServer(fakeSession([]));
        expect(server.toolNames).toEqual(['change_title', 'open_session', 'archive_session', 'archive_self', 'set_parent']);

        client = await connect(server.url);
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name).sort()).toEqual(['archive_self', 'archive_session', 'change_title', 'open_session', 'set_parent']);
    });

    it('change_title still works after the refactor', async () => {
        const summaries: string[] = [];
        server = await startHappyServer(fakeSession(summaries));
        client = await connect(server.url);

        const res = await client.callTool({ name: 'change_title', arguments: { title: 'Hello world' } });
        expect(res.isError).toBeFalsy();
        expect(JSON.stringify(res.content)).toContain('Hello world');
        expect(summaries).toContain('Hello world');
    });

    it('archive_session refuses to archive the current session (keepalive self-revive guard)', async () => {
        server = await startHappyServer(fakeSession([], 'self-session'));
        client = await connect(server.url);

        const res = await client.callTool({ name: 'archive_session', arguments: { sessionId: 'self-session' } });
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res.content)).toContain('Cannot archive the current session');
    });

    it('archive_self reports unavailable when no archiveAndExit is wired', async () => {
        server = await startHappyServer(fakeSession([]));
        client = await connect(server.url);

        const res = await client.callTool({ name: 'archive_self', arguments: {} });
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res.content)).toContain('not available');
    });

    it('archive_self responds first, then triggers the wired archive+exit', async () => {
        let archived = false;
        server = await startHappyServer(fakeSession([]), { archiveAndExit: () => { archived = true; } });
        client = await connect(server.url);

        const res = await client.callTool({ name: 'archive_self', arguments: {} });
        // Responds with success BEFORE the deferred archive+exit fires, so the
        // client gets the goodbye before the process would terminate.
        expect(res.isError).toBeFalsy();
        expect(JSON.stringify(res.content)).toContain('Archiving this session');
        expect(archived).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(archived).toBe(true);
    });

    it('open_session opens a top-level session by default', async () => {
        vi.mocked(spawnDaemonSession).mockResolvedValue({ success: true, sessionId: 'child-session' });
        server = await startHappyServer(fakeSession([], 'self-session'));
        client = await connect(server.url);

        const res = await client.callTool({ name: 'open_session', arguments: {} });
        expect(res.isError).toBeFalsy();
        expect(JSON.stringify(res.content)).toContain('child-session');
        expect(spawnDaemonSession).toHaveBeenCalledWith('/tmp/fake-project', undefined, { agent: undefined, parentSessionId: undefined });
    });

    it('open_session with linkToParent sends the calling session as the daemon parentSessionId', async () => {
        vi.mocked(spawnDaemonSession).mockResolvedValue({ success: true, sessionId: 'child-session' });
        server = await startHappyServer(fakeSession([], 'self-session'));
        client = await connect(server.url);

        const res = await client.callTool({ name: 'open_session', arguments: { linkToParent: true } });
        expect(res.isError).toBeFalsy();
        // Not as HAPPY_FORKED_FROM_SESSION_ID in environment variables: the
        // daemon strips that key, so the child would open with no parent.
        expect(spawnDaemonSession).toHaveBeenCalledWith('/tmp/fake-project', undefined, { agent: undefined, parentSessionId: 'self-session' });
    });
});
