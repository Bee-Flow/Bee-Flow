---
title: "0017: The Nextcloud connector has no Bee Flow server until an administrator chooses one"
description: Why the connector ships without a default server, why the choice is made on a page the connector serves itself, and why a value given at install time is fixed.
---

# 0017: The Nextcloud connector has no Bee Flow server until an administrator chooses one

**Status:** accepted, in effect since connector 2.0.0. **Code:** `nextcloud-connector/src/serverChoice.js`
(the resolver and the gate), `src/serverProbe.js`, `src/setup.js`, `src/declarativeSettings.js`,
`appinfo/info.xml`. **Enforced by:** `test/noServerChosen.test.js` (the real process, in four starting
situations, opens no connection to any host other than Nextcloud and writes no file),
`test/serverChoice.test.js` (the resolver, rule by rule, and that it writes nothing),
`test/firstChoice.test.js` and `test/settingsFormChoice.test.js` (a first choice is checked before
anything is saved or sent), `test/restartKeepsChoice.test.js` (the real process, twice on one volume:
a restart does not turn a value in the settings form into a choice) and `test/infoXmlDefaults.test.js` (no install-time default holds a
Bee Flow address).

## Context

The connector is installed from the Nextcloud App Store with one click, by an administrator who at
that moment has decided nothing about Bee Flow yet. Connecting a Nextcloud to a Bee Flow server is
not neutral: the names and e-mail addresses of its administrators, its address, instance id and
version go to that server, an organisation is created there, and users and groups are synchronised
afterwards. Bee Flow runs as a hosted service and on a customer's own server, and both are first-class.
Which of the two receives that data is the administrator's decision, and installing an app is not
that decision.

AppAPI adds a constraint of its own: it stores the resolved value of every variable declared in
`info.xml` at install, a `<default>` included, and passes it again on every update. A default in the
manifest is therefore indistinguishable, later, from a value somebody typed.

## Decision

- **No default.** `BEEFLOW_API_BASE_URL` and `BEEFLOW_EMBED_BASE_URL` are declared without a
  `<default>`. The connector's `apiBaseUrl` is `null` until a server is chosen, never an empty
  string or a placeholder.
- **No server means no tenant key in memory.** Every guard that exists for "no key yet" (minting a
  token, signing a callback, the `/nc/*` proxy, the task poller, the menu sync) thereby covers "no
  server" too.
- **Before the choice nothing leaves.** The provisioning flow returns before it reads the
  administrator list or a state file, and schedules no retry. A gate answers every request: the
  connector's own embed script and icon pass, a page load gets the setup page, everything else gets
  `503` with code `server_not_chosen`. Nothing is proxied and no part of the web app is fetched.
- **The choice is made on the page Nextcloud frames.** An administrator who opens Bee Flow gets the
  picker at the app's own URL; everybody else gets a notice that makes no request. Nothing is
  preselected, and the page states what connecting sends and to which host before the button is
  pressed. The settings form under Administration → Artificial Intelligence carries the same sentence,
  and it counts only once an administrator makes it name another server than it did. The server it
  names while none is chosen is kept as noted next to the saved choice, so it stays without effect
  after a restart.
- **A first choice is checked first.** The connector asks the address for `/api/health`; when no
  Bee Flow server answers, nothing is saved and nothing is sent.
- **Looking nearby is an offer, not a choice.** While no server is chosen, the setup page of an
  administrator asks the connector whether a Bee Flow server answers next to this Nextcloud
  (`src/serverDiscovery.js`, `test/serverDiscovery.test.js`): the same `/api/health` question, to a
  fixed list of addresses only (the Docker host when its address is a private one, and the server's
  container name, on the installer's port), never to an address on the internet and never to one
  from the request. An answer is shown as "use this address"; choosing and connecting stay the
  administrator's steps.
- **What is typed at install time is fixed.** `BEEFLOW_API_BASE_URL` holding the word `cloud` or a
  server URL is a choice made by whoever installs, and cannot be changed from inside Nextcloud. The
  literal address `https://server.beeflow.nl` there is not a choice by itself, because AppAPI replays
  it on installs where nobody typed it.
- **An install that is connected keeps its server.** The resolver reads the binding the connector
  already holds, so an update asks nothing and sends nothing new. It is read-only: working out the
  server never writes or deletes a file.

## Consequences

- A one-click install ends at the setup page. An administrator opens Bee Flow once and chooses; until
  then every user sees "not set up yet".
- An install that never finished connecting has no server after the update and shows the picker. A
  code that was e-mailed before cannot be entered; a new one is sent after the choice.
- An install with a tenant key given at install and no server address needs one click: the key is
  taken into use when the server is chosen.
- There is no way back to "not chosen" from inside Nextcloud. Undoing the choice is unregistering the
  app with its data (`occ app_api:app:unregister bee_flow --rm-data`) and installing it again. The
  organisation stays on the server it was created on until it is deleted there.
- Changing an install-time value means registering the app again; AppAPI has no command that edits a
  stored value.
- The Talk bot is registered only once a server is known, so Talk offers no bot that cannot answer.
- Every connector test names its Bee Flow server. A test that relies on an implicit server has none.
