# Fact sheet — Organisation Integrations (audience: org admin)

Status: **the area exists and is substantial.** It is not one screen but a *chain of five surfaces*
that a lesson must keep apart, because they answer five different questions.
Everything below was read from the code on branch `claude/builder-redesign-fase-1-6sun0h`
(2026-09-14). UI strings are quoted exactly as they appear in the source / `en-defaults.js`.

---

## 1. What the feature is for

Bee Flow agents, routines and Studio apps can call third-party tools (Gmail, Nextcloud Files,
YouTrack, AFAS, n8n, an MCP server…). Three separate decisions govern whether a given tool
actually fires for a given person:

1. **Does the subscription / licence include it?** — the *ceiling*. Set by the plan (cloud) or the
   server licence (self-hosted); an org admin can only look at it.
2. **Has the org admin handed it out?** — the *grant*. Done in
   Settings → Organisation → Integrations → **Integration access**, to *All members* or to a group.
3. **Has the individual supplied a credential?** — the *connection*. Done by each user in
   Settings → **Connections** (the personal screen), or lent to them by a colleague.

Miss any one of the three and the tool is silently absent from the agent's toolbox. That
three-step ladder is the single most important thing a learner must internalise.

Two extra org surfaces hang off the same menu: **GitHub Sync** (mirror agent configs to a repo)
and **Nextcloud Sync** (mirror NC users/groups into Bee Flow and choose which NC apps agents may
touch). Both appear conditionally.

---

## 2. Screens, with real labels

### 2.1 Settings → Organisation → Integrations
`/app/settings/organisation/integrations` (tab id `org_integrations`).
Rendered by `OrganisationSection.jsx` with `activeSection='integrations'`; the sidebar row comes
from `AdvancedSettings.jsx` (`labelKey: 'settings.integrations'` → **"Integrations"**, icon `Link2`,
colour `#0ea5e9`). The parent accordion row is **"Organisation"** (`settings.organisation`).

Page header (i18n `org.integ_*`):
- Eyebrow: **"Organisation Integrations"** (`org.integ_title`)
- Subtitle: **"Shared across all members of your organisation."** (`org.integ_subtitle`)
- Two tabs: **"Integration access"** (`org.integ_tab_access`) and **"Integration settings"**
  (`org.integ_tab_settings`). Default tab = `access`.

**Tab 1 — Integration access** renders `GroupAccessMatrix` with
`kinds={['integration']} hideLocked`:
- Heading (hard-coded, not i18n): **"Integration access"**
- Subtitle: **"Give an integration to your whole organisation or to a specific group. These are
  the integrations your subscription includes."**
- Left rail scope picker: **"All members"** (blue) then a **"Groups"** header with the group count
  in brackets. A search box **"Search groups…"** appears only when there are **more than 6 groups**.
- Empty group list: **"No groups yet. Create groups under Users & Groups to grant capabilities per
  team."**
- Right pane header: **"All members"** or the group name; beside a group name:
  **"grants stack on top of All members"**.
- Section label above the cards: **"Integrations"** (kind section; MCP servers appear here too,
  sorted under category *MCP servers*).
- Card sub-line when the group inherits: **"Granted to all members"** (blue).
- Empty state for this tab: **"Your subscription doesn't include any integrations yet."**
- Save feedback: **"Saved"** (emerald tick) or **"Save failed"** / **"Failed to load (<status>)"**.
- Messages auto-clear after **3.5 s**; each toggle is saved after a **450 ms** debounce.

**Tab 2 — Integration settings** shows a blue info card:
**"Configure the integrations themselves — credentials, instance URLs and workflows."**
Then, conditionally:
- `OrgNcIntegrationsPanel` (only for Nextcloud-bound orgs — see 2.3)
- **n8n** row — title "n8n", sub-line **"Connect n8n workflows as AI tools"** (`org.integ_n8n_desc`),
  containing the full `N8nSection` with its own tabs **Connection / Workflows / Permissions**,
  fields **"n8n Instance URL"** and **"API Key"**, button **"Test Connection"**.
- **Google Maps** row — sub-line **"Directions, route maps & places search in chat"**
  (`org.integ_maps_desc`), or **"Maps, directions & places — configured"** once a key is stored,
  plus a green **"Connected"** pill. Hint under the key field: *Enable **Directions API**,
  **Places API** & **Maps Embed API** in Google Cloud Console.*
- If none of the three apply: **"No integrations are enabled for this organisation. Contact your
  platform administrator."** (`org.integ_none`)

### 2.2 Settings → Connections (personal, every user)
Top-level tab `integrations`, URL `/app/settings/integrations`, sidebar label
**"Connections"** (`settings.connections`). Desktop only — it is in
`SETTINGS_DESKTOP_ONLY_TABS` and phones bounce to Preferences.

Top block = `ConnectionsManager`:
- Group label **"Connections"**, description **"Keep multiple named credentials per integration and
  lend a specific one to teammates. Recipients without a lent connection bring their own."**
- Empty state: **"No named connections yet."**; loading: **"Loading…"**; on failure the red line plus
  **"Try again"**.
- **"Add a connection"** opens: a Provider dropdown, a name box placeholder
  **`Name (e.g. "{provider} – Work")`**, an Auth type dropdown (HTTP only), the credential fields,
  then **"Create connection"** / **"Cancel"**.
- Providers offered here: Fireflies.ai, Gamma, GitHub, YouTrack, SignRequest, AFAS Profit, vPlan,
  NMBRS and **"HTTP API (custom)"**.
- Per row: a **"Default"** star pill, **"Set default"**, **"Rename"**, share icon, delete icon, and
  **"{count} shared"**.
- Share panel: **"Lending shares this connection with full delegation — the recipient's runs use
  your credentials."**, for HTTP also **"Sharing lends the full credential — recipients can call any
  URL with it."**; email box **teammate@company.com**; Expiry dropdown **No expiry / 7 days /
  30 days / 90 days**; buttons **"Lend to teammate"** and **"Lend to everyone in my organization"**.
  Recipients render as **"Everyone in org"**, the group name, or the user's email.
- Delete confirm: **"Delete this connection? Any automation using it will stop working."**; when it
  is shared: **"This connection is shared. Delete anyway and revoke all shares?"**

Below it the classic integration rows, grouped by `GroupLabel`:
**"Google Workspace"**, **"Productivity"**, **"Health"**, **"Social"**, **"Developer"**, and for
consumer accounts **"Organisation Tools"**. Rows expand inline and carry a green
**"Connected"** badge (`settings.connected`). Named rows include Fireflies.ai, YouTrack,
SignRequest, Gamma, AFAS Profit, vPlan, NMBRS, Nextcloud, Google Workspace, LinkedIn, Withings,
GitHub, and one row per installed MCP server.
GitHub hint: *Create token at github.com/settings/tokens with **repo** scope*, placeholder
`ghp_xxxxxxxxxxxxxxxxxxxx`. Nextcloud fields: *Nextcloud URL (e.g. https://cloud.example.com)*,
*Nextcloud username*, *App password*, hint *"Generate at Nextcloud → Settings → Security →
Devices & sessions."*, plus **"Auto-create from OAuth session (short-lived)"** for NC-OAuth users.
MCP rows read **"Configure your credentials for {toolCount} tools"** → once filled,
**"{toolCount} tools available — credentials configured"**, and each stored field shows
**"✓ Configured"**.

### 2.3 Settings → Organisation → Nextcloud Sync
`/app/settings/organisation/nextcloud-sync`, label **"Nextcloud Sync"** (`settings.nextcloud_sync`).
Visible only when the org is NC-bound (`user.ncOrg.instanceId`) **or** the viewer is a super-admin.
Contains, in order:
1. `OrgNcPairingPanel` — heading **"Pair a new Nextcloud"**, button **"Generate pairing code"**,
   empty state **"No active pairing codes. Generated codes live for 15 minutes and disappear after
   use."**, expander **"How to use this code on the new Nextcloud"** with the `occ
   app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE <CODE>` recipe. Revoke confirm: *"Revoke this
   pairing code? Anyone who has it will no longer be able to use it."*
2. `NextcloudSyncPanel` — heading **"Nextcloud Sync"**, **"Sync now"** button, a four-stat row
   **Instance / Sync mode / Active users / Last sync**, then sections
   **"Sync mode"** (radio: *Mirror everything* — "Every Nextcloud user is automatically created in
   Bee Flow."; *Selective groups*; *Manual only*), **"New user default status"**
   (*Active immediately (recommended)* / *Pending — admin must approve*), **"Groups to mirror"**,
   **"Excluded groups"** ("Members of these NC groups are NEVER mirrored, even under 'mirror
   everything'."), **"Synced users (n)"**, and **Save**.
   Non-NC orgs get: **"Nextcloud sync is only available for organisations bound to a Nextcloud
   instance."**
3. `MeetingNotesAdminPanel`, `GoogleMeetAdminPanel` (adjacent features, same page).

`OrgNcIntegrationsPanel` (shown under *Integration settings*, section 2.1) — heading
**"Nextcloud integrations"**, lead *"Choose which Nextcloud tools your agents may use, and exclude
specific groups. A user keeps a tool as long as at least one of their groups still allows it."*,
sections **"Org-wide"** ("Default for every member of this organisation.") and
**"Per-group exceptions"** ("Disable specific tools for a Nextcloud group. Groups inherit the
org-wide settings unless something is checked below."). Per-group checkboxes read
**"Disable <tool>"**; a tool that is off org-wide is greyed with tooltip *"Enable org-wide first"*.
No synced groups → *"No Nextcloud groups synced yet. Sync runs automatically every 6 hours, or use
'Sync now' in Nextcloud Sync."*

### 2.4 Settings → Organisation → GitHub Sync
`/app/settings/organisation/github-sync`, label **"GitHub Sync"** (`settings.github_sync`).
**The menu row only appears once `GET /api/integrations/github/status` says `connected:true`** —
i.e. after someone connected a GitHub PAT on the personal Connections screen.
States: **"GitHub Not Connected"** ("Connect your GitHub account in Settings → Integrations first,
then return here to configure sync."); **"Set Up Agent Sync"** with **"Configure Repository"**;
the form **"Repository Configuration"** with fields **Repository Owner** (`your-username`),
**Repository Name** (`beeflow-agents`), **Branch** (`main`) and an **"Auto-sync"** toggle
("Automatically push changes when agents are modified"), buttons **"Connect Repository"** /
**"Update Configuration"** / **"Cancel"**; then the dashboard with a **Connected** pill, an
`auto-sync` chip, the counters **Synced / Pending / Errors / Total**, **"Push All to GitHub"**,
**"Push {n} Pending"**, **"Last full sync: …"**, **"Show sync details"** and, when empty,
**"No sync data yet. Push to GitHub to get started."**

### 2.5 Admin dashboard (context, mostly NOT the org admin's)
- **Admin → Integrations** (`admin.tab_integrations`) is **super-admin only**; its sections are
  **Features / Integrations / MCP / Email / Search / Transcription / Services**. This is where MCP
  servers are *installed* ("Add Custom MCP Server", transport stdio/http, tabs **featured** and
  **browse**, search placeholder *"Search thousands of MCP servers…"*).
- **Admin → Access** (`admin.tab_access`) IS reachable by org admins (`perm: ['admin_security',
  'org_admin', 'manage_users']`). Left rail **Grants / Ceiling**. For a non-super-admin the Grants
  matrix is deliberately narrowed to `kinds={['core','beta']}` — *integrations are handled in
  Settings → Organisation → Integrations* — and **Ceiling** is read-only.

---

## 3. Concepts a learner must understand

| Term | Plain-language definition |
|---|---|
| **Capability** | One switchable thing, with an id. Three kinds: `core` (Features), `beta` (Beta features), `integration` (Integrations). An installed MCP server is an integration with id `mcp:<serverId>`; an AI-built custom integration is `custom:<uuid>`. |
| **Ceiling** | The maximum set the subscription plan (cloud) or server licence (self-hosted) allows. Org admins cannot raise it; locked cards show a padlock. |
| **Access menu / `orgAvailable`** | A per-org narrowing of the ceiling that only a *platform* super-admin can set (`PUT /auth/organizations/:orgId/org-availability`). The org admin distributes *within* this, never beyond it. `null` = unrestricted. |
| **Grant** | Handing a capability to **All members** or to a **group**. Grant-only: there is no per-group "disable". Effective = (All-members grants ∪ the user's groups' grants) ∩ access menu. |
| **Inheritance** | Anything granted to All members shows in every group as checked, read-only, labelled "Granted to all members". You cannot un-inherit at group level. |
| **Connection** | One named credential a *person* owns for one provider (`label`, `provider`, `kind`, `isDefault`). Secrets are encrypted with the org key and are never returned by any endpoint. |
| **Lending (grant on a connection)** | Full delegation: the recipient's runs execute with the owner's credential. Target = user / group / whole org, optionally with an expiry. Default for anything shared is bring-your-own — no grant, no delegation. |
| **BYO (bring your own)** | The default: each user connects their own account. `GET /api/integrations/connections/required` tells a screen which providers the viewer still has to connect. |
| **MCP server** | An external tool server the platform spawns (stdio) or calls (HTTP). Defined once per deployment by a super-admin; granted like any integration; each user supplies their own credential. |
| **NC-bound org** | An organisation paired to a Nextcloud instance (`organizations.nc_instance_id`). Unlocks Nextcloud Sync + the NC integrations panel; also hides the Sign-in Method panel, because identity comes from Nextcloud. |
| **Nextcloud "enable wins"** | For the NC family only, a user keeps a tool as long as **at least one** of their groups still allows it. The per-group list is a *disable* list, unlike the grant-only matrix everywhere else. |
| **Degraded** | When the entitlement resolver cannot answer, it marks the snapshot `degraded` and request-path gates return **503** rather than silently running with zero tools. |

---

## 4. End-to-end workflows (click by click)

### W1 — Give the whole organisation an integration
1. Open **Settings** → expand **Organisation** → click **Integrations**.
2. Stay on the **Integration access** tab.
3. In the left rail, leave the scope on **All members**.
4. Find the card (e.g. *Gamma*) in the **Integrations** section. If it is greyed with a padlock,
   it is outside the subscription — stop, the plan must change first.
5. Click the card or its toggle. It turns emerald, the header shows **"Saved"** after ~0.5 s.
6. Tell the user to open **Settings → Connections** and add their own credential for that provider —
   the grant alone does not connect anything.

### W2 — Give an integration to one team only
1. Settings → Organisation → **Integrations** → **Integration access**.
2. In the left rail under **Groups**, pick the group (type in **Search groups…** if there are more
   than six). If the list is empty, create the group first under **Users & Groups**.
3. The right pane header now shows the group name and *"grants stack on top of All members"*.
4. Toggle the integration on. The count badge next to the group name increases.
5. Verify a card is not already showing **"Granted to all members"** — that means everybody has it
   and the group toggle is inert.

### W3 — Connect an org tool that needs credentials (n8n)
1. Settings → Organisation → **Integrations** → **Integration settings** tab.
2. In the **n8n** block, tab **Connection**.
3. Fill **n8n Instance URL** (`https://n8n.yourdomain.com`) and **API Key**.
4. Click **Test Connection**; fix anything the diagnostics list flags.
5. Switch to **Permissions** to decide which groups may run vs. modify workflows.
6. Back on **Integration access**, make sure `n8n` is granted to All members or the relevant group.

### W4 — Lend your credential to a colleague (personal screen)
1. Settings → **Connections**.
2. Under **Connections**, click **Add a connection**, pick the provider, name it
   (e.g. "YouTrack – Support"), fill the fields, **Create connection**.
3. On the new row click the **share** icon.
4. Either type the colleague's address in **teammate@company.com**, choose an **Expiry**
   (No expiry / 7 / 30 / 90 days) and click **Lend to teammate**, or click
   **Lend to everyone in my organization**.
5. The row now shows **"{count} shared"**; each share can be revoked from the same panel.

### W5 — Mirror agents to GitHub
1. Settings → **Connections** → **Developer** → **GitHub**: paste a PAT with `repo` scope, Save.
2. Reload settings. **Organisation → GitHub Sync** now appears in the menu.
3. Click **Configure Repository**, fill **Repository Owner**, **Repository Name**, **Branch**,
   optionally switch **Auto-sync** on.
4. **Connect Repository**.
5. Click **Push All to GitHub**; watch **Synced / Pending / Errors / Total** and
   **Show sync details**.

### W6 — Decide which Nextcloud tools agents may use
1. Settings → Organisation → **Integrations** → **Integration settings**.
2. In **Nextcloud integrations → Org-wide**, tick only the NC apps agents may touch, click **Save**.
3. Scroll to **Per-group exceptions**, expand a synced NC group, tick **"Disable <tool>"** for that
   group. (Saves immediately, optimistic; it reverts on failure.)
4. If the group list is empty, go to **Organisation → Nextcloud Sync** and press **Sync now**
   (or wait for the 6-hourly run).

---

## 5. Defaults, limits and numbers

- Integration catalogue: **35 non-Nextcloud** entries + **14 Nextcloud** entries = **49** ids
  (`server/core/entitlements/capabilityRegistry.js` + `ncIntegrationCatalog.js`, mirrored in
  `agent-hub/src/config/integrationCatalog.js`).
- **19** integrations are on by default at user level (`AUTO_ON_INTEGRATIONS`: agent-search,
  browser-fetch, image-gen, music-gen, video-gen, elevenlabs, maps, linkedin, github,
  google-contacts, google-keep, outlook, outlook-readonly, ms-calendar, onedrive, ms-contacts,
  google-groups, n8n, webpages). Everything else defaults to **off**.
- Nextcloud capabilities are `userFacing:false, groupTogglable:false` in the matrix and are
  *granted to everyone* by a resolver bypass — they are governed solely by the NC panel.
- Access-matrix toggle save debounce **450 ms**; status message lifetime **3 500 ms**; group search
  box appears above **6** groups; group list max height 460 px.
- Entitlement snapshot cache **30 000 ms** (`ENTITLEMENT_CACHE_TTL_MS`); custom-integration
  projection cache **15 s**; single-org detection cache **60 s**.
- Connections API rate limits per user: **30 writes / 60 s**, **10 shares / 60 s**.
- Lending expiry choices: none, **7**, **30**, **90** days.
- Connection `kind` whitelist: `oauth, api_key, basic, mcp, bearer, oauth2_cc`.
  Grant resource types: `agent, webpage, skill, routine, studio_app`.
- MCP: per-user process pool with a **5-minute** idle timeout; live registry search cached
  **5 min**, max **200** entries, verified-only by default.
- NC pairing code: **8 characters**, TTL **15 minutes**, one-shot.
- NC group sync runs automatically every **6 hours**; sync modes `mirror_all` (default),
  `selective_groups`, `manual`; new-user status `active` (default) or `pending`.
- Custom-integration builder: name ≤ **200** chars, description ≤ **2 000**, credential value
  ≤ **4 096**, tool name `^[a-z][a-z0-9_]{2,40}$`.

---

## 6. What happens on failure

- **Matrix cannot load** → `Failed to load (<status>)` in the header; the panel stays empty.
  Not bound to an org at all → *"Your account is not bound to an organisation, so there is nothing
  to manage here."*
- **A toggle fails to save** → `Save failed`, and the component **re-reads the server state**, so
  the switch snaps back. Nothing is left optimistically wrong.
- **Server-side clamping is silent.** `writeOrgAccessGrants` drops any id that is not
  `groupTogglable` or not inside `orgAvailable`; `PUT /auth/groups/:id/access` does the same. The
  UI gets `200` with the cleaned list — an admin who POSTs an id outside the menu sees it simply
  not appear.
- **Beta on cloud** → `PUT /auth/organizations/:orgId/beta-features` answers **409
  `governed_by_subscription`** with *"Beta access is set by the organization's subscription plan on
  this deployment."* The matrix marks beta rows read-only ("Beta features follow your subscription").
- **Connections list fails** → the red line + **"Try again"**, *never* the empty state (a failed
  list used to read as "your credentials are gone").
- **Deleting a shared connection** → a second confirm, then shares are revoked with it.
- **Entitlement resolution degraded** → `requireCapability` returns **503**; background callers must
  skip, never run tool-less.
- **Nextcloud unreachable** → `GET …/nc-sync/groups` answers **502** *"Could not reach Nextcloud: …"*.
- **Org not NC-bound** but an NC URL is called → **400** *"Organization is not bound to a Nextcloud
  instance"*. Missing org → **404**.
- **Suspended org** → `requireActiveOrgForMutations()` lets reads through and blocks writes on the
  whole connections router.
- **Custom-integration API while the dark-ship flag is off** → **404 `not_found`** (fails closed).
- **MCP routes on Community** → **403 `feature_locked`** from `requireFeature('mcp_marketplace')`.

---

## 7. Permission and licence gates

**Frontend**
- `canSeeOrg = permissions ∋ 'all' | 'org_admin' || orgRole ∈ {admin, org_admin}` — gates the whole
  Organisation accordion and the Integrations / GitHub Sync / Nextcloud Sync panels
  (`AdvancedSettings.jsx`).
- `useCan(capability)` / `<Gate capability=…>` / `RequireTier` (`components/licensing/Gate.jsx`) —
  display-only; the server is always the real gate.
- `usePermissionCheck(user, ['admin_compliance'])` is used for the sibling Compliance row, not here.
- Menu-visibility extras: `org_nextcloud_sync` needs `isNcOrg || isSuperAdmin`; `org_github_sync`
  needs `statuses.githubConnected`; `org_azure` only on self-hosted.

**Backend**
- `requireOrgAdminLike(req,res)` (in-handler) — super-admin, or `permissions ∋ 'all' | 'org_admin'`;
  used by `/auth/me/group-access`, `/auth/me/org-access`, `/auth/me/active-features`.
- `requireOrgAdmin('orgId')` (`auth/permissions.js`) — super-admin, or an org-admin *role* who
  belongs to that org directly **or** through a group. Used by the `/auth/organizations/:orgId/*`
  and `/auth/admin/:orgId/nc-integrations*` routes.
- `ncSync.js` re-implements its own `checkOrgAdmin` via `isOrgAdminForOrg` and **does not honour
  group-transitive org membership** — a documented divergence.
- `requirePermission('manage_agents')` guards **every** GitHub-sync route. Note the mismatch:
  `agent_admin` and `agent_editor` carry `manage_agents` in `server/config/orgRoles.json`, so they
  pass the API but never see the menu row (which needs `org_admin`).
- `requireSuperAdmin` guards MCP **write** routes (`POST/PUT/DELETE /ai/mcp-servers…`, `/test`,
  `/:id/refresh`) — defining an MCP server is "run this program on the server", so it is
  instance-wide.
- `requireFeature('mcp_marketplace')` (aliased `requireLicenseFeature` in `index.js`) gates *all*
  `/ai/mcp-servers*` and `/ai/mcp-registry/*` routes — **Enterprise** only.
- `requireCapability('ai_integration_builder')` + `customIntegrationsFeatureGate` double-gate
  `/api/organizations/:orgId/custom-integrations`.
- `'integrations'` is a **Community**-tier feature (`server/license/tiers.js`) — the built-in
  integrations are free; the MCP marketplace is the Enterprise add-on.
- Org roles that matter (`server/config/orgRoles.json`): `org_admin` (has `org_admin`,
  `manage_users`, `manage_agents`, `admin_security`, …), `dpo`, `isms_auditor`, `agent_admin`,
  `agent_editor`, `member`.

---

## 8. How it connects to other features

- **Agents / Skills / Studio apps / Routines** read the resolved integration set at tool-build time
  (`server/core/integrations/integrationTools.js`); per-agent `enabledIntegrations` and the per-user
  `enabled_apps` selection are a *further* narrowing applied after entitlements.
- **Routines → `http_request` step** picks a named HTTP connection from Settings → Connections —
  that is why the "HTTP API (custom)" provider exists there.
- **Usage & Monitoring → "Integration Activity Monitor"** (`usage.integ_*`,
  `/api/usage/integration-*`) reports tool calls, server endpoints, bytes and PII-in-transit.
  Its banner when off: *"Integration monitoring is disabled. Enable it in Privacy Shield settings."*
- **Privacy Shield** decides whether integration payloads are content-scanned for personal data.
- **Organisation → Information → integration cache** (`OrgIntegrationCacheEditor`,
  `org_integration_cache_<orgId>`) decides whether third-party answers may be stored between runs;
  off by default, and switching it off purges what is stored.
- **Users & Groups** is where the groups used by the access matrix are created.
- **Admin → Access → Ceiling** shows the plan/licence ceiling; **Admin → Integrations** is where
  super-admins install MCP servers that then show up as grantable integrations.
- **Meeting Notes / Google Meet / Summary templates** admin panels share the Nextcloud Sync page.

---

## 9. Common mistakes

1. **Granting ≠ connecting.** The matrix hands out the *right* to use a tool; each user still has to
   store a credential in Settings → Connections (or be lent one).
2. **Looking for a locked integration.** With `hideLocked`, integrations outside the subscription
   are *not shown at all* on the org page — admins conclude "it does not exist" instead of "my plan
   does not include it". The un-hidden padlocked view lives on Admin → Access.
3. **Trying to un-grant one group.** The matrix is grant-only. A card already granted to *All
   members* is read-only inside a group. To restrict, remove the All-members grant and grant the
   groups that should keep it.
4. **Expecting the GitHub Sync menu row before connecting GitHub.** The row is hidden until
   `/api/integrations/github/status` reports `connected:true`, and the PAT is *personal*.
5. **Confusing the two Nextcloud surfaces.** *Nextcloud Sync* = which **people** come across;
   *Nextcloud integrations* (inside Integration settings) = which **apps** agents may use. And the
   NC per-group list is a *disable* list with "enable wins" semantics — the opposite of the matrix.
6. **Assuming the org admin can install an MCP server.** Installing is super-admin + Enterprise;
   the org admin only grants an already-installed server and each user pastes their own credential.
7. **Lending casually.** A lent connection is *full delegation* — the recipient's runs act as the
   owner. For HTTP credentials that means any URL. Default to BYO; set an expiry when lending.
8. **Editing beta toggles on cloud.** They are plan-governed and the write 409s.
9. **Expecting phone access.** Connections and the whole Organisation group are hidden on phones
   (only Compliance is let through).
10. **Believing stale comments.** `ncIntegrations.js` says "the 11 Nextcloud tools"; the catalogue
    has **14**. Count from `ncIntegrationCatalog.js`, not the prose.
11. **Deleting a connection that a routine uses** — the confirm says it plainly:
    *"Any automation using it will stop working."*

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

**A — Procurement (Inkoop).** Van Dijk's inkoopteam wants an agent that reads supplier mail,
files the PDF in Nextcloud and opens a YouTrack issue for disputed invoices.
Steps: Settings → Organisation → Integrations → *Integration access* → scope **Inkoop** → grant
`Gmail`, `Nextcloud`, `YouTrack`. Then *Integration settings* → **Nextcloud integrations** →
Org-wide: tick Files & WebDAV, Tables; untick Talk. Buyer Pieter opens Settings → Connections,
adds **"YouTrack – Inkoop"** and lends it to the team with a **90 days** expiry so nobody needs
their own token during the pilot. Teaching point: the YouTrack ticket may carry only a reference —
no supplier contact names (house rule: personal data leaves Bee Flow only by e-mail).

**B — HR.** HR wants payroll answers from NMBRS and leave planning from vPlan, but nobody outside
HR may touch them. Steps: grant `NMBRS` and `vPlan` to the **HR** group *only* — never to All
members, because an All-members grant is inherited and cannot be taken back per group. HR manager
Anouk adds both connections personally (Subdomain `vandijkgroep`, API token, Environment
*Production*) and does **not** lend them. Teaching point: check that `Withings` (Health) is not
granted anywhere — special-category data gets its own group in the UI for a reason.

**C — Sales.** Sales wants LinkedIn posting, Gamma decks and a shared agent that mails offers from
the central `verkoop@` mailbox. Steps: grant `LinkedIn` and `Gamma` to **Sales**; the sales lead
creates **"Gamma – Verkoop"** and uses **Lend to everyone in my organization** so every rep can
generate a deck without a licence each. Then Organisation → **GitHub Sync**: the sales agent's
prompt is version-controlled in `vandijkgroep/beeflow-agents`, branch `main`, **Auto-sync** on, so
every prompt tweak is a commit. Teaching point: the GitHub PAT is *personal* — if that admin leaves,
sync stops; document who owns it.

---

## 11. List/read endpoints a "did the learner do it?" check can call

All are real routes read from `server/`; every one needs the session cookie (`authFetch`).

| Method + path | Auth | JSON row / payload |
|---|---|---|
| `GET /auth/me/group-access` | `requireAuth` + `requireOrgAdminLike` | `{orgId, mode, capabilities:[{id,kind,name,description,category,lifecycle}], ceiling:[id], everyone:[id], groups:[{id,name,granted:[id]}], betaGoverned}` — **`everyone` is the org-wide grant list; `groups[].granted` the per-group one.** No owner field (org-scoped). |
| `GET /auth/organizations/:orgId/group-access` | `requireOrgAdmin('orgId')` | Same shape, for one named org. |
| `GET /auth/my-entitlements` | `requireAuth` (self-scoped) | `{mode,tier,superAdmin,degraded,ceiling,orgAvailable,orgEnabled,groupEffective,effective,reasons,limits,registry:[…]}` — each of ceiling/effective is `{core:[],beta:[],integration:[]}`. Best check for "can *this* user use integration X". |
| `GET /auth/me/active-features` | `requireAuth` + `requireOrgAdminLike` | `{orgId, allowedBetaFeatures, enabledBetaFeatures, allowedIntegrations, enabledIntegrations, customIntegrations:[{id,name,description,category}], betaRegistry, betaGoverned}` |
| `GET /auth/organizations/:orgId/org-availability` | `requireOrgAdmin('orgId')` **+ super-admin assert** | `{orgId,mode,capabilities,ceiling,available,unrestricted}` |
| `GET /api/integrations/connections` (`?provider=`, `?includeShared=1`) | `requireAuth` | `{connections:[{id, **ownerUserId**, orgId, provider, label, kind, status, isDefault, secretMeta, lastUsedAt, lastError, createdAt, updatedAt}]}` — secrets never returned; with `includeShared=1` each row also carries `access:'own'|'lent'`. |
| `GET /api/integrations/connections/grants?mine=outgoing\|incoming` | `requireAuth` | `{grants:[{id, connection_id, org_id, **grantor_user_id**, grantee_type, grantee_id, grantee_label, resource_type, resource_id, policy, expires_at, revoked_at, created_at, provider, connection_label, **owner_user_id**}]}` |
| `GET /api/integrations/connections/required?providers=a,b` | `requireAuth` | `{requiresConnection:[{provider}], lent:[{provider,connectionLabel}]}` — exactly the "has the learner connected it?" question. |
| `GET /api/integrations/github/status` | session check in handler (401 otherwise) | `{connected, username}` |
| `GET /api/integrations/github-sync/status` | `requirePermission('manage_agents')` | `{configured, githubConnected, config:{repoOwner,repoName,branch,autoSync,lastFullSync,…}, overview:{synced,pending,error,total}}` |
| `GET /api/integrations/github-sync/details` | `requirePermission('manage_agents')` | array of sync states: `{id, resource_type, resource_id, last_synced_at, …}` |
| `GET /auth/admin/:orgId/nc-sync` | `requireAuth` + org-admin (local `checkOrgAdmin`) | `{organizationId, ncInstanceId, ncBaseUrl, mode, syncGroups, excludedGroups, newUserDefaultStatus, lastSyncAt}` |
| `GET /auth/admin/:orgId/nc-sync/groups` | as above | `{groups:[name]}` (502 if NC unreachable) |
| `GET /auth/admin/:orgId/nc-sync/users` | as above | `{users:[{id,email,displayName,ncUid,status,autoProvisioned}]}` |
| `GET /auth/admin/:orgId/nc-integrations` | `requireAuth` + `requireOrgAdmin('orgId')` + NC-bound | `{organizationId, ncCatalog:[{id,name,description}], enabled:[id], usingDefaults, legacyEnabled}` |
| `GET /auth/admin/:orgId/nc-integrations/groups` | as above | `{groups:[{id,name,disabledIntegrations:[id],userCount}]}` |
| `GET /auth/admin/nc-bindings/pairing-codes` | `requireAuth` + org-admin | `{codes:[{id,code,expiresAt,createdAt}]}` |
| `GET /ai/mcp-servers` | `requireAuth` + `requireFeature('mcp_marketplace')` | `{servers:[{id,name,command,args,required_credentials,tools_cache,enabled,status,error,transport,url,category,description,icon,source,created_at,updated_at}]}` |
| `GET /ai/mcp-servers/user-credentials` | `requireAuth` + `requireFeature('mcp_marketplace')` | `{servers:[{id,name,description,icon,toolCount,credentials:[{key,label,description,configured}],allConfigured}]}` — per-**caller** state, ideal for "did the learner store their MCP key?" |
| `GET /ai/n8n/config` | `requireAuth` | org n8n connection state |
| `GET /ai/n8n/diagnostics` | `requireAuth` | checklist rows incl. *"n8n is enabled in the organisation's integration set"*, *"Your account can use n8n (read/run tools)"* |
| `GET /api/organizations/:orgId/custom-integrations` | `requireAuth` + `requireOrgAdmin('orgId')` + `requireCapability('ai_integration_builder')` + dark-ship flag | `{integrations:[{id,orgId,name,slug,kind,status,…}]}` (404 while the flag is off) |

**Write endpoints** (for completeness, not for verification):
`PUT /auth/me/org-access {granted:[id]}`, `PUT /auth/groups/:id/access {granted:[id]}`,
`PUT /auth/organizations/:orgId/org-access`, `PUT /auth/organizations/:orgId/org-availability`,
`POST|PATCH|DELETE /api/integrations/connections[/:id]`, `POST /api/integrations/connections/:id/grants`,
`DELETE /api/integrations/connections/grants/:grantId`,
`POST /api/integrations/github/connect`, `POST /api/integrations/github-sync/configure|push|push-pending`,
`PUT /auth/admin/:orgId/nc-sync`, `POST /auth/admin/:orgId/nc-sync/run`,
`PUT /auth/admin/:orgId/nc-integrations[/groups/:groupId]`,
`POST /ai/mcp-servers/user-credentials`.

---

## 12. Key source files

- `agent-hub/src/pages/AdvancedSettings.jsx` — settings shell, org sub-item list + visibility rules
- `agent-hub/src/authedApp/settingsRoutes.js` — the `/app/settings/**` URL table
- `agent-hub/src/pages/settings/OrganisationSection.jsx` — the org Integrations page itself
- `agent-hub/src/components/admin/org/GroupAccessMatrix.jsx` — the access matrix
- `agent-hub/src/pages/settings/IntegrationsSection.jsx` + `ConnectionsManager.jsx` — personal Connections
- `agent-hub/src/components/integrations/{github/GitHubSyncPanel,nextcloud/*}.jsx`
- `agent-hub/src/config/integrationCatalog.js` — the 49-entry client catalogue
- `server/auth/admin/featureAccessRoutes.js` — group-access / org-access / org-availability
- `server/core/entitlements/{entitlements,capabilityRegistry}.js` — the ladder and the catalogue
- `server/routes/integrations/connections.js` + `server/stores/integrationConnectionStore.js`
- `server/routes/admin/{ncSync,ncIntegrations}.js`, `server/auth/ncBindingRoutes.js`
- `server/routes/ai/config/integrations.js` — n8n + MCP server management
- `server/core/mcpManager.js`, `server/stores/mcpStore.js`
- `server/config/orgRoles.json`, `server/license/tiers.js`
