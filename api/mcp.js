// Vercel function: all /mcp and /mcp/<token> requests are rewritten here (see vercel.json).
import { handleMcp } from '../dist/http.js';

export default function handler(req, res) {
  return handleMcp(req, res);
}
