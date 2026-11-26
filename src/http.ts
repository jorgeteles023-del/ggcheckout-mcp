import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison (both sides hashed, so lengths always match). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Pulls the token the caller presented: `Authorization: Bearer <token>`, or the last path
 * segment of `/mcp/<token>` (claude.ai custom connectors cannot send custom headers, so the
 * secret goes in the URL there).
 */
function presentedToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const path = (req.url ?? '').split('?')[0];
  const m = path.match(/^\/(?:api\/)?mcp\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const expected = process.env.MCP_AUTH_TOKEN;
  const apiKey = process.env.GGCHECKOUT_API_KEY;
  if (!expected || expected.length < 24 || !apiKey) {
    // Fail closed: never serve the account without a strong token.
    return send(res, 500, { error: 'server_misconfigured', message: 'MCP_AUTH_TOKEN (min 24 chars) and GGCHECKOUT_API_KEY are required' });
  }

  const path = (req.url ?? '').split('?')[0];
  if (path === '/health' || path === '/api/health') return send(res, 200, { ok: true });

  const token = presentedToken(req);
  if (!token || !safeEqual(token, expected)) {
    return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  }

  if (req.method !== 'POST') {
    // Stateless mode: no GET/SSE stream and no session to DELETE.
    return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { Allow: 'POST' });
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
  }

  try {
    const { server } = createServer({
      apiKey,
      apiUrl: process.env.GGCHECKOUT_API_URL || 'https://ggcheckout.app',
      version: pkg.version,
      env: process.env,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err: any) {
    console.error('[MCP-HTTP] error', err?.message);
    if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
}
