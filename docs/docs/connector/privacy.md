---
title: "Privacy & data flow"
---

# Privacy & data flow

The connector sends data to one place only: the Bee Flow server a Nextcloud administrator chose, which is Bee Flow Cloud or your own server. This page is the authoritative description of what's sent, when, and what is **never** sent.

## Before a server is chosen: nothing

After installing, the connector has no Bee Flow server. Until an administrator
[chooses one](setup-picker.md):

- nothing is sent to any Bee Flow server, and no part of the web app is loaded from one;
- no organisation is created anywhere;
- the connector does not read the list of administrators, and stores nothing about Bee Flow unless
  an administrator saves something on the setup page. The only files it may write by itself are the
  trust record for your own Nextcloud's certificate (`nc-trust/` and the certificate pin), on a
  Nextcloud whose certificate is self-signed or from an internal certificate authority.

The connector talks to your own Nextcloud only (its lifecycle calls and registrations, such as the
top-bar entry and the settings form). An administrator who opens Bee Flow gets the setup page, which the
connector serves itself; everybody else gets a short notice.

An install-time value in `BEEFLOW_API_BASE_URL` (a server URL, or the word `cloud`) is such a choice,
made by whoever installs the app.

## Sent when the server is chosen

The setup page shows this before the administrator presses **Connect**, with the host it goes to:

- the names and e-mail addresses of this Nextcloud's administrators;
- the address of this Nextcloud, its instance id and its version (the server uses them to check that
  the request comes from that Nextcloud).

The chosen server creates an organisation for this Nextcloud, or joins it to an existing one when a
pairing code is given, and hands the connector its tenant key. Before any of this, the connector
asks the chosen address for `/api/health`; when no Bee Flow server answers there, nothing is saved
and nothing is sent.

To find the administrators, the connector asks Nextcloud for the members of the `admin` group.
Where Nextcloud does not answer that to an app (current versions do not), the connector lists the
accounts and reads each account's record (e-mail address, display name, groups) to see who is an
administrator. That reading stays inside the connector on your own infrastructure: only the
administrators' names and e-mail addresses are sent to the chosen server.

A connector that was given a tenant key at install sends no such request and does not read the
accounts: it takes the key into use for the chosen server.

## Synchronised after the choice

- Users and groups: user id, e-mail address, display name and group memberships of the Nextcloud
  accounts, read by the Bee Flow server through the connector. The organisation's administrator sets
  which groups are synchronised in the onboarding wizard and later under
  **Settings → Organisation**. Until that wizard is finished, other users cannot use Bee Flow
  ([why](troubleshooting.md#setup-in-progress)).
- On every sign-in: your Nextcloud user id, e-mail address, display name and group memberships (used
  to identify your organisation and apply group-based permissions).

## Sent on demand (per user action)

The contents of items you explicitly point the assistant at — and only those items, only at the moment of fetching:

| When you say… | What's sent |
|---------------|-------------|
| "Summarise this file" | The file's contents (not the rest of the folder) |
| "Reply to this email" | The email body + thread headers |
| "Find Q3 reports" | The matching file metadata (paths, sizes, modified dates), not their contents |
| "Create a calendar event for…" | The event description you typed |
| "Search Talk for the discussion about…" | The matching message snippets |

If the assistant chooses to fetch a file's body to answer a search-style query, you'll see a `tool_call` event in the conversation showing the path. Open it to inspect.

## Never sent

- Bulk file/mail/calendar/contacts contents
- Items in folders you didn't reference
- Items belonging to other users
- NC admin secrets, system config, or audit logs
- Browser cookies, session tokens, or device fingerprints

The connector forwards individual requests; nothing is copied, mirrored or indexed by default.

## Detailed by integration

| Integration | What's sent on demand | Endpoints used |
|-------------|------------------------|----------------|
| Files | File contents (binary or text), folder listings, share metadata | WebDAV `PROPFIND` / `GET` / `PUT` |
| Mail | Message body + headers, draft contents you create | `/index.php/apps/mail/api/...` |
| Calendar | Event details (title, time, attendees, body) | CalDAV `REPORT` / `PUT` |
| Contacts | Contact card fields (name, email, phone) | CardDAV |
| Deck | Card title, description, comments, labels | `/index.php/apps/deck/api/v1.0/...` |
| Talk | Message text, room metadata | `/ocs/v2.php/apps/spreed/api/v4/...` |
| Notes | Note body, tags | `/index.php/apps/notes/api/v1/notes` |
| Tasks | VTODO objects (title, due date, completed flag) | CalDAV |
| Activity | Read-only activity feed entries | `/ocs/v2.php/apps/activity/api/v2/activity` |
| Notifications | Notification IDs you reference, dismissed | `/ocs/v2.php/apps/notifications/api/v2/notifications` |
| User Status | Your status text + emoji | `/ocs/v2.php/apps/user_status/api/v1/user_status` |

Every request is signed with the tenant-key HMAC and bound to your NC user ID — see [Architecture](architecture.md).

## Inbound webhooks (NC → connector → SaaS)

Once a server is chosen and the connector holds its key, it registers these events in Nextcloud's
`webhook_listeners` app. They are the push triggers of automations. Nextcloud delivers each event to
the connector, which forwards it to the chosen Bee Flow server:

| Nextcloud event class | Forwarded as |
|-----------------------|--------------|
| `OCP\Files\Events\Node\Node{Created,Written,Deleted,Renamed,Copied}Event`, and `NodeRestoredEvent` where Nextcloud has it | `file.new`, `file.changed`, `file.deleted`, `file.renamed`, `file.copied`, `file.restored` |
| `OCP\SystemTag\Tag{Assigned,Unassigned}Event` | `file.tagged`, `file.untagged` |
| `OCP\Calendar\Events\CalendarObject{Created,Updated,Deleted,Moved}Event` | `calendar.event.created`, `.changed`, `.deleted`, `.moved` |
| `OCA\Forms\Events\FormSubmittedEvent` (when Forms is installed) | `forms.submitted` |
| `OCA\Tables\Event\Row{Added,Updated,Deleted}Event` (when Tables is installed) | `tables.row.added`, `.updated`, `.deleted` |
| `OCA\Deck\Event\Card{Created,Updated,Deleted}Event` (when Deck is installed) | `deck.card.created`, `.changed`, `.deleted` |

A forwarded event holds the trigger name, the user id and display name of who acted, the time, and
what Nextcloud puts in the event:

- a file: its id and path, and whether it is a file or a folder; for a tag the ids of the tag and the file;
- a calendar event: the identifiers of the event and its calendar, the calendar's owner and who it is
  shared with. Not its title, time or text;
- a form submission: the form's id, title and owner, the submission's id and who submitted. Not the answers;
- a table row: the ids of the table and the row, and the values of the row;
- a Deck card: its id, title, description, list, board, due date, labels and assigned users.

User and group changes are not delivered as events. They arrive through the periodic
synchronisation and the **Sync now** action, in which the Bee Flow server reads users and groups
through the connector.

## Encryption in transit

| Hop | Crypto |
|-----|--------|
| Browser ↔ Nextcloud | Your existing NC TLS configuration |
| Nextcloud ↔ Connector | AppAPI signed proxy (HTTP inside the cluster — relies on cluster network) |
| Connector ↔ Bee Flow service | TLS 1.2+ (HTTPS to `server.beeflow.nl` or your self-hosted server) |
| Bee Flow service ↔ NC (callback) | TLS 1.2+ + HMAC signature |

For self-hosters: you choose your own TLS termination on the Bee Flow service. Caddy / Nginx / Traefik examples in [Self-hosting → Docker Compose](../self-hosting/docker-compose.md).

## Privacy Shield (in-tenant filter)

Before any prompt leaves the connector, the **[Privacy Shield](../features/privacy-shield.md)** scans for sensitive data and replaces matches with placeholders. The model only ever sees the placeholders. The original values are restored in the reply, only on your screen.

Default detection covers email addresses, phone numbers, IBANs, BSNs (NL), credit-card numbers, IP addresses and credentialed URLs. Strict mode adds person names, dates of birth, addresses, organisation names, passport / ID numbers. See the full category list on the Privacy Shield page.

## Retention

| Layer | Retention |
|-------|-----------|
| Connector RAM | Per-request only — no on-disk caching of fetched items |
| Connector tenant-key cache | `${APP_PERSISTENT_STORAGE}/tenant-key.json`, mode `0600`. Persists across restarts. Contains: `tenantKey`, `organizationId`, `organizationName`, `boundApiBaseUrl` (the server that issued the key), `cachedAt`. Written only after a server is chosen. |
| Connector setup choice | `${APP_PERSISTENT_STORAGE}/setup-config.json`, mode `0600`. The chosen server, its web app URL and the public Nextcloud URL, as saved on the setup page, and the server the settings form named while none was chosen (kept so that it stays without effect). |
| Bee Flow service (chat history) | As long as the conversation exists (deletable by the user) |
| Bee Flow service (raw file bodies) | Held only for the duration of the LLM turn unless explicitly indexed into a Knowledge Base |
| Audit log | 90 days by default; configurable per-org (Enterprise+) |

## How to inspect what's leaving

| Need to verify | Where to look |
|----------------|----------------|
| Per-call NC API access | `tail -f data/nextcloud.log \| grep bee_flow` |
| Per-call connector activity | `docker logs nc_app_bee_flow --tail 200 -f` |
| Per-tool-call provenance in chat | Inline tool-call rows in the conversation — click to expand request/response |
| Per-org audit | **Admin → Compliance** (Enterprise+) |

## Full policy

See [https://beeflow.nl/privacy](https://beeflow.nl/privacy).
