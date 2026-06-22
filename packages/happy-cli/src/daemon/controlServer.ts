/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';
import { TrackedSession, SessionEncryptionData } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  resumeSession,
  reviveOrphans,
  requestShutdown,
  onHappySessionWebhook
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  resumeSession: (happySessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>;
  reviveOrphans: (options?: { maxAgeMs?: number }) => Promise<{ attempted: { happySessionId: string; path: string; result: SpawnSessionResult }[] }>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata, encryption?: SessionEncryptionData) => void;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any(),
          encryption: z.object({
            encryptionKey: z.string(),
            encryptionVariant: z.enum(['legacy', 'dataKey']),
            seq: z.number(),
            metadataVersion: z.number(),
            agentStateVersion: z.number(),
          }).optional()
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata, encryption } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);

      let encryptionData: SessionEncryptionData | undefined;
      if (encryption) {
        encryptionData = {
          encryptionKey: decodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
        };
      }

      onHappySessionWebhook(sessionId, metadata, encryptionData);

      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional(),
          agent: z.enum(['claude', 'codex', 'gemini', 'openclaw', 'agy']).optional(),
          permissionMode: z.string().optional(),
          modelMode: z.string().optional(),
          effortLevel: z.string().optional(),
          environmentVariables: z.record(z.string(), z.string()).optional(),
          // Fork passthrough — mirrors the mobile app's spawn-happy-session RPC
          // (apiMachine.ts). When set, the daemon spawns `claude --resume <id>`
          // and backfills the prior conversation, so the new local session is a
          // true FORK of an existing one rather than a blank session. Used by the
          // /fork command (fork.mjs) to fan out context-inheriting children.
          resumeClaudeSessionId: z.string().optional(),
          parentSessionId: z.string().optional(),
          forkedFromMessageId: z.string().optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, agent, permissionMode, modelMode, effortLevel, environmentVariables, resumeClaudeSessionId, parentSessionId, forkedFromMessageId } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, agent=${agent || 'default'}, resume=${resumeClaudeSessionId || 'none'}`);
      const result = await spawnSession({ directory, sessionId, agent, permissionMode, modelMode, effortLevel, environmentVariables, resumeClaudeSessionId, parentSessionId, forkedFromMessageId });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Resume a previously-active session by happySessionId.
    // Replicates the mobile app's resume-happy-session RPC, but locally.
    typed.post('/resume-session', {
      schema: {
        body: z.object({
          happySessionId: z.string(),
          model: z.string().optional(),
          permissionMode: z.string().optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            error: z.string().optional(),
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional(),
          })
        }
      }
    }, async (request, reply) => {
      const { happySessionId, model, permissionMode } = request.body;
      logger.debug(`[CONTROL SERVER] Resume session request: ${happySessionId}`);
      const result = await resumeSession(happySessionId, { model, permissionMode });
      if (result.type === 'success') {
        return { success: true, sessionId: result.sessionId };
      }
      reply.code(500);
      return { success: false, error: result.type === 'error' ? result.errorMessage : `unexpected: ${result.type}` };
    });

    // Bulk-revive: scan persisted sessions, attempt resume for each unarchived
    // daemon-spawned session whose hostPid is dead AND no alive session for the same cwd.
    typed.post('/resume-orphans', {
      schema: {
        body: z.object({
          maxAgeMs: z.number().optional(),
        }).optional(),
        response: {
          200: z.object({
            attempted: z.array(z.object({
              happySessionId: z.string(),
              path: z.string(),
              ok: z.boolean(),
              sessionId: z.string().optional(),
              error: z.string().optional(),
            }))
          })
        }
      }
    }, async (request) => {
      const maxAgeMs = request.body?.maxAgeMs;
      logger.debug(`[CONTROL SERVER] Resume orphans request (maxAgeMs=${maxAgeMs ?? 'default'})`);
      const { attempted } = await reviveOrphans({ maxAgeMs });
      return {
        attempted: attempted.map(a => ({
          happySessionId: a.happySessionId,
          path: a.path,
          ok: a.result.type === 'success',
          sessionId: a.result.type === 'success' ? a.result.sessionId : undefined,
          error: a.result.type === 'error' ? a.result.errorMessage : undefined,
        }))
      };
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
