---
title: MCP library
---

# MCP library

The MCP library gives your agents new tools from [Model Context Protocol](https://modelcontextprotocol.io) servers. Open it under **Settings → Organisation → MCP library**. You need organisation admin rights and the Enterprise plan (licence feature `mcp_marketplace`).

There are two kinds of server in the library:

| Kind | Who installs it | Where it runs | Capability id |
|------|-----------------|---------------|---------------|
| **Organisation server** | An organisation admin, for their own organisation | At the vendor (remote, https) | `custom:<uuid>` |
| **Server-wide server** | The server administrator, for every organisation | On the Bee Flow server, or remote | `mcp:<serverId>` |

## Adding a server (organisation admins)

1. Pick a server under **Add a server**, or choose **Connect another server** to enter an address yourself. You can only do that if the server policy allows it.
2. **Connect.** Paste the key if the server needs one, and choose whose key it is:
   - **One key for everyone**: your key is encrypted and lent to the organisation. Every member acts with its permissions.
   - **Everyone uses their own key**: members add their own key under **Settings → Connections**. Your key only checks the connection.

   Then click **Check connection**. Bee Flow connects once, lists the tools and stores nothing.
3. **Tools.** Switch on only what agents need. Each tool shows whether the server says it only reads or can change data. Tools the server marks as destructive start switched off.
4. **Access.** Give the server to everyone in the organisation, or only to specific groups. Review the summary and click **Install**.

The tools then appear in the chats and agents of the people you chose. A curated agent still only gets the tools it was given.

Open an installed server to switch it off, change its tools or access, replace or stop sharing the key, check for new tools, or remove it. Removing a server deletes every key stored for it, including members' own keys.

### Server-wide servers

**From your server administrator** lists the servers installed for every organisation. Open one to choose who in your organisation uses it, or switch it off for everyone. If the server is not part of your organisation's plan, ask your server administrator.

## Security model

- **Nothing runs on the Bee Flow server.** Organisation servers are remote-only. An organisation admin can never install a command or a package.
- **No private networks.** Every connection is checked to resolve to a public address, pinned to that address, and sent over https without following redirects. This applies to the check, the install and every tool call.
- **Pinned endpoints.** For an official server from the library, the address comes from Bee Flow, not from the browser.
- **Keys** are encrypted per organisation and bound to the server's origin. Bee Flow refuses to send a key to any other address, and scrubs keys from tool results and error messages.
- **New tools stay off.** When a server adds tools later, they appear under **Check for new tools** but stay switched off until an admin turns them on.
- **Isolation.** Each call checks again that the server belongs to the caller's organisation, is switched on, and is part of the caller's entitlements.
- **Audit.** Every install, change and removal is written to the access audit log, with names and counts but never keys.
- Organisation servers are not yet available in automations (unattended runs).

## Server policy (server administrators)

A server administrator sees an extra **Server-wide** tab in the library. It holds the policy for organisation admins and the server-wide servers.

| Policy | Organisation admins may install |
|--------|---------------------------------|
| Switched off | Nothing. Servers installed earlier stop working but are kept. |
| **Official servers only** *(default)* | The vendor-hosted servers in the Bee Flow library, at their fixed addresses. |
| Official servers and approved hosts | The above, plus servers on the hosts you list (`mcp.example.com`, or `*.example.com` for subdomains). |
| Any public server | Any public https server. Private networks stay blocked. |

The policy is checked again on every tool call. Tightening it immediately stops servers that no longer qualify, and the library marks them **Blocked by policy**. The policy is stored as `mcp_org_policy` in the server configuration.

### Server-wide servers

Under **Installed for every organisation → Install a server** you can install from the curated library, the open [MCP registry](https://registry.modelcontextprotocol.io), or a custom command or address. A local server is a program the Bee Flow server downloads and starts. It runs with a minimal environment (no database URL or master key) but it does have network access. Prefer remote servers and pinned package versions (`@1.2.3`).

On a plan with an explicit integration list, add the server (`mcp:<serverId>`) to the plan before organisations can switch it on.

## API

| Endpoint | Who |
|----------|-----|
| `GET /api/mcp-library/org` | Organisation admin: library, catalogue, policy, server-wide servers |
| `POST /api/mcp-library/org/probe` | Check a server; stores nothing |
| `POST /api/mcp-library/org/servers` | Install |
| `PATCH /api/mcp-library/org/servers/:id` | Switch on/off, tools, access, stop sharing the key |
| `PUT /api/mcp-library/org/servers/:id/credential` | Replace the shared key (checked first) |
| `POST /api/mcp-library/org/servers/:id/refresh` | Check for new tools |
| `DELETE /api/mcp-library/org/servers/:id` | Remove, with all its keys |
| `PUT /api/mcp-library/org/server-wide/:serverId` | Who in the organisation uses a server-wide server |
| `GET /api/mcp-library/me`, `PUT`/`DELETE /api/mcp-library/me/:id/credential` | Members: their own keys |
| `GET`/`PUT /api/mcp-library/policy` | Server administrator: the policy |
