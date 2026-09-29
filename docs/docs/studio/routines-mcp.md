---
title: Building routines from your editor (MCP)
---

# Building routines from your editor (MCP)

Bee Flow can expose the **routine builder toolset over MCP**, so a coding agent
in your editor — Claude Code in VS Code, or any other MCP client — creates and
edits real automations in a running Bee Flow instance.

This is the sibling of [Building apps from your editor](apps-mcp.md), and it
exists because of a similar dead end. A routine could be talked into existence
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

Then mint a bearer token for the user whose routines you want to edit:

```bash
docker compose exec server node scripts/mint-mcp-token.js --email you@example.com
```

The token is shown **once**. Minting again replaces it; `--revoke` kills it.
It is the **same token** `/mcp` and `/mcp/studio` use, so a user has exactly one
credential across all three surfaces. A second token type would be a second
secret to rotate and a second way to get revocation wrong.

## Wiring up Claude Code

```bash
claude mcp add --transport http beeflow-routines \
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
| `routines_get_guide` | The trigger catalog, the step vocabulary with every field, the binding kinds and the restricted expression grammar. Call it once at the start of a session. |
| `routines_list` | The routines this token's user owns. |
| `routines_create` | A new, empty draft routine. |

Every `builder_*` tool takes an `automationId`. Each call is independent and
re-reads the routine from the database, so nothing is held in a server-side
session that could expire mid-build, and a browser tab open on the same routine
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

`builder_finalize` takes a routine out of draft. It does **not** switch it on.
Activation stays a human decision made in the product, and that is deliberate: a
live routine sends real mail and writes to real systems. An agent can hand you
something finished; it cannot start it.

## Access control

Four independent gates, all of which must pass:

1. `AUTOMATION_MCP_ENABLED=1` on the server — the operator's switch.
2. A valid `bfmcp.…` bearer token — resolves to exactly one Bee Flow user.
3. The `automations` beta feature for that user, re-checked on every call so
   withdrawn access stops an already-connected client. This is the same
   predicate that guards every authenticated `/api/automation` route, so an org
   can never build over MCP what it cannot build in the product.
4. Ownership of the target routine — a shared or published routine is not
   editable here, because publishing shares the *run*, not the source.

A token grants exactly what that user could do in the routine builder UI: no
more, and never another user's routines.
