---
title: "Nextcloud — Files & WebDAV"
---

# Nextcloud — Files & WebDAV

The umbrella Nextcloud integration. Backs all file operations the assistant performs against your Nextcloud.

| | |
|---|---|
| Integration ID | `nextcloud` |
| Auth | NC session (when embedded) **or** OAuth Bearer (standalone) **or** Basic + app password (fallback) |
| Required scope | `FILES`, `DAV` |
| Source | `server/integrations/nextcloudTools.js` (54 KB, comprehensive) |

## Tools exposed

| Tool | Purpose |
|------|---------|
| `nextcloud_list_files` | List files in a folder. |
| `nextcloud_search_files` | Full-text search. |
| `nextcloud_read_file` | Fetch the contents of a file — PDF, DOCX, PPTX (slide text + speaker notes, one section per slide), XLSX/CSV and plain text go through the same extraction pipeline chat uploads use. |
| `nextcloud_upload_file` | Upload a new file or overwrite. Inside an automation, `sourceHandle: {kind: "generated_file", fileId}` pushes the file a `generate_document`, `fill_document` or `presentation` step kept — bind the whole handle from that step's `output.sourceHandle`. |
| `nextcloud_create_spreadsheet` | Build a real `.xlsx` / `.ods` from rows (or append to one) — opens in Nextcloud Office. |
| `nextcloud_create_document` | Build a real `.docx` / `.odt` from text or markdown — opens in Nextcloud Office. |
| `nextcloud_create_presentation` | Build a real `.pptx` in the organisation's house style from structured slides or a markdown outline; answers with the `/f/<fileId>` link that opens it in Nextcloud Office (Impress). |
| `nextcloud_create_folder` | Create a folder. |
| `nextcloud_share_file` | Create an internal share or a public link. |
| `nextcloud_move_file` | Move / rename. |
| `nextcloud_copy_file` | Copy. |
| `nextcloud_delete_file` | Delete (moves to trashbin). |
| `nextcloud_get_file_versions` | Browse the version history. |
| `nextcloud_restore_file_version` | Restore a previous version. |

All tools take paths relative to the user's root (`/Documents/Foo.pdf`, not `/remote.php/dav/files/<uid>/Documents/Foo.pdf`).

## Auth details

### Embedded in Nextcloud (preferred)

Through the connector's HMAC `/nc/*` proxy. The Bee Flow service signs the call with the tenant key; the connector forwards it to NC with `EX-APP-USER-ID: <yourUid>`. AppAPI switches the request context server-side. **No password ever leaves Nextcloud**.

### Standalone (no connector)

OAuth 2.0 with Nextcloud:

```bash
OAUTH_NEXTCLOUD_CLIENT_ID=<app-id>
OAUTH_NEXTCLOUD_CLIENT_SECRET=<secret>
OAUTH_NEXTCLOUD_BASE_URL=https://nc.example.com
```

Register the OAuth client in NC at **Administration → Security → OAuth 2.0 clients**. Redirect URI: `https://your-host/auth/callback/nextcloud`.

Clients registered before the provider-parameterised routes existed use `https://your-host/auth/callback` (no provider segment). That path still works and is kept for exactly those registrations; use the one above for a new client.

### Basic + app password (fallback)

For users who didn't connect via OAuth. The user sets it in **Settings → Account → Integrations → Nextcloud → Add app password**. NC generates the password and stores it AES-encrypted in Postgres (`BEEFLOW_ENCRYPTION_KEY`).

## No Docker on your Nextcloud host? {#no-docker}

The [Nextcloud connector](../connector/index.md) is an app that Nextcloud starts as a Docker container. On managed or shared hosting, or on any host where you cannot run Docker for Nextcloud's AppAPI, it cannot be installed ([compatibility](../connector/index.md#compatibility)).

Bee Flow still works with such a Nextcloud. Without the connector, Bee Flow reaches Nextcloud from outside, as each user: through [OAuth](#standalone-no-connector) or an [app password](#basic--app-password-fallback), as described above. What you need:

- A Bee Flow server: Bee Flow Cloud, or [your own](../self-hosting/index.md) on a machine where Docker does run.
- A Nextcloud that this server can reach over HTTPS. A server refuses private network addresses unless it is set up to allow them ([details](../connector/troubleshooting.md#not-reachable)).
- For OAuth: a Nextcloud administrator who can register an OAuth 2.0 client. An app password needs no administrator; each user creates one.

What is different without the connector:

| | With the connector | Without it |
|---|---|---|
| Where users open Bee Flow | Inside Nextcloud, from the top bar, with their Nextcloud session | In Bee Flow itself (browser, desktop or mobile app), where they sign in to Bee Flow |
| Nextcloud tools in chat, agents and automations | Yes | Yes, with the user's own OAuth sign-in or app password |
| Deck and Notes tools | Yes | Only with an app password. With an OAuth sign-in alone these tools ask for one (**Settings → Connections**). |
| Bee Flow bot in Talk | Yes | No: the connector registers it |
| Bee Flow as a provider for Nextcloud Assistant | Yes | No: the connector registers it |
| Bee Flow actions in the Nextcloud Files app | Yes | No: the connector registers them |
| Automations started at once by a Nextcloud event (file, tag, calendar, Forms, Tables, Deck) | Yes | No: Nextcloud delivers these events to the connector |

## Scopes & permissions

All tools run under the calling user's NC permissions. The assistant cannot access other users' files; sharing tools require the user's existing share permissions.

## Privacy Shield interaction

File contents pulled via `nextcloud_read_file` are scanned by the Privacy Shield before injection into the prompt. If the PII action is set to `block`, prompts referencing file contents with sensitive categories are refused; otherwise the matches are tokenised.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `401 Unauthorized` | App password rotated | Re-add in user settings. |
| `403 Forbidden on share` | User lacks share permission | NC admin grants the share role. |
| `404 Not Found` | Path typo | Use absolute paths from user root. |
| `Quota exceeded` | NC quota | Free up space or raise quota in NC. |

## Group-level disable

Org admins can disable `nextcloud` at the org or per-group level. Disabling for a group removes all 11 file tools from that group's users. See [Admin → NC integrations](../admin/nc-integrations.md).
