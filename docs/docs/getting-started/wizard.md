---
title: First-run wizard
---

# First-run wizard

The first time an organisation admin opens Bee Flow, a 4-step onboarding wizard runs. It saves the org's first sane defaults so other users land on a working chat instead of an empty config screen.

If you reach a step that doesn't match what you see in the UI, your version is newer than this page — the field meanings still apply.

:::note[Self-hosters: the wizard is a separate container]

In self-hosted installs the wizard is a tiny Node service ([`install-wizard/`](https://github.com/Bee-Flow/beeflow/tree/main/install-wizard)) with its own Dockerfile. `install.sh` / `install-local.py` / `install-local.ps1` spin it up alongside the main server for first-time setup, then shut it down once the org is bootstrapped. You don't need to keep it running.

:::

## Step 1 — User sync mode

Choose which Nextcloud users get a Bee Flow account.

| Mode | Behaviour | When to pick |
|------|-----------|--------------|
| **All users** | Every NC user is mirrored as a Bee Flow user immediately, and stays in sync as users are added/removed. | Smaller teams; you want everyone in scope by default. |
| **Specific groups** | Only members of selected groups (e.g. `bee-flow-users`, `staff`) get an account. | Larger orgs; you want to opt-in groups gradually. |
| **Manual** | No NC users are auto-mirrored. Admin invites users by hand. | Pilot installs; tightly controlled rollouts. |

The mode controls **initial sync** + ongoing **webhook-triggered sync** from Nextcloud user/group events. You can change it later under **Settings → Organisation → User sync**.

What "sync" really does:

- Creates a Bee Flow user record keyed by NC user ID
- Mirrors `email`, `displayName`, and `groups`
- Sets `lastNcSync` timestamps on the user record
- A 6-hourly **backstop job** re-runs sync to catch any missed webhook events

![Step 1: user sync](../img/screenshots/getting-started/wizard/step-1-user-sync/)

## Step 2 — Default integrations

Pick which Nextcloud integrations are enabled for new users **by default**. The 11 NC integrations are:

| ID | Integration | What it lets the assistant do |
|----|-------------|--------------------------------|
| `nextcloud` | Files & WebDAV | List, search, read, upload, share files |
| `nextcloud-mail` | Mail | Read, draft, send mail via Nextcloud Mail |
| `nextcloud-calendar` | Calendar | List, search, create, update, delete events |
| `nextcloud-contacts` | Contacts | List, search contacts |
| `nextcloud-deck` | Deck | Boards, stacks, cards, labels, comments |
| `nextcloud-talk` | Talk | List rooms, post messages, react |
| `nextcloud-notes` | Notes | Plain-text / Markdown notes |
| `nextcloud-tasks` | Tasks | VTODO via CalDAV |
| `nextcloud-activity` | Activity | Read-only feed of recent file changes, shares, mentions |
| `nextcloud-notifications` | Notifications | List & dismiss NC notifications |
| `nextcloud-status` | User Status | Get / set the user's availability and custom message |

Per-group overrides are configurable later in **Admin → Nextcloud integrations**: any group can **disable** integrations for its members. The rule is **"enable wins"** — a user gets access if **any** of their groups still allows it. [Read more](../admin/nc-integrations.md).

![Step 2: integrations](../img/screenshots/getting-started/wizard/step-2-integrations/)

## Step 3 — Privacy shield

The Privacy Shield scans every prompt for sensitive data and replaces matches with placeholders before anything reaches the language model. Original values are restored only on your screen.

| Level | Detected categories |
|-------|---------------------|
| **Off** | None — prompts go to the model untouched. |
| **Standard** (default) | Email, phone number, IBAN, BSN (NL), credit card number, IP address, URL with credentials. |
| **Strict** | Standard, plus: person names, dates of birth, postal addresses, organisation names, passport / driver's licence numbers, SSN, BIC/SWIFT, bank account, Azure storage / CosmosDB keys. |
| **Custom** | Define your own regex categories. Useful for project codenames, internal classification labels. |

The detection backend is configurable independently of the level (Azure AI Text Analytics, or a local CPU model). See [Privacy Shield](../features/privacy-shield.md) for the full category list and the underlying mechanism.

![Step 3: privacy](../img/screenshots/getting-started/wizard/step-3-privacy/)

## Step 4 — License key (optional)

Stay on the free **Community** tier or paste a JWT licence key from [https://beeflow.nl/pricing](https://beeflow.nl/pricing) to unlock automations, multi-user, voice, compliance hub and other premium features.

The server verifies the JWT signature against a bundled public key (`license/bundled-public-key.pem`). If valid, the active tier updates immediately — no restart needed. Premium navigation entries appear, and gated endpoints become reachable.

You can paste, rotate, or remove a key any time later under **Settings → Organisation → License & usage**. See [Applying a licence key](../licensing/apply.md).

![Step 4: license](../img/screenshots/getting-started/wizard/step-4-license/)

## After the wizard

The wizard closes and Bee Flow opens with:

- A pre-seeded **Assistant** agent wired to all enabled integrations
- The 10 system **starter agents** (Title Generator, Memory Extractor, Component Designer, etc.) available org-wide
- An empty **Knowledge Bases** list
- An empty **Automations** list (Pro+ only)

Other users in the chosen sync scope log in with their NC account and land directly on chat — the wizard never runs for non-admins.

You can re-run individual sections later from **Settings → Organisation**. The wizard will not re-prompt unless you fully reset the org from the **Danger zone**.
