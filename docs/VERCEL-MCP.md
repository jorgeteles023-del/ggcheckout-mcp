# Deploy GG Checkout MCP on Vercel

This fork adds a stateful Streamable HTTP endpoint at `/api/mcp` while keeping the original STDIO entry point intact.

## Required Vercel environment variables

Set these in **Project → Settings → Environment Variables**:

- `GGCHECKOUT_API_KEY`: seller API key beginning with `ggck_live_`. A restricted `ggck_agent_` key exposes only the WhatsApp assistant tools.
- `MCP_BEARER_TOKEN`: a separate, high-entropy secret used to authenticate MCP clients. Generate at least 32 random bytes; do not reuse the GG Checkout API key.
- `GGCHECKOUT_API_URL` (optional): defaults to `https://ggcheckout.app`.

Never commit real credentials to GitHub or place them in source code. Add the variables to Production and Preview only as appropriate, then redeploy.

## Endpoint

After deployment, the MCP endpoint is:

`https://YOUR-VERCEL-DOMAIN.vercel.app/api/mcp`

Authentication: HTTP Bearer token using the value of `MCP_BEARER_TOKEN`.

Transport: MCP Streamable HTTP with session IDs. The function keeps each active MCP server/transport in a process-local map and expires idle sessions after 30 minutes.

## Important limitations

- The existing upload tools read files from the server's local filesystem. Vercel Functions do not provide a persistent user-managed upload directory; leave `GGCHECKOUT_UPLOAD_ROOT` unset unless a dedicated storage adapter is implemented. Upload tools will therefore remain unavailable.
- The six Payments API tools are registered only when `GG_PAYMENTS_API_KEY` is configured. This is a separate credential from `GGCHECKOUT_API_KEY`; do not set it unless you intend to use those tools.
- The original STDIO mode remains available for local MCP clients.
- Use a ChatGPT account/workspace that supports custom MCP connections. ChatGPT custom MCP setup is performed on the web, not in the Android app. Availability and write permissions depend on the plan and workspace policy.

## Smoke test

Unauthenticated requests should return HTTP 401. An authenticated MCP client should initialize against the endpoint and list tools. Do not test write tools against production until you have reviewed their effects and configured the correct account.

## Serverless session limitation — read before production

MCP Streamable HTTP sessions are held in the warm Vercel Function process memory. Vercel can start multiple instances or replace a cold instance, and it does not guarantee that all requests for one MCP session reach the same instance. If a request reaches another instance, the session will not be found and the client must reconnect.

This is acceptable for an initial preview / low-volume test, but it is **not a high-availability session architecture**. Before relying on it for production or concurrent users, add a deployment architecture with session affinity or move to a genuinely stateless MCP implementation compatible with the latest protocol. Do not assume that Vercel's Git integration alone solves session persistence.
