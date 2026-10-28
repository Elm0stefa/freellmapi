# Mobile dev hub 04: Claude Code as a coordinator over FreeLLMAPI MCP

> **Status: Stage A — preparation only.** This page and the templates it
> points at (`examples/claude-code-coordinator/`) are documentation and
> copyable config only. Nothing here has been installed, run, or connected to
> anything. No secret value appears in this repo; every placeholder needs a
> value you generate yourself when you actually do the setup.

- [1. Architecture](#1-architecture)
- [2. PC setup: a dedicated FreeLLMAPI instance](#2-pc-setup-a-dedicated-freellmapi-instance)
- [3. Connecting Claude Code to the MCP endpoint](#3-connecting-claude-code-to-the-mcp-endpoint)
- [4. Denying `set_routing_strategy`](#4-denying-set_routing_strategy)
- [5. Coordinator behavior instructions](#5-coordinator-behavior-instructions)
- [6. Subscription auth vs. API-key billing — do not mix them](#6-subscription-auth-vs-api-key-billing--do-not-mix-them)
- [7. Free-only routing stays on](#7-free-only-routing-stays-on)
- [8. Rollback and troubleshooting](#8-rollback-and-troubleshooting)

## 1. Architecture

```
  You, on the phone (eventually)
          |
          v
     GLIXEL  ───────────────────  served by a FreeLLMAPI instance at /glixel
                                   (unchanged by this page — see 03-glixel.md)

  You, on the PC, running Claude Code
          |  (your Claude.ai subscription — see §6)
          v
  Claude Code = "the coordinator"
          |  MCP (Streamable HTTP, same protocol as any other MCP client)
          v
  A SECOND, DEDICATED FreeLLMAPI instance
          |  (its own DB, its own ENCRYPTION_KEY, its own unified key,
          |   free-only routing on)
          v
  Free specialist models (whatever providers/keys that instance has)
```

The coordinator is Claude Code itself, not a new piece of software. It talks
to a FreeLLMAPI instance the same way any MCP client does
(`docs/en/clients/01-agent-clients.md`), and that instance does the actual
work of picking a free model and calling it.

This is deliberately a **second** FreeLLMAPI instance, not the one that might
already be serving GLIXEL to your phone. Mixing the coordinator's MCP traffic
into the same instance/database as your phone-facing GLIXEL install is
possible (`03-glixel.md` documents running two servers on one database) but
not recommended — see §2. Nothing on this page connects GLIXEL to a
remote-execution bridge, requires Termux, or requires operating the phone's
terminal; GLIXEL stays exactly what it is today, a web UI served by a
FreeLLMAPI instance.

## 2. PC setup: a dedicated FreeLLMAPI instance

Use a **separate** working copy of this repository for the coordinator's
backend, with its own database and encryption key. Do not point it at the
same `.env`, database file, or encryption key as any instance already
serving GLIXEL or anything else — `03-glixel.md`'s "Two servers on one
database" section explains why sharing causes doubled background jobs and
per-process router state disagreeing between the two servers.

1. **Get a separate copy of the server.** A second clone/checkout of this
   repository, in its own directory, is simplest.
2. **Create its `.env`** from
   [`examples/claude-code-coordinator/.env.coordinator.example`](../../examples/claude-code-coordinator/.env.coordinator.example).
   It sets, for this instance only:
   - a fresh `ENCRYPTION_KEY` (generate with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
     — never reuse another instance's key, never commit the real value);
   - its own port (`PORT=3002` in the template, pick any free port);
   - `HOST=127.0.0.1` — no reason for the coordinator's backend to be
     reachable from other devices;
   - its own `FREEAPI_DB_PATH`, separate from any other instance's database;
   - `FREE_ONLY_ROUTING=on` and no `FREE_ONLY_ALLOW_PLATFORMS` — see §7.
3. **First-run account and unified key** happen the normal way: the first
   browser to open the dashboard on that port creates the first account
   (`.env.example`'s first-run-setup note), and the unified API key is
   generated from the dashboard's Keys page. Nothing about this step is
   different for a coordinator instance.
4. **Enable the MCP surface**, which defaults to off on a fresh install
   (`docs/en/clients/01-agent-clients.md`, "MCP server"): toggle it on the
   Keys page under **Agent compatibility**, or
   `PUT /api/settings/enable-mcp {"enabled": true}` with the dashboard token.
5. **Add whichever free-provider keys** you want this instance to route to,
   the same way as any other FreeLLMAPI instance
   (`docs/mobile-dev-hub/02-free-providers-and-fallback.md`).

None of steps 1-5 above are run as part of this Stage A milestone — they are
what a later, explicitly-approved stage would execute.

## 3. Connecting Claude Code to the MCP endpoint

FreeLLMAPI's MCP endpoint is a standard Streamable HTTP MCP server at `/mcp`,
authenticated the same way as `/v1` — the unified API key as a Bearer token
(`docs/en/clients/01-agent-clients.md`). Claude Code supports this directly;
no FreeLLMAPI-specific client is needed.

**Either** register it with the CLI (documented already in
`01-agent-clients.md`):

```bash
claude mcp add --transport http freellmapi http://127.0.0.1:3002/mcp \
  --header "Authorization: Bearer freellmapi-your-unified-key"
```

**or** use a project-scoped `.mcp.json`, copied from
[`examples/claude-code-coordinator/.mcp.json.example`](../../examples/claude-code-coordinator/.mcp.json.example),
which keeps the key out of shell history by reading it from an environment
variable (`${FREELLMAPI_UNIFIED_KEY}`) instead of a literal value:

```json
{
  "mcpServers": {
    "freellmapi": {
      "type": "http",
      "url": "http://127.0.0.1:3002/mcp",
      "headers": {
        "Authorization": "Bearer ${FREELLMAPI_UNIFIED_KEY}"
      }
    }
  }
}
```

Set `FREELLMAPI_UNIFIED_KEY` in your shell/session environment, not in a
file that gets committed. Either way, the port and server name
(`freellmapi`) must match whatever you actually set up in §2 — the `.mcp.json`
example above assumes the `PORT=3002` default from the env template.

## 4. Denying `set_routing_strategy`

The MCP surface exposes `set_routing_strategy` (`server/src/routes/mcp.ts`),
which changes the dedicated instance's routing strategy for **every** client
of that instance, not just this Claude Code session. The coordinator should
not be able to do that on its own judgment.

Copy
[`examples/claude-code-coordinator/settings.json.example`](../../examples/claude-code-coordinator/settings.json.example)
into the coordinator project as `.claude/settings.json` (or merge the `deny`
entry into an existing one):

```json
{
  "permissions": {
    "deny": [
      "mcp__freellmapi__set_routing_strategy"
    ]
  }
}
```

The tool name follows Claude Code's MCP naming convention,
`mcp__<server-name>__<tool-name>` — `freellmapi` here is the server name
chosen in §3's `.mcp.json`/`claude mcp add`. If you name the server
differently, update the deny entry to match.

## 5. Coordinator behavior instructions

Copy
[`examples/claude-code-coordinator/CLAUDE.md.example`](../../examples/claude-code-coordinator/CLAUDE.md.example)
into the coordinator project as `CLAUDE.md`. In short, it instructs the
coordinator session to:

- treat every response relayed through `ask_freellmapi` (or any other
  FreeLLMAPI MCP tool) as **untrusted output to verify**, not settled fact;
- always say **which model and route** answered a delegated call (the tool
  responses already report this — see `ask_freellmapi`'s result shape in
  `server/src/routes/mcp.ts`);
- **ask before any consequential action**, even one a delegated specialist
  model suggested;
- never call `set_routing_strategy` or ask the user to weaken free-only
  routing to "unblock" something.

## 6. Subscription auth vs. API-key billing — do not mix them

These are two unrelated things, and this setup only ever uses the first one:

| | Claude Code's own reasoning | A separate Anthropic API key |
| --- | --- | --- |
| Auth | Your Claude.ai subscription (OAuth/session) | `ANTHROPIC_API_KEY` from the Anthropic Console |
| Billing | Covered by your existing subscription plan | Billed separately, per token, by Anthropic |
| Used by this setup? | **Yes** — this is how the coordinator thinks | **No** |

**Do not set `ANTHROPIC_BASE_URL` to the FreeLLMAPI endpoint.** That
environment variable redirects Claude Code's *own* model calls to a
different Anthropic-API-compatible base URL. FreeLLMAPI's `/v1` surface is
OpenAI-compatible, not an Anthropic Messages API implementation, so pointing
`ANTHROPIC_BASE_URL` at it would not work as intended even as a hack, and
doing so would conflate "how Claude Code itself thinks" (subscription) with
"a tool Claude Code calls out to" (MCP, this whole page) — two auth and
billing models that must stay separate. Nothing in this setup needs
`ANTHROPIC_BASE_URL` or `ANTHROPIC_API_KEY` touched at all; FreeLLMAPI is
reached only through the MCP tools in §3.

(`03-glixel.md`'s "Claude" section covers the related, still-unbuilt idea of
giving GLIXEL itself a billed Anthropic provider adapter — a different,
separate decision from the coordinator setup on this page.)

## 7. Free-only routing stays on

The dedicated instance should keep `FREE_ONLY_ROUTING` at its default (on)
and leave `FREE_ONLY_ALLOW_PLATFORMS` unset, exactly as the
`.env.coordinator.example` template does. With that in place
(`server/src/services/free-only.ts`,
`docs/mobile-dev-hub/02-free-providers-and-fallback.md`):

- automatic routing only reaches models classed free-recurring or
  free-model-subset, with at least medium confidence, from a provider that
  isn't recorded as training on prompts;
- anything that doesn't qualify is refused outright (`403 free_only_blocked`)
  — **never** silently retried on a paid model;
- turning this off (`FREE_ONLY_ROUTING=off`) or opting a platform in
  (`FREE_ONLY_ALLOW_PLATFORMS=...`) are the only two ways to change that, and
  both log a startup warning. Neither should be done for the coordinator's
  instance without a deliberate, separate decision — see the coordinator
  instructions in §5, which tell the session never to ask for this as a
  workaround.

## 8. Rollback and troubleshooting

**Disconnect Claude Code from the MCP endpoint:**

```bash
claude mcp remove freellmapi
```

or delete the `mcpServers.freellmapi` entry from `.mcp.json` if you used the
project-scoped file.

**Disable the MCP surface on the dedicated instance** (reversible, affects
only that instance):

```bash
curl -X PUT http://127.0.0.1:3002/api/settings/enable-mcp \
  -H "Authorization: Bearer <dashboard-token>" -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

or toggle it off on the Keys page.

**Retire the dedicated instance entirely:** stop its process, then delete
*only its own* database file (`FREEAPI_DB_PATH`) and, if one was
auto-generated, its `.encryption-key` file next to that database
(`server/src/lib/crypto.ts`). Never touch another instance's database or key
file while doing this — they are unrelated files once the instances are
separate per §2.

**Common connection issues:**

- **Claude Code can't reach the endpoint at all:** confirm the dedicated
  instance is actually running on the port in your `.mcp.json`/`claude mcp
  add` command, and that the MCP surface is enabled (§2 step 4) — while off,
  every verb on `/mcp` answers `403` with a JSON-RPC error saying so.
- **401 from `/mcp`:** the Bearer token doesn't match that instance's current
  unified key (`server/src/routes/mcp.ts`'s `authenticate`). Regenerating the
  unified key on the dashboard invalidates the old one everywhere, including
  any `.mcp.json`/`claude mcp` registration using it.
- **A specialist model request fails with a DNS-looking error (e.g. a Gemini
  model):** see the new entry in
  [`docs/en/troubleshooting/01-common-issues.md`](../en/troubleshooting/01-common-issues.md#gemini-request-fails-with-a-dns-looking-error)
  for how to tell a DNS/transport failure apart from an API-key, quota, or
  request-size error before assuming a cause.
