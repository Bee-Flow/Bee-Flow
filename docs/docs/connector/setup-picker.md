---
title: Choose where Bee Flow runs
---

# Choose where Bee Flow runs

The connector has no Bee Flow server until a Nextcloud administrator chooses one. The choice is made
once, on the connector's own **setup page**: **Bee Flow Cloud** (`server.beeflow.nl`, hosted by
Bee Flow B.V. in the Netherlands) or **your own Bee Flow server**.

Until that choice, nothing is sent to any Bee Flow server and nothing is created anywhere. See
[Privacy & data flow](privacy.md) for what the choice itself sends.

## Not set up yet

After installing, the bee icon is in the top bar and the connector is healthy, but it is connected to
nothing.

| Who opens Bee Flow | What they see |
|---|---|
| A Nextcloud administrator | The setup page with the two cards. Nothing is preselected. |
| Everybody else | "Bee Flow is not set up yet. Ask your Nextcloud administrator to open Bee Flow and choose where it runs." That page makes no request. |

In this state:

- `/heartbeat` answers `{"status":"ok","bootstrap":"server_not_chosen"}`, and the install reaches
  100% in AppAPI.
- Calls of the web app are answered with `503` and the code `server_not_chosen`. Nothing is proxied
  and no part of the web app is fetched from a Bee Flow host.
- The Talk bot is not registered yet. It is registered once a server is known.

## Making the choice

Open **Bee Flow** from the Nextcloud top bar as an administrator and pick a card:

- **Bee Flow Cloud.** No fields.
- **Self-hosted server.** The URL of your Bee Flow server, optionally the URL of its web app, and a
  pairing code (`XXXX-XXXX`) that joins this Nextcloud to an organisation on that server. A
  self-hosted server links a Nextcloud by pairing code by default: generate one in Bee Flow under
  **Settings → Organisation → Pair a new Nextcloud**. Without a code such a server answers
  "Pairing code required" for a Nextcloud it does not know.
  The card links to the [self-hosting guide](../self-hosting/docker-compose.md); the whole route is
  in [Bee Flow on your own server next to Nextcloud](own-server.md).

Before you press **Connect**, the page shows what connecting sends and to which host:

> When you connect, the names and e-mail addresses of this Nextcloud's administrators, its address,
> instance id and version are sent to *host*, an organisation is created there, and users and groups
> are synchronised afterwards. Nothing is sent before you press Connect.

What happens on Connect:

1. The connector asks the chosen address for `/api/health`. When no Bee Flow server answers there,
   **nothing is saved and nothing is sent**, and the page names the failure: server unreachable or
   certificate not trusted.
2. The choice is saved in `${APP_PERSISTENT_STORAGE}/setup-config.json` (mode `0600`) and the
   connector connects to that server. No container restart is needed.
3. The page reports the outcome: connected to your organisation, a code was e-mailed to an
   administrator (open Bee Flow to enter it), or the failure with its name.

A first choice whose check passed stays chosen when connecting then fails, for example because the
server asks for a pairing code. The connector is then on that server without a key. Until the
connection is made, **Bee Flow** in the top bar opens the setup page for an administrator, with the
failure and what to do about it, also on a later visit; everybody else sees the heading "Bee Flow
is not connected yet" and "Ask your Nextcloud administrator to open Bee Flow and finish connecting
it." The
failure is also in `GET setup/diagnostics`. Enter the pairing code or fix the cause and connect
again.

### After connecting: the onboarding wizard

Connected is not yet open to everybody. The Bee Flow server holds an organisation that was just
linked to a Nextcloud in onboarding until an organisation administrator has gone through its
wizard (which groups are synchronised, and so on):

1. Open **Bee Flow** from the top bar as a Nextcloud administrator. The web app shows the wizard
   ("Welcome to Bee Flow for *organisation*"). Finish it.
2. From then on the other users get the app.

Until step 1 is done the server answers every request of another user with `403` and the code
`NC_ONBOARDING_PENDING`; they cannot use Bee Flow yet. This gate is the server's, the connector
passes its answer on.

Named failures, shown in the administrator's Nextcloud language (English and Dutch):

| Failure | Meaning |
|---|---|
| Server unreachable | The address does not answer from the connector container. |
| Certificate not trusted | The server's certificate does not verify. Use a certificate from a public certificate authority, or give your own certificate authority in `BEEFLOW_SERVER_CA_CERT`. |
| Version mismatch | The server and the connector do not work together in these versions. |
| Pairing code required | The server does not create an organisation by itself; generate a code in Bee Flow under **Settings → Organisation → Pair a new Nextcloud**. |
| Pairing code not accepted | The code is mistyped, expired or already used. Generate a new one in the same place and enter it on the setup page; nothing has to be installed again. |

## The same choice in Nextcloud's settings

The **Artificial Intelligence** section of Nextcloud's administration settings (`/settings/admin/ai`;
some Nextcloud versions label it **Assistant** in the menu) holds a **Bee Flow** form with the same
choice. Its first option, **No change (keep the current connection)**, is the default; with it selected the form asks
for nothing.

- A server counts as chosen there once an administrator makes the form name another server than it
  did: by changing the deployment mode, or the self-hosted API URL while **Self-hosted server** is
  selected. The server the form already names while none is chosen is not a choice. It stays without
  effect after a choice on the setup page and after a restart, until the form names another one.
  An address typed next to **Bee Flow Cloud** or **No change**, and the web app URL alone, never
  choose a server.
- "Another server" is about the server, not about how its address is typed: the address of the
  server in use with a trailing slash, with the host in capitals or with the default port written
  out is the same server, and the connection is left as it is.
- A first choice made in the form checks the address in the same way as the setup page. When no
  Bee Flow server answers, nothing is saved and nothing is sent, and the connector looks again at its
  next poll (every 60 seconds).
- A switch made in the form that does not happen (see [Switching later](#switching-later)) is tried
  again for as long as the form names that server: at each poll the connector asks that address for
  `/api/health`, and it makes the switch again once a Bee Flow server answers there. Until then the
  connection in use is not touched. Select **No change** to stop it.
- The form's description states what choosing a server sends.

## Which server the connector uses

The server is worked out once when the connector starts. The first match wins:

| # | Source | Meaning |
|---|--------|---------|
| 1 | The install-time value `BEEFLOW_API_BASE_URL` | The word `cloud` (any capitalisation) for Bee Flow Cloud, or the URL of a server. Fixed: see below. |
| 2 | An existing binding (`tenant-key.json`) | The server that issued the key the connector holds. An install that is connected keeps its server. |
| 3 | The saved choice (`setup-config.json`) | What an administrator chose on the setup page or in the settings form. |
| 4 | A tenant key given at install next to the address `https://server.beeflow.nl` | A key pasted for an organisation on Bee Flow Cloud. |
| 5 | None | No server. The connector waits for an administrator. |

`GET setup/status` (administrators only) reports the result in `configured`, `active` and `source`.

`GET setup/diagnostics` reports how far the connection is, in `state`:

| `state` | Meaning |
|---|---|
| `server_not_chosen` | No server is chosen. |
| `initialising` | A server is chosen and the connector is connecting to it. |
| `awaiting_email_verification` | The server e-mailed a code to an administrator; open Bee Flow to enter it. |
| `awaiting_admin_approval` | The server waits for an organisation administrator to approve the link. |
| `failed` | Connecting failed and there is no key; `lastError` and `connectError` say why. |
| `ok` | Connected: the connector holds a tenant key for `apiBaseUrl`. |

`organizationId` and `organizationName` are filled in when the server issued the key. With a tenant
key given at install time they stay `null`: that key comes without them. `hasTenantKey` is `false`
for as long as no server is chosen, also when a key was given at install time, because the key is
taken into use only once a server is known. Somebody who is not a Nextcloud administrator gets
`{"canConfigure":false}` from this address and nothing else.

### Fixing the server at install time

Leave `BEEFLOW_API_BASE_URL` empty and the administrator chooses after installing. Fill it in only
to fix the choice:

```bash
sudo -u www-data php occ app_api:app:register bee_flow <daemon> \
    --env BEEFLOW_API_BASE_URL=https://beeflow.example.com     # or the word: cloud
```

The same field is in the advanced deploy options when you install from the Apps page.

- A value given there cannot be changed from inside Nextcloud. The setup page shows
  **Fixed at install time**, and saving a choice answers `409` with the code `env_locked`.
- For Bee Flow Cloud type the word `cloud`, not its address. The address
  `https://server.beeflow.nl` in this field is not a choice by itself.
- A value that is not `cloud` and not a valid server URL is logged and ignored.
- AppAPI stores install-time values and passes them again on every update. To change one, register
  the app again; the data volume with the binding is kept without `--rm-data`:

  ```bash
  sudo -u www-data php occ app_api:app:unregister bee_flow
  sudo -u www-data php occ app_api:app:register bee_flow <daemon> \
      --env BEEFLOW_API_BASE_URL=<new value>
  ```

  On a `manual-install` daemon stop the connector container before unregistering and start it
  again when you register: see
  [Where you start the container yourself](./troubleshooting.md#manual-install).

## Where the setup page is

While no server is chosen, the setup page is what **Bee Flow** in the top bar opens. After that, an
administrator reaches it at the connector's `setup` path:

```
https://<your-nextcloud>/exapps/bee_flow/setup                               # HaRP
https://<your-nextcloud>/index.php/apps/app_api/proxy/bee_flow/setup         # other deploy daemons
```

The page is for Nextcloud administrators only.

## "Test connection"

The **Test connection** button asks `<your-url>/api/health` from the connector container and
reports:

- the HTTP status (200, 404, …);
- `version` and `tier` when the server includes them;
- the kind of network error (DNS failure, connection refused, certificate not trusted, timeout).

It uses the same network the connector itself uses.

## Switching later

The setup page stays available. A switch from one server to another:

- drops the tenant key of the previous server and connects to the new one;
- goes back to the previous server when the new one does not connect. Saving answers at once
  (`200`, with the server you asked for under `saved`) and the connection is made afterwards: the
  page then names the failure (for example "certificate not trusted", with the option that solves
  it) and says that the previous server is still in use.
  `GET setup/diagnostics` keeps that failure under `rejectedSwitch`, with the server it is about;
  `lastError` there is always about the server in use. A switch asked for in the settings form is
  reported for as long as the form names that server: once the form is back on "No change", on the
  server in use or on another server, `rejectedSwitch` is empty again at the next poll (a minute at
  most). A switch asked for on the setup page is reported until the next change of server or a
  restart. Nothing is tried again on the server in use
  after a switch that did not happen: its key and its record stay as they were;
- does not move data: chats, agents and knowledge bases stay with the organisation on the server
  they were made on.

There is no "disconnect". To return to the not-set-up state, remove the app with its data
(`occ app_api:app:unregister bee_flow --rm-data`) and install it again. The organisation stays on
the server it was created on until it is deleted there (**Settings → Organisation → Danger zone**).

## What about the tenant key?

`BEEFLOW_TENANT_KEY=auto` (the default) lets the chosen server issue the key when the connector
connects. A key given at install is taken into use as it is once a server is known: next to
`BEEFLOW_API_BASE_URL` that server is known at once, and without a server address it is taken into
use when an administrator chooses the server on the setup page. No organisation is created in that
case and the administrator list is not read. The connector reads the instance id of this Nextcloud
from Nextcloud itself, the way it does when a server issues the key, so the key has to be the one
issued for this Nextcloud at this address; push triggers, the Talk bot, Assistant tasks and app
menu entries are signed with both. See
[Connector → Architecture](architecture.md#bootstrap-flow).

## OAuth callback URL — `connectorCallbackUrl`

OAuth flows initiated by the connector (e.g. linking Google or Microsoft from inside Nextcloud) need a stable, publicly-reachable URL to return to. The connector derives this at startup as:

```
<NC public URL>/index.php/apps/app_api/proxy/bee_flow/auth/<provider>/callback
```

— routed through NC's AppAPI proxy path, not the Docker-internal address of the connector container.

If OAuth round-trips break with `redirect_uri_mismatch` or land on a blank page, check the public Nextcloud URL on the setup page (or the install-time value `BEEFLOW_NC_PUBLIC_URL`, or NC's `overwrite.cli.url` / `trusted_domains`). It needs to match the URL users actually browse to.
