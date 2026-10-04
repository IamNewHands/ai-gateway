[中文](README.md) | **English**

# AI Gateway

An AI API proxy gateway built on Cloudflare Workers + Hono. It exposes one unified `/v1` endpoint, is compatible with the OpenAI / Anthropic protocols, and supports multi-key rotation, health checks and automatic failover.
<img width="3164" height="1657" alt="image" src="https://github.com/user-attachments/assets/8e88a23a-19c1-4ba7-a392-ccdb224ea069" />

## Features

- **Unified API entry** — every AI provider is reached through `https://your-domain/v1`, compatible with the OpenAI / Anthropic protocols
- **Multi-key rotation + health checks** — failing keys are automatically demoted and cooled down, then regain weight when the cooldown expires
- **Multiple providers** — built-in access to OpenCode, WorkBuddy / CodeBuddy, M365 Copilot, Gemini CLI, CNB, Cline and more
- **Protocol conversion** — Anthropic Messages / OpenAI Responses / Chat Completions converted in both directions, including streaming SSE
- **Usage dashboard** — built on Cloudflare Analytics Engine, no extra database required
- **Admin console** — no front-end build step, card-based UI, mobile-friendly
- **WebSocket bridge** — client-defined models can connect to the gateway directly over WS

## Added features (built on top of upstream)

This repository is a fork of [yutian81/ai-gateway](https://github.com/yutian81/ai-gateway). On top of the upstream multi-key rotation / health checks / OpenCode failover, it adds:

- **WorkBuddy / CodeBuddy / TraeWork access** — OAuth device-code login, CN / Global dual-realm routing, automatic token refresh, models imported automatically
- **WorkBuddy / TraeWork daily check-in** — scheduled Cron check-ins, multi-account support, a check-in panel in the admin console
- **External management API** — Bearer-token auth (`MANAGEMENT_TOKEN`); manage providers and trigger check-ins remotely from a phone script
- **Bidirectional protocol conversion** — Anthropic Messages / OpenAI Responses / Chat Completions, including real-time streaming SSE conversion
- **Cline access** — built-in reverse proxy for free models, multi-account pool rotation, one-click authorization to obtain a token
- **Usage dashboard** — usage stats, request trends, model / channel rankings on Cloudflare Analytics Engine
- **M365 Copilot access** — goes through the official ChatHub protocol, with session management, the Agent tool protocol, image generation and account health checks
- **CNB access** — cnb.cool login-free free models, credential pool rotation, XYML tool bridge
- **Gemini CLI access** — official OAuth device-code authorization, protocol conversion built in
- **WebSocket bridge** — client-defined models can connect to the gateway directly over WS
- **Vision Bridge** — text-only models gain image understanding through a chain of vision models
- **MCP aggregation gateway** — aggregates multiple MCP servers into one OpenAI-compatible tool entry point
- **uni-model composite models** — one logical model name maps to a set of candidate models with automatic failover
- **Other** — whitelisted request-header passthrough, a passthrough switch for unconfigured models, admin management of the in-memory cache, admin UI polish

> QoderWork access is experimental and has not passed verification yet.

## Tech stack

- Runtime: Cloudflare Workers
- Framework: Hono v4
- Language: TypeScript
- Storage: Cloudflare Workers KV / Durable Objects / Analytics Engine

## Local development

```bash
git clone https://github.com/IamNewHands/ai-gateway.git
cd ai-gateway
npm install

# create .dev.vars
echo ADMIN_USERNAME=admin >> .dev.vars
echo ADMIN_PASSWORD=your-password >> .dev.vars

npm run dev
```

## Deployment

Automatic deployment through GitHub Actions is recommended:

1. Push the code to your GitHub repository
2. In the repository, configure **Settings → Secrets and variables → Actions**:
   - **Secrets**: `CF_API_TOKEN` (needs Workers edit permission)
   - **Variables**: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `MANAGEMENT_TOKEN`
3. On the Actions page, manually trigger the **Deploy to Cloudflare Workers** workflow

> After deployment, open the Worker's **Settings → Variables** to check the environment variables, and consider binding a custom domain.

## Admin authentication (Cloudflare Access, optional)

By default the admin console is protected by `ADMIN_USERNAME` / `ADMIN_PASSWORD` only. For stronger security you can put **Cloudflare Access** (Zero Trust) in front of it to add an "email OTP / Google login" layer — **without affecting clients that call `/v1` to use models at all**.

### How it works

The three auth layers are already independent; client `/v1/*` calls use a forwarding key (`Bearer sk_cf_<KEY>`) and never pass through admin authentication:

| Path | Authentication |
| --- | --- |
| `/v1/*` (clients calling models) | Forwarding key (unaffected by this setup) |
| `/admin/*` (admin console) | Cloudflare Access JWT + the existing session |
| `/api/manage/*` (external management API) | `MANAGEMENT_TOKEN` |

### Configuration steps

1. **Cloudflare dashboard → Zero Trust → Access → Applications → Add application**, type **Self-hosted**.
   - **Domain / Path**: your Worker domain, with **Path covering only `/admin` and `/admin/*`** — that way only the admin console is intercepted by Access and client `/v1*` needs no login.
   - **Policy**: choose **Email OTP** or Google / Microsoft OAuth as the identity check; that is the email-code login you want, with no mail service of your own.
   - Note the application's **Audience / AUD** tag.
   - Set the policy's **Session duration** fairly long to avoid repeated re-verification.
2. **Worker → Settings → Variables**: add the environment variables (**the `CF_ACCESS_ENABLED` switch must be `true` to take effect; if it is unset or anything else, the hardening is fully off and no path is affected**):
   ```toml
   CF_ACCESS_ENABLED = "true"
   CF_ACCESS_AUD = "<the AUD tag of your Access application>"
   CF_ACCESS_TEAM_DOMAIN = "<your-team-name>.cloudflareaccess.com"
   ```
   > `CF_ACCESS_TEAM_DOMAIN` is your Zero Trust team domain (Dashboard → Zero Trust → Settings → Team domain), used to fetch the Access public signing keys. It is **not** your Worker hostname.
3. Redeploy the Worker.

### Behaviour

- Visiting `/admin*`: passes Access first (enter the email code) → then the original username / password login.
- Client `/v1*`: unchanged, it only accepts `Bearer sk_cf_<KEY>` and calls models normally.
- **Switch**: when `CF_ACCESS_ENABLED != "true"` this hardening is completely off (the middleware passes everything through) and no path is affected; with it off, only `ADMIN_USERNAME` / `ADMIN_PASSWORD` protect the login.
- When verifying, the middleware **reads the `Cf-Access-Jwt` header first and falls back to the `CF_Authorization` cookie**, so an authenticated user is recognised through either channel.
- If the switch is on but `CF_ACCESS_AUD` or `CF_ACCESS_TEAM_DOMAIN` is missing, it returns 500 describing the misconfiguration (instead of failing open silently).

## MCP aggregation gateway

Aggregates multiple MCP servers into **one** entry point exposed through a unified JSON-RPC endpoint. Clients only configure a single address to discover and call the tools of every enabled MCP.

### Endpoints

| Endpoint | Method | Auth | Description |
| --- | --- | --- | --- |
| `/v1/mcp` | `POST` | Forwarding key (`Bearer sk_cf_<KEY>`) | MCP JSON-RPC entry point (initialize / tools/list / tools/call) |
| `/v1/mcp/health` | `GET` | Forwarding key | Health triage: probes each MCP's reachability and tool count |
| `/admin/api/mcps` | `GET/POST` | Admin console session | Query / add a single MCP server |
| `/admin/api/mcps/batch` | `POST` | Admin console session | Bulk import (up to 200) |
| `/admin/api/mcps/:id` | `PUT/DELETE` | Admin console session | Update / delete a single MCP server |
| `/admin/api/mcps/health` | `GET` | Admin console session | Same source as `/v1/mcp/health`, for the admin panel |

### How to configure

1. **Admin console → "MCP Gateway"**: add one, bulk-import a JSON array, or run a one-click health check — all visual entry points.
2. **Add one through the API**:

```bash
curl -X POST https://your-domain/admin/api/mcps \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "github",
    "url": "https://api.githubcopilot.com/mcp/",
    "httpHeaders": { "Authorization": "Bearer <TOKEN>" },
    "enabled": true
  }'
```

3. **Bulk import API** (the body is an array or `{ "mcps": [...] }`):

```bash
curl -X POST https://your-domain/admin/api/mcps/batch \
  -H 'Content-Type: application/json' \
  -d '[
    { "name": "github", "url": "https://api.githubcopilot.com/mcp/", "httpHeaders": { "Authorization": "Bearer <TOKEN>" } },
    { "name": "notion", "url": "https://mcp.notion.com/mcp" }
  ]'
```

### Client setup

In any MCP-capable client (Claude Desktop / Cline / Trae …), point the server at the gateway:

```
URL    : https://your-domain/v1/mcp
Header : Authorization: Bearer sk_cf_<KEY>
```

Clients discover tools automatically through the standard `initialize` → `tools/list` handshake; no pre-registration is needed.

### Calling conventions

- `tools/list` aggregates the tools of every enabled MCP concurrently, and tool names are automatically prefixed with **`{MCP name}-`** for namespace isolation (spaces in the MCP name become underscores).
- `tools/call` routes to the target MCP by prefix and restores the original tool name when forwarding; upstream responses are normalised to JSON.
- If a single MCP fails to respond it is skipped (the rest still aggregate); an error is returned only when every one fails.
- Upstream must support the **streamable HTTP single endpoint** (`POST` JSON-RPC); the older two-endpoint SSE style and stdio are not supported yet.

## Usage

- **API BASE URL**: `https://your-domain/v1`
- **API KEY**: generated in the admin console, in the form `sk_cf_<KEY>`
- **Model ID**: `providerId/modelId`, e.g. `opencode/deepseek-v4-flash-free`

## License

AGPL-3.0
