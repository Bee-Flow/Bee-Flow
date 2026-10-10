---
title: Building automations from your editor (MCP)
---

# Building automations from your editor (MCP)

Bee Flow can expose the **automation builder toolset over MCP**, so a coding agent
in your editor — Claude Code in VS Code, or any other MCP client — creates and
edits real automations in a running Bee Flow instance.

This is the sibling of [Building apps from your editor](apps-mcp.md), and it
exists because of a similar dead end. An automation could be talked into existence
through the in-product builder agent, or drawn by hand on the canvas. Neither is
reachable from outside the browser, so the only option left for an external
agent was to write definition JSON straight into the row — bypassing the
builder's binding fixups and learning the contract by trial and error. Over MCP
the edit goes through the *same tools the product uses*, and the validator
answers in the same words.

It is off by default and has to be switched on deliberately.

## Turning it on

Set the flag on the API server:

```bash
AUTOMATION_MCP_ENABLED=1
```

In the Docker stacks it is passed through already — put it in your `.env` and
recreate the server container. While the variable is unset the route is never
mounted and the module is never loaded, so `/mcp/automations` simply does not
exist.

Then create a token for the user whose automations you want to edit. In Bee Flow
open **Settings → MCP tokens**, give the token a name, tick the `automations`
server (and a level: *read* lists and inspects, *write* builds), and optionally
restrict it to specific tools, to a list of IP ranges, or give it an expiry. The
token is shown **once**; revoke it from the same list. Several named tokens can
exist side by side, so each editor or CI job gets its own and can be revoked on
its own.

The older single token from `scripts/mint-mcp-token.js --email you@example.com`
still works (it is what the mobile app and the Nextcloud assistant use). It has
full access to the three surfaces and is labelled *legacy* in the list. An
organisation can [refuse legacy tokens altogether](#organisation-policy).

## Wiring up Claude Code

```bash
claude mcp add --transport http beeflow-automations \
  http://localhost:3101/mcp/automations \
  --header "Authorization: Bearer bfmcp.…"
```

Any MCP client that speaks streamable HTTP works the same way; the endpoint is a
single `POST` with JSON-RPC and does not open an SSE stream.

## What the agent gets

The same tools the in-product builder agent uses — `builder_propose_trigger`,
`builder_add_action`, `builder_add_ai_step`, `builder_add_condition`,
`builder_add_switch`, `builder_add_set`, `builder_add_http_request`,
`builder_add_generate_document`, `builder_add_slide`, `builder_add_presentation`, `builder_update_step`,
`builder_wire_error_branch`, `builder_request_dry_run`,
`builder_finalize` and the rest — plus three entry points:

| Tool | Purpose |
| --- | --- |
| `automations_get_guide` | The trigger catalog, the step vocabulary with every field, the binding kinds and the restricted expression grammar. Call it once at the start of a session. |
| `automations_list` | The automations this token's user owns. |
| `automations_create` | A new, empty draft automation. |

Every `builder_*` tool takes an `automationId`. Each call is independent and
re-reads the automation from the database, so nothing is held in a server-side
session that could expire mid-build, and a browser tab open on the same automation
cannot silently lose work.

A save that lands on a definition which is not yet valid comes back with
`validationErrors` attached rather than silently succeeding — a draft is allowed
to be incomplete, but a caller that cannot see the errors keeps building on top
of them.

### What is deliberately not exposed

Three builder tools are not advertised, because their other half lives in the
in-product SSE route and there is no turn here to implement it against:

- `builder_set_plan` — drives a per-turn to-do list streamed to the canvas.
- `builder_generate_layer` / `builder_generate_layers` — spawn the thinking-model
  flowlet sub-agent. Build the layer directly with `builder_create_layer` and the
  scoped graph tools instead.

## Finalise is not activate

`builder_finalize` takes an automation out of draft. It does **not** switch it on.
Activation stays a human decision made in the product, and that is deliberate: a
live automation sends real mail and writes to real systems. An agent can hand you
something finished; it cannot start it.

## Access control

Four independent gates, all of which must pass:

1. `AUTOMATION_MCP_ENABLED=1` on the server — the operator's switch.
2. A valid bearer token (`bfmcp_…`, or a legacy `bfmcp.…`) — resolves to exactly one
   active Bee Flow user, carries the `automations` server in its scope, and comes
   from an address its own IP list and the organisation policy allow. Read-level
   tokens only ever see and call read-only tools.
3. The `automations` beta feature for that user, re-checked on every call so
   withdrawn access stops an already-connected client. This is the same
   predicate that guards every authenticated `/api/automation` route, so an org
   can never build over MCP what it cannot build in the product.
4. Ownership of the target automation — a shared or published automation is not
   editable here, because publishing shares the *run*, not the source.

A token grants exactly what that user could do in the automation builder UI: no
more, and never another user's automations.

## Organisation policy

Org admins set one policy for every MCP endpoint under **Organisation → Security →
MCP access**: switch MCP off for the whole organisation, allow it only from given
IP ranges (IPv4 and IPv6), limit it to certain roles or named users, and refuse
legacy tokens. The strictest rule wins: a request must pass the organisation's IP
list and the token's own. A refused request gets a generic "unauthorised" or
"forbidden" answer that does not say which rule failed; the reason is in the
server log, with the token id and never the token. Suspended accounts lose MCP
access at once, and each token is limited to 120 requests per minute and each user to 300 across all
their tokens (a batch counts one per message, and a batch holds at most 20). Creating and
revoking tokens and changing the policy are written to the audit log.

:::warning IP allow-lists need the proxy in front
The client address comes from the reverse proxy's `X-Forwarded-For`, peeled off
`TRUST_PROXY_HOPS` (default 1) hops deep. Point MCP clients at the public URL that goes
through the proxy (the standard image proxies `/mcp` for you), and make sure the server
port itself (3101 / 3001) is not reachable from outside. A client that can talk to the
server port directly can claim any address in that header. Behind a second proxy
(a load balancer in front of the proxy, say) set `TRUST_PROXY_HOPS` accordingly, and
check the "your address" shown on the MCP access page before you save an IP list: it
must be your real address, not the proxy's.
:::
