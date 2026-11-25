import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../src/server.js';

type VercelMcpRequest = IncomingMessage & {
  body?: unknown;
};

const API_VERSION = '0.7.0';

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

export default async function handler(req: VercelMcpRequest, res: ServerResponse): Promise<void> {
  if (!process.env.MCP_BEARER_TOKEN) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'MCP_BEARER_TOKEN is not configured' }));
    return;
  }

  if (!authorized(req)) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const apiKey = process.env.GGCHECKOUT_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'GGCHECKOUT_API_KEY is not configured' }));
    return;
  }

  if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST, DELETE');
    res.end();
    return;
  }

  let server: ReturnType<typeof createServer>['server'] | undefined;

  try {
    const created = createServer({
      apiKey,
      apiUrl: process.env.GGCHECKOUT_API_URL || 'https://ggcheckout.app',
      version: API_VERSION,
      env: process.env,
    });
    server = created.server;

    // Vercel runs each invocation independently. A stateless transport avoids
    // in-memory sessions that would be lost between serverless invocations.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[MCP] HTTP request failed:', error instanceof Error ? error.message : 'Unknown error');

    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'MCP request failed' }));
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    if (server) {
      try {
        await server.close();
      } catch {
        // The response has already been handled; do not expose internal errors.
      }
    }
  }
}
