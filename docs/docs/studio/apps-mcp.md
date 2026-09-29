---
title: Building apps from your editor (MCP)
---

# Building apps from your editor (MCP)

Bee Flow can expose the **App Studio builder toolset over MCP**, so a coding
agent in your editor — Claude Code in VS Code, or any other MCP client — creates
and edits real apps in a running Bee Flow instance.

This exists because of a specific dead end. A bespoke app for one customer could
be talked into existence through the in-product builder, or written as a
template module under `server/appStudio/templates/`. Templates are compiled into
the API image, so every iteration cost an image build, a push and a redeploy.
That is the right price for a template every tenant gets, and the wrong price
for iterating on one customer's app. Over MCP the edit lands in the database of
the instance you point at, and the image never changes.

It is off by default and has to be switched on deliberately.

## Turning it on

Set the flag on the API server:

```bash
STUDIO_MCP_ENABLED=1
```

In the Docker stacks it is passed through already — put it in your `.env` and
recreate the server container. While the variable is unset the route is never
mounted and the module is never loaded, so `/mcp/studio` simply does not exist.

Then mint a bearer token for the user whose apps you want to edit:

```bash
docker compose exec server node scripts/mint-mcp-token.js --email you@example.com
```

The token is shown **once**. Minting again replaces it; `--revoke` kills it.
It is the same token the [Nextcloud assistant integration](../connector/index.md)
uses for `/mcp`, so a user has exactly one.

## Wiring up Claude Code

```bash
claude mcp add --transport http beeflow-studio \
  http://localhost:3101/mcp/studio \
  --header "Authorization: Bearer bfmcp.…"
```

Any MCP client that speaks streamable HTTP works the same way; the endpoint is a
single `POST` with JSON-RPC and does not open an SSE stream.

## What the agent gets

The same tools the in-product builder agent uses — `app_upsert_table`,
`app_seed_records`, `app_add_screen`, `app_add_components`, `app_set_action`,
`app_bind_action`, `app_dry_run`, `app_screenshot`, `app_finalize` and the rest —
plus three entry points:

| Tool | Purpose |
| --- | --- |
| `studio_get_guide` | The component catalog, action/step vocabulary, binding kinds and formula functions. Call it once at the start of a session. |
| `studio_list_apps` | The apps this token's user owns. |
| `studio_create_app` | A new app, optionally installed from a built-in template. |

Every `app_*` tool takes an `appId`. Each call is independent and re-reads the
app from the database, so nothing is held in a server-side session that could
expire mid-build, and a browser tab open on the same app cannot silently lose
work — the optimistic-concurrency check reports the conflict instead.

`app_screenshot` returns a real image, so the agent can look at what it built and
fix what is visibly wrong before finalising.

## Access control

Four independent gates, all of which must pass:

1. `STUDIO_MCP_ENABLED=1` on the server — the operator's switch.
2. A valid `bfmcp.…` bearer token — resolves to exactly one Bee Flow user.
3. The `app_studio` licence capability for that user, re-checked on every call
   so a lapsed licence stops an already-connected client.
4. Write access to the target app — the same owner check the REST API uses.

A token grants exactly what that user could do in the App Studio UI: no more, and
never another user's apps.

## When to still use a template

Templates remain the right answer for an app that ships with the product and
every tenant should be able to install. Use MCP for building and iterating; move
something into `server/appStudio/templates/` when it has earned a place in the
catalog. See [App templates](apps.md).
