# Deploy GG Checkout MCP on Vercel

This fork adds a stateless Streamable HTTP endpoint at `/api/mcp` while keeping the original STDIO entry point intact.

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

Transport: MCP Streamable HTTP, stateless. Each invocation creates a fresh MCP server and transport, which avoids relying on in-memory session state across serverless invocations.

## Important limitations

- The existing upload tools read files from the server's local filesystem. Vercel Functions do not provide a persistent user-managed upload directory; leave `GGCHECKOUT_UPLOAD_ROOT` unset unless a dedicated storage adapter is implemented. Upload tools will therefore remain unavailable.
- The six Payments API tools are registered only when `GG_PAYMENTS_API_KEY` is configured. This is a separate credential from `GGCHECKOUT_API_KEY`; do not set it unless you intend to use those tools.
- The original STDIO mode remains available for local MCP clients.
- Use a ChatGPT account/workspace that supports custom MCP connections. ChatGPT custom MCP setup is performed on the web, not in the Android app. Availability and write permissions depend on the plan and workspace policy.

## Smoke test

Unauthenticated requests should return HTTP 401. An authenticated MCP client should initialize against the endpoint and list tools. Do not test write tools against production until you have reviewed their effects and configured the correct account.
