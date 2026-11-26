#!/usr/bin/env node
import dotenv from 'dotenv';
import { createServer as createHttpServer } from 'node:http';
import { handleMcp } from './http.js';

dotenv.config({ quiet: true });

const port = Number(process.env.PORT || 3000);
createHttpServer((req, res) => {
  handleMcp(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(port, () => console.error(`[MCP-HTTP] listening on :${port} (POST /mcp)`));
