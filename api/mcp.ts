import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../src/server.js';

type McpSession = {
  server: ReturnType<typeof createServer>['server'];
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeenAt: number;
};

const API_VERSION = '0.7.0';
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;

// Vercel can reuse a warm function instance, but it does not guarantee session
// affinity across instances. The limitation is documented in docs/VERCEL-MCP.md.
const sessions = new Map<string, McpSession>();

function authorized(request: Request): boolean {
  const expected = process.env.MCP_BEARER_TOKEN;
  const header = request.headers.get('authorization');

  if (!expected || !header?.startsWith('Bearer ')) return false;

  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const configured = Buffer.from(expected, 'utf8');

  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
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

async function handleMcp(request: Request): Promise<Response> {
  if (!process.env.MCP_BEARER_TOKEN) {
    return jsonError(500, 'MCP_BEARER_TOKEN is not configured');
  }

  if (!authorized(request)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      },
    });
  }

  const apiKey = process.env.GGCHECKOUT_API_KEY;
  if (!apiKey) return jsonError(500, 'GGCHECKOUT_API_KEY is not configured');

  if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE' },
    });
  }

  cleanupExpiredSessions();

  const sessionId = request.headers.get('mcp-session-id') || undefined;
  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !session) {
    return jsonError(404, 'MCP session not found. Reconnect and initialize a new session.');
  }

  if (!session) {
    let body: { method?: string } | undefined;
    if (request.method === 'POST') {
      try {
        body = await request.clone().json() as { method?: string };
      } catch {
        return jsonError(400, 'Invalid JSON request body');
      }
    }

    if (request.method !== 'POST' || body?.method !== 'initialize') {
      return jsonError(400, 'A new MCP session must start with an initialize request.');
    }

    if (sessions.size >= MAX_SESSIONS) {
      return jsonError(503, 'MCP session capacity reached. Retry shortly.');
    }

    try {
      const created = createServer({
        apiKey,
        apiUrl: process.env.GGCHECKOUT_API_URL || 'https://ggcheckout.app',
        version: API_VERSION,
        env: process.env,
      });

      const server = created.server;
      let transport!: WebStandardStreamableHTTPServerTransport;

      transport = new WebStandardStreamableHTTPServerTransport({
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
      return jsonError(500, 'Could not initialize MCP server');
    }
  }

  session.lastSeenAt = Date.now();

  try {
    return await session.transport.handleRequest(request);
  } catch (error) {
    console.error('[MCP] HTTP request failed:', error instanceof Error ? error.message : 'Unknown error');
    return jsonError(500, 'MCP request failed');
  }
}

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
