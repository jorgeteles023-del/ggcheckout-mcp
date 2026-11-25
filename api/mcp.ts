import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../src/server.js';

type VercelMcpRequest = IncomingMessage & {
  body?: unknown;
};

type McpSession = {
  server: ReturnType<typeof createServer>['server'];
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
};

const API_VERSION = '0.7.0';
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;

// Vercel may reuse a warm function instance between requests. MCP session
// state is kept only in this instance; see docs/VERCEL-MCP.md for the
// serverless scaling limitation and production requirements.
const sessions = new Map<string, McpSession>();

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MCP_BEARER_TOKEN;
  const header = req.headers.authorization;

  if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return false;
  }

  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const configured = Buffer.from(expected, 'utf8');

  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
      sessions.delete(id);
      void session.server.close().catch(() => undefined);
    }
  }
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: message }));
}

export default async function handler(req: VercelMcpRequest, res: ServerResponse): Promise<void> {
  if (!process.env.MCP_BEARER_TOKEN) {
    jsonError(res, 500, 'MCP_BEARER_TOKEN is not configured');
    return;
  }

  if (!authorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    jsonError(res, 401, 'Unauthorized');
    return;
  }

  const apiKey = process.env.GGCHECKOUT_API_KEY;
  if (!apiKey) {
    jsonError(res, 500, 'GGCHECKOUT_API_KEY is not configured');
    return;
  }

  if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    jsonError(res, 405, 'Method not allowed');
    return;
  }

  cleanupExpiredSessions();

  const sessionIdHeader = req.headers['mcp-session-id'];
  const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;
  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !session) {
    jsonError(res, 404, 'MCP session not found. Reconnect and initialize a new session.');
    return;
  }

  if (!session) {
    const body = req.body as { method?: string } | undefined;
    if (req.method !== 'POST' || body?.method !== 'initialize') {
      jsonError(res, 400, 'A new MCP session must start with an initialize request.');
      return;
    }

    if (sessions.size >= MAX_SESSIONS) {
      jsonError(res, 503, 'MCP session capacity reached. Retry shortly.');
      return;
    }

    try {
      const created = createServer({
        apiKey,
        apiUrl: process.env.GGCHECKOUT_API_URL || 'https://ggcheckout.app',
        version: API_VERSION,
        env: process.env,
      });

      const server = created.server;
      let transport: StreamableHTTPServerTransport;

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport, lastSeenAt: Date.now() });
        },
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };

      transport.onerror = (error) => {
        console.error('[MCP] Transport error:', error.message);
      };

      session = { server, transport, lastSeenAt: Date.now() };
      await server.connect(transport);
    } catch (error) {
      console.error('[MCP] Could not initialize server:', error instanceof Error ? error.message : 'Unknown error');
      jsonError(res, 500, 'Could not initialize MCP server');
      return;
    }
  }

  session.lastSeenAt = Date.now();

  try {
    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[MCP] HTTP request failed:', error instanceof Error ? error.message : 'Unknown error');
    if (!res.headersSent) jsonError(res, 500, 'MCP request failed');
    else if (!res.writableEnded) res.end();
  }
}
