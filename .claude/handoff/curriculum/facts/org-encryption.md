# Fact sheet — Organisation Encryption (Settings → Organisation → Encryption)

Audience: **organisation admin**. Status: **the feature exists and is fully wired** (backend policy,
escrow, three tiers, per-surface scope, admin route, UI picker, audit trail, backfill script).
Verified against the working tree on branch `claude/builder-redesign-fase-1-6sun0h`, 2026-09-14.

Primary sources read:
- `agent-hub/src/components/admin/security/encryption/OrgEncryptionEditor.jsx` (the screen)
- `agent-hub/src/components/admin/org/OrgInfoPanel.jsx` + `.../org/orgInfo/orgInfoShared.jsx` (nav)
- `agent-hub/src/authedApp/settingsRoutes.js` (URL), `agent-hub/src/i18n/en-defaults.js` (labels)
- `agent-hub/src/pages/EncryptionSetup.jsx`, `agent-hub/src/lib/opaque.js`, `agent-hub/src/pages/LoginPage.jsx`
- `server/auth/admin/orgRoutes.js` (routes), `server/auth/accessRegistry.js` (authz contract)
- `server/stores/encryptionPolicy.js`, `encryptionAvailability.js`, `initialTier.js`, `stores/lib/fieldEnvelope.js`
- `server/auth/encryption.js`, `orgEscrow.js`, `transcriptEscrow.js`, `projectEscrow.js`, `opaqueRoutes.js`,
  `login/ssoEncryptionRoutes.js`, `login/currentUserRoutes.js`, `login/finalizeLogin.js`, `sessionCache.js`
- `server/stores/agent/messageCrypto.js`, `server/stores/transcriptCrypto.js`, `server/stores/piiVaultStore.js`
- `server/license/tiers.js`, `server/config/orgRoles.json`, `server/scripts/backfill-encryption.js`,
  `scripts/rotate-master-key.js`, `server/routes/compliance/accessAudit.js`

---

## 1. What the feature is for

Bee Flow stores conversations, attachments, meeting transcripts and the Privacy-Shield token map in
Postgres. **Content encryption** decides whether those columns are written as readable text or as
AES-256-GCM envelopes, and — crucially — *who holds the key*. The organisation admin makes that choice
once, on one screen, by picking one of three **tiers**: `Off`, `Managed`, `Zero-knowledge`.

The design rule that makes this screen safe to use (from `encryptionPolicy.js`):

> **Writes consult the policy. Reads never do — they detect the on-disk format of the value in front
> of them.**

Consequences a learner must internalise:
- Turning encryption **on** leaves every existing plaintext row readable. Only *new* writes are ciphertext.
- Turning encryption **off** leaves every existing ciphertext row readable. Key material is untouched.
- Nothing is re-encrypted by flipping the switch. History is protected only by running the backfill script.

The intro line on the screen says exactly this:
> "Choose how your organisation's conversation content is stored. This affects new messages; existing
> messages are left exactly as they are and stay readable either way."

---

## 2. Where it lives — navigation and real labels

### 2.1 Getting there
- URL: **`/app/settings/organisation/encryption`** (`SETTINGS_ORG_ID_TO_URL.encryption = 'encryption'`
  in `agent-hub/src/authedApp/settingsRoutes.js`).
- Click path: **Settings** → left nav **Organisation** (accordion) → **Encryption**.
- The Organisation accordion is hidden on phones (`MOBILE_VISIBLE_TOP_TABS`); this is a desktop screen.
- The Organisation accordion only renders when the user has `all`, `org_admin`, or `orgRole` of
  `admin` / `org_admin` (`canSeeOrg` in `agent-hub/src/pages/AdvancedSettings.jsx:220`).

### 2.2 The Organisation sub-menu, in order (real labels, `orgInfoShared.jsx` + `en-defaults.js`)
| Nav label | id | i18n key |
|---|---|---|
| License & Usage | `license` | `settings.license_usage` |
| Sign-in Method | `auth` | `settings.signin_method` |
| Privacy Shield | `privacy` | `settings.privacy_shield` |
| **Encryption** | `encryption` | `settings.encryption` |
| Conversation Memory | `ai_context` | `settings.ai_context` |
| Answer Reuse | `integration_cache` | `settings.integration_cache` |
| Organisation Info | `info` | `settings.org_info` |
| Usage & Monitoring | `org_usage` | `settings.usage_monitoring` |
| Compliance | `org_compliance` | `settings.compliance` |
| Users & Groups | `org_users` | `settings.users_groups` |
| Academy, Integrations, GitHub Sync, Nextcloud Sync, Meeting Templates | … | … |

Icon for Encryption: lucide `Lock`, colour `#8b5cf6` (purple).

### 2.3 Screen: **Encryption** (`OrgEncryptionEditor.jsx`)
Layout: header, optional entitlement banner, a vertical radio-card picker (one column), optional
advisory banner, optional red warning, then a save bar. Max width `3xl`.

Exact strings:

| Element | Text (English default) | i18n key |
|---|---|---|
| Heading (with Lock icon) | **Encryption** | `admin.encryption.title` |
| Intro paragraph | "Choose how your organisation's conversation content is stored. This affects new messages; existing messages are left exactly as they are and stay readable either way." | `admin.encryption.intro` |
| Radiogroup aria-label | "Encryption level" | `admin.encryption.choose_tier` |
| Card 1 title (icon `ShieldOff`) | **Off** | `admin.encryption.tier_none` |
| Card 1 description | "Messages are stored without content encryption." | `admin.encryption.tier_none_desc` |
| Card 2 title (icon `ShieldCheck`) | **Managed** | `admin.encryption.tier_managed` |
| Card 2 description | "Encrypted at rest. Your administrators can reset a password without the user losing their data." | `admin.encryption.tier_managed_desc` |
| Card 3 title (icon `KeyRound`) | **Zero-knowledge** | `admin.encryption.tier_zk` |
| Card 3 description | "Encrypted with each user's own secret. Nobody — not your administrators, not Bee Flow support — can recover a user's data if they lose their password and recovery key." | `admin.encryption.tier_zk_desc` |
| Badge on a plan-locked card | **Enterprise** | `license.enterprise` |
| Link after a plan-locked reason | **Upgrade at beeflow.nl** → `https://beeflow.nl/pricing` | `license.upgrade_at_beeflow` |
| Not-entitled banner (amber, above the cards) | "Encryption is not included in your current plan. You can still turn it off, but not on." | `admin.encryption.not_entitled` |
| Red warning, shown only when the selection is changed to Zero-knowledge | "Saving this will sign out everyone in the organisation, including you. Each person must sign in again so their encryption key can be created. Data can no longer be recovered by an administrator." | `admin.encryption.warn_zk_signout` |
| Primary button | **Save** (**Saving…** while in flight) | `common.save` / `common.saving` |
| Secondary link (only when dirty) | **Cancel** | `common.cancel` |
| Loading state | "Loading…" | `common.loading` |
| Load failure (red box, AlertTriangle) | "Could not load encryption settings." + the error text | `admin.encryption.load_failed` |
| Save success toast | "Encryption settings saved" | `admin.encryption.saved` |
| Save failure toast | "Could not save encryption settings" | `admin.encryption.save_failed` |
| Toast after a switch into zk | "Everyone in this organisation has been signed out. Each person must sign in again so their encryption key can be created." | `admin.encryption.sessions_busted` |

Server-authored strings that appear verbatim under a **locked** card (`encryptionAvailability.js`):
- Billing block: *"Encryption is not included in your current plan. Contact your administrator or upgrade to enable it."*
- Readiness block (Managed, no master key): *"This server has no encryption master key configured, so keys cannot be created. Ask your administrator to set MASTER_ENCRYPTION_KEY and restart."*
- Advisory under Zero-knowledge (amber, NOT a blocker): *"OPAQUE is not configured on this server, so any OPAQUE-based enrolment will stop working after a restart. Password-based zero-knowledge encryption is unaffected."*

**Locked cards are still rendered**, greyed out, with the reason underneath — deliberately, so an admin
can tell "this product has no such option" apart from "your plan does not include it".

**There is no per-surface UI.** `scope` is a super-admin-only API field and the component omits it on
purpose: "offering the control here would mean a save that 403s."

Accessibility: `ChoiceCards.tsx` renders a real `role="radiogroup"` with `aria-checked`, one tab stop,
arrow-key navigation that wraps.

### 2.4 Screen: **Set Up Data Encryption / Unlock Your Data** (`EncryptionSetup.jsx`)
A full-screen gate that replaces the app for **SSO users** when `/auth/user` returns
`needsEncryptionSetup` or `needsEncryptionPin`. Four states:

| State | Title | Body / fields |
|---|---|---|
| setup | **Set Up Data Encryption** | "Choose an encryption PIN to protect your data. This is separate from your SSO login." Fields: **Choose Encryption PIN** (placeholder "Minimum 6 characters"), **Confirm PIN** (placeholder "Confirm your PIN"). Button **Set Up Encryption**. Footer: "Your PIN encrypts your data locally. The server cannot read your encrypted data without it." |
| unlock | **Unlock Your Data** | "Enter your encryption PIN to access your encrypted data." Field **Encryption PIN** (placeholder "Enter your PIN"). Button **Unlock**. Link **Forgot your PIN? Use recovery key** |
| recovery-key display | **Save Your Recovery Key** | "This is the only way to recover your encrypted data if you forget your PIN. Save it somewhere safe — it won't be shown again." Amber warning: "If you lose this key and forget your PIN, your encrypted data will be permanently inaccessible." Buttons **Copy to clipboard** (→ **Copied!**) and **I've saved my recovery key — Continue** |
| recover | **Recover Your Account** | "Enter your recovery key and choose a new PIN to regain access to your encrypted data." Fields **Recovery Key** (textarea, placeholder "Paste your recovery key here"), **New PIN** ("Minimum 6 characters"), **Confirm New PIN**. Buttons **Recover & Set New PIN** (→ **Recovering…**), **Back to PIN entry** |

Inline errors (hard-coded English in the component, not i18n): "PIN must be at least 6 characters",
"PINs do not match", "Please enter your encryption PIN", "Please enter your recovery key",
"New PIN must be at least 6 characters", "Incorrect PIN", "Setup failed", "Recovery failed",
"Connection error".

### 2.5 Screen: recovery-key modal on the **login page** (`LoginPage.jsx`, password accounts)
Shown once, right after a password login that *created or migrated* a DEK. Title **Save Your Recovery
Key**, body "This is the only way to recover encrypted data if you lose your password. Store it
securely.", the key in a dashed monospace box, buttons **📋 Copy** and **I've Saved It**.

---

## 3. Concepts the learner must understand

- **DEK — Data Encryption Key.** A random 32-byte key *per user*. It is what actually encrypts message
  content. It is never stored in the clear.
- **KEK — Key Encryption Key.** A key derived from a secret (password, PIN or recovery key) with
  Argon2id, used only to *wrap* (encrypt) the DEK. Wrapping is what makes a password change cheap:
  re-wrap one 32-byte key instead of re-encrypting a year of chat.
- **Envelope encryption.** The two-layer scheme above: content ← DEK ← KEK. Every encrypted column is
  a JSON envelope `{ "_bfenc":1, "alg":"A256GCM", "iv":<hex>, "tag":<hex>, "ct":<hex> }`.
- **Argon2id.** A memory-hard password-hashing function. Resistant to GPU/ASIC cracking because it
  needs a lot of RAM per guess. Used here to turn a password/PIN into a KEK.
- **OPAQUE (RFC 9807).** A password-authenticated key exchange: the client proves it knows the password
  **without the password ever reaching the server**, and both sides derive an `exportKey`. Bee Flow
  derives the KEK from that exportKey in the browser (HKDF-SHA256), so on this path the server never
  sees the secret at all. It is a *stronger login path*, used when the account's `kdfMode` is
  `opaque_v1`; the fallback path is `legacy_argon2`.
- **Zero-knowledge.** The server cannot read the data because it does not hold, and cannot derive, the
  key. That is the `zk` tier — with two documented, deliberate exceptions (§6).
- **Escrow / Org Root Key (ORK).** A second wrapping of each user's DEK under a per-organisation random
  key that the server *can* reach. It is what makes "an admin can reset a password without data loss"
  and "a 3am automation can read your chat" possible. That is the `managed` tier.
- **Recovery key.** A one-time 32-byte key shown to the user once, formatted as 8 groups of 8 uppercase
  hex characters (`A1B2C3D4-…`, 64 hex chars total). It wraps the DEK *independently* of the password,
  so it is the only rescue path when the password/PIN is lost.
- **Surface.** One encryptable place in the database (message bodies, attachment sidecars, the PII token
  map, conversation titles, notebook chat, transcripts). Each can in principle be toggled separately.
- **Entitlement vs readiness.** Two different reasons a tier can be unavailable: *entitlement* is a
  billing answer (upgrade fixes it); *readiness* is a configuration answer (an upgrade would not help —
  the server is missing `MASTER_ENCRYPTION_KEY`).

---

## 4. The three tiers, precisely

| | **Off** (`none`) | **Managed** (`managed`) | **Zero-knowledge** (`zk`) |
|---|---|---|---|
| Content stored as | plaintext | AES-256-GCM envelope | AES-256-GCM envelope |
| Key for message bodies | — | escrowed per-user DEK (org root key chain) | **session DEK only**, derived from the user's own secret at login |
| Server can read content? | yes | yes (operator holds `MASTER_ENCRYPTION_KEY`) | **no** for message bodies |
| Admin password reset keeps data? | n/a | **yes** | **no** — user needs their recovery key |
| Background jobs (automations, 3am summaries, compaction) can read? | yes | yes | only the escrowed surfaces (§6) |
| Stolen database/backup/replica yields content? | yes | **no** (master key lives in the orchestrator secret store) | no |
| Needs `MASTER_ENCRYPTION_KEY` | no | **yes** (hard requirement — tier is not selectable without it) | not required (advisory only for OPAQUE) |
| Saving it signs everyone out | no | no | **yes** |
| Plan required | none | Enterprise | Enterprise |

The `managed` tier's honest label, from `orgEscrow.js`: *"It does NOT protect against the operator of
the server, who has the master key in their environment. This tier is not zero-knowledge and must never
be described as such."*

---

## 5. Defaults, limits and numbers

Crypto (`server/auth/encryption.js`):
- Algorithm `aes-256-gcm`; IV **12 bytes** (NIST SP 800-38D); salt **32 bytes**, random per user;
  DEK **32 bytes**; recovery key **32 bytes**.
- Argon2id current profile: **memoryCost 131 072 KiB (128 MiB), timeCost 4, parallelism 4,
  hashLength 32**. Roughly 250–400 ms per hash.
- Argon2id for **PINs**: same but **timeCost 5** (PINs are lower entropy).
- Legacy Argon2 profile kept for transparent migration: **64 MiB, timeCost 3, parallelism 4**. On a
  successful legacy unlock the DEK is silently re-wrapped with the current params.
- Ancient legacy path: PBKDF2-SHA256, 100 000 iterations, deterministic salt `beeflow-kek-<userId>`,
  no AAD — migrated on first successful unlock.
- Master-key migration deadline hard-coded: **2026-06-01**. Past it, `getLegacyMasterKey()` refuses
  and logs `[CRITICAL]`. (That date has passed — legacy master unwrap is dead in this build.)
- **Minimum PIN length: 6 characters** (`MIN_ENCRYPTION_PIN_LENGTH`, enforced client-side in
  `EncryptionSetup.jsx` and server-side in `ssoEncryptionRoutes.js`). The code itself flags 6 as weak
  for a digits-only PIN (10⁶ space) and says Argon2id + lockout are what make it survivable.
- **AAD strings** (bind ciphertext to context, block cross-user replay): `dek-wrap:<userId>`,
  `dek-recovery:<userId>`, `dek-org:<orgId>:<userId>`, message fields `bfmsg:v3:<agent|direct>:<convId>:<field>`.

Lockouts:
- Password/PIN DEK unwrap: exponential backoff from the **3rd** failure, `2^failures` seconds, capped
  at **1 hour**; **hard lockout at 20 failures** (`[ALERT] HARD LOCKOUT`, needs admin reset or recovery
  key); `[ALERT]` logged from the **5th** failure; a success decays the counter by one.
- Recovery-key unwrap: backoff from the 3rd failure; **hard lockout at 10 failures**.
- OPAQUE rate limits: login **30 requests / 15 min** per IP; registration **10 / hour** per user.
- Bulk-decrypt alert: **50 decrypts in a 60 s sliding window** logs `[ALERT] Bulk decrypt detected`
  (`server/auth/decryptAudit.js`; in-memory, resets on restart).

Caches and TTLs:
- Encryption-policy cache: **30 s TTL, max 500 orgs** (`encryptionPolicy.js`).
- Org Root Key cache: **5 min TTL, max 200 orgs** (`orgEscrow.js`).
- Transcript DEK cache: **60 s TTL, max 200 orgs** (`transcriptEscrow.js`).
- "no key available" warning throttle: one line per org/tier/kind per **60 s**.

Defaults:
- Column default `organizations.encryption_tier = 'none'`. **Every install and every upgrade starts Off.**
- Operators can set `BEEFLOW_DEFAULT_ENCRYPTION_TIER` so *new* orgs start higher
  (`stores/initialTier.js`). It never widens: if the tier is not selectable for that new org, the
  org lands on `none` and a warning is logged. Existing orgs are never touched.
- `encryption_scope` NULL = every surface this tier supports. A surface set to `false` is off; anything
  that is not a strict boolean is treated as ON (fails toward protecting data).
- Backfill script batch size **200 rows**, keyset cursor, `--dry-run` first.

Surfaces (`SURFACES` in `encryptionPolicy.js`) — all seven are currently in `IMPLEMENTED_SURFACES`:

| key | what it covers |
|---|---|
| `messages` | `conversation_messages.content` — message bodies |
| `messageMeta` | `conversation_messages.meta_json` — attachment sidecars (storageKey, extractedText) |
| `conversationMeta` | `agent_conversations.meta_json` / `direct_conversations.meta_json` — the compaction summary |
| `piiTokenMap` | `pii_token_map` — the Privacy Shield token → real-PII dictionary |
| `conversationTitle` | LLM-generated conversation titles (usually a précis of the first message) |
| `notebookMessages` | `notebook_conversations.messages_json` — notebook / legal-matter chat |
| `transcripts` | transcription `full_text`, `transcript`, `summary`, `segments`, `speakers`, `attendees`, `chapters` (+ the encrypted 2000-char `full_text_snippet_enc` preview) |

Not covered, on purpose and documented: transcription `action_items`, `decisions`, `questions`
(merged in SQL on write — the merge cannot run over an envelope), transcription `title` and
`file_name` (they label the list; needs a list-UX decision first), and lifecycle/authorisation columns
(`id`, `user_id`, `organization_id`, `status`, `created_at`, counts, language, provider, tags).

Always-on regardless of tier: the per-user **tokenisation vault** `pii_vault_entries` (deliberately not
a toggleable surface; `norm_key` is an HMAC blind index keyed from the user's DEK), `orgVault` secrets
(integration credentials), and `automation_credentials`.

---

## 6. The two stated weakenings of Zero-knowledge (learners get this wrong)

1. **ZK escrow surfaces** (`messageCrypto.js`): on `zk`, three surfaces still use the org escrow, because
   they are written by code with no user session in scope — `piiTokenMap`, `conversationMeta`,
   `conversationTitle`. An org-held key is weaker than zero-knowledge and strictly stronger than the
   plaintext they were written in before. **Message bodies are deliberately NOT in this set — that is
   the line that makes `zk` worth choosing.**
2. **Shared project conversations and transcripts.** A conversation *shared into a project* is encrypted
   with a key derived from the org root key (`projectEscrow.js`) on every tier, so the operator can read
   it. Private conversations stay on the session DEK. Sharing re-encrypts at that moment; unsharing
   re-keys it back to the owner. **Transcriptions are keyed to the organisation, not to a user**
   (`transcriptEscrow.js`) because they are shareable (`shared_with`, `is_published`) and the
   summary/insight jobs read them with no session — so on `zk` a meeting transcript **is readable by the
   server operator**. Say this out loud in any lesson about meeting notes.

---

## 7. End-to-end workflows (exact click sequences)

### Workflow A — Turn on Managed encryption for the organisation
1. Sign in as an org admin.
2. Open **Settings** (gear / avatar menu).
3. In the left nav, open the **Organisation** accordion.
4. Click **Encryption**. The page loads `GET /auth/organizations/<orgId>/encryption`.
5. Read the three cards. If **Managed** shows an **Enterprise** badge and a grey reason, stop — you need
   a plan upgrade (§8).
6. Click the **Managed** card (or arrow-key to it — it is a real radio group).
7. Click **Save**.
8. A green toast reads **"Encryption settings saved"**. The page reloads its state from the server.
9. Nothing else happens: existing messages stay exactly as they are, and every user stays signed in.
10. (Optional, ops) Run the backfill so the *history* is encrypted too:
    `node server/scripts/backfill-encryption.js --org <orgId> --dry-run`, read the report, then re-run
    without `--dry-run`.

### Workflow B — Turn on Zero-knowledge (the disruptive one)
1. Settings → Organisation → **Encryption**.
2. Click the **Zero-knowledge** card.
3. A **red** box appears immediately, before you save: *"Saving this will sign out everyone in the
   organisation, including you. Each person must sign in again so their encryption key can be created.
   Data can no longer be recovered by an administrator."*
4. Tell your colleagues first. Then click **Save**.
5. The server deletes every session row for the org (`bustSessionsForOrg`) and clears them from Redis.
6. A toast reads **"Everyone in this organisation has been signed out. Each person must sign in again so
   their encryption key can be created."** You are signed out too, on your next request.
7. Sign back in. Password users derive their DEK from their password automatically. SSO users land on
   the **Set Up Data Encryption** screen.
8. Note: message-body history **cannot** be backfilled on `zk` — the backfill script has no session key
   and says so, then skips that surface.

### Workflow C — An SSO user sets up their encryption PIN and stores the recovery key
1. User signs in with Google/Microsoft SSO.
2. The app shows the full-screen **Set Up Data Encryption** gate (from `/auth/user`:
   `needsEncryptionSetup: true`).
3. Type a PIN in **Choose Encryption PIN** (minimum 6 characters) and repeat it in **Confirm PIN**.
4. Click **Set Up Encryption**. The browser first tries the OPAQUE PIN registration
   (`POST /auth/opaque/pin/register/start` + `/finish`), so the PIN never leaves the device; if that
   fails it falls back to `POST /auth/sso-encryption-setup`.
5. The **Save Your Recovery Key** screen shows a key like
   `3F9A1C0B-77D2E4A6-…` (8 groups of 8 hex chars).
6. Click **Copy to clipboard** (button flips to **Copied!**), paste it into the company password manager.
7. Click **I've saved my recovery key — Continue**. The app opens.
8. On every later sign-in the user sees **Unlock Your Data** and types the PIN.

### Workflow D — A user forgot their PIN and rescues their data
1. On the **Unlock Your Data** screen, click **Forgot your PIN? Use recovery key**.
2. On **Recover Your Account**, paste the key into **Recovery Key** (dashes and whitespace are stripped;
   it must resolve to exactly 64 hex characters).
3. Type a **New PIN** (min 6) and repeat it in **Confirm New PIN**.
4. Click **Recover & Set New PIN** (`POST /auth/sso-recovery`).
5. The server unwraps the DEK with the recovery key, re-wraps it under the new PIN, and issues a
   **new** recovery key — the **Save Your Recovery Key** screen appears again.
6. Copy the new key and replace the old one in the password manager. The old one no longer works.
7. If the key is wrong: "Invalid recovery key" (401). After **10** wrong recovery attempts the recovery
   path hard-locks.

### Workflow E — Admin resets a colleague's password (and what it costs)
1. Settings → Organisation → **Users & Groups**.
2. Open the user, set a new password, save (`PUT /auth/users/:id` with `password` and **no** `oldPassword`).
3. Server-side `adminResetUser(userId)` runs: it **wipes `wrappedDEK` and `kekSalt`**, sets
   `passwordResetRequired = 1`, and clears the failure counters. `recoveryWrappedDEK` is deliberately kept.
4. On **Managed**: the user signs in with the new password and sees everything — their content key is the
   escrowed `orgWrappedDEK`, which the reset did not touch.
5. On **Zero-knowledge**: the user's old data is unreadable until they run the recovery-key flow. Without
   the recovery key it is gone. Permanently. There is no support ticket that fixes this.
6. When the *user* changes their own password (with `oldPassword`), `rewrapUserDEKCompat` unlocks the DEK
   with the old password and re-wraps it with the new one — no data loss on any tier.

### Workflow F — Verify what is actually being enforced
1. Settings → Organisation → **Encryption**, confirm the selected card.
2. As the org admin, call `GET /auth/organizations/<orgId>/encryption` and compare `scope` with
   `effective`. `scope` is what was asked for; `effective` is `scope AND implemented`. They can differ.
3. Settings → Organisation → **Compliance** → the access trail, filtered on action
   `org.encryption.update`, shows who changed the tier and from what to what.
4. Check the server log for `[MessageCrypto] Org '<id>' is on encryption tier '<tier>' but no key is
   available` — that line means the org sees "encryption: on" while plaintext is being written.

---

## 8. Permission and licence gates

**Permission (who may open and save):**
- Both routes call `requireStrictOrgAdmin(req, res)` → `permissions.isOrgAdminForOrg(req, req.params.id)`.
  Super admins short-circuit through that helper. Failure → **403 `{"error":"Only organization admins can
  manage encryption settings"}`**.
- This is the *strict*, group-permission-aware decider — deliberately not the local `requireOrgAdmin`,
  which would let someone who is org_admin of org A and merely a *member of a group* in org B pass for
  org B (`server/auth/admin/orgRoutes.js`, and `server/auth/accessRegistry.js` records the contract as
  `scope: { kind: 'orgAdminOfParam', param: 'id' }`).
- `server/config/orgRoles.json`: the `org_admin` role (label **"Organisation Admin"**) carries
  `org_admin`, `admin_security`, `admin_compliance`, `manage_users`, … . The `dpo`
  ("Data Protection Officer") and `isms_auditor` roles do **not** carry `org_admin`, so a DPO can read
  the compliance trail but cannot change the tier. `member`, `agent_editor`, `agent_admin`: no access.
- The frontend nav gate is `canSeeOrg` = `perms.includes('all') || perms.includes('org_admin') ||
  user.orgRole === 'admin' || user.orgRole === 'org_admin'`.
- **Per-surface `scope` is super-admin only.** A non-super-admin sending `scope` gets
  **403 `{"error":"scope_forbidden","code":"encryption_scope_super_admin_only"}`**. The GET returns
  `canEditScope: <isSuperAdmin>`; the UI never renders the control.

**Licence (which tiers may be chosen):**
- Feature key: **`encryption`**, listed in the **enterprise** tier bundle in `server/license/tiers.js`.
  On cloud, a plan's additive `allowed_features` grant also satisfies it —
  `license.hasFeature({organizationId}, 'encryption')` unions tier and plan grant. On self-hosted,
  subscriptions are never consulted, so the server licence tier is the only source.
- It is an infra/admin gate: the auto-projected capability is `userFacing:false` / `groupTogglable:false`,
  so it never appears in the per-group access matrix.
- **`none` is always selectable**, even when the entitlement has lapsed — otherwise a downgrade would
  strand an org on a tier it can no longer manage.
- Deliberately **not** `requireLicenseFeature` middleware: that resolves across the *caller's* orgs
  (wrong for an `:id`-scoped route) and a route-level 403 cannot express *which* tiers are allowed.
  Instead the route clamps and the UI upsells.
- The entitlement check only runs when the tier actually **changes**, so a lapsed org can still save
  and can still switch back to Off.

---

## 9. What happens on failure

| Situation | Behaviour |
|---|---|
| GET fails (network, 403, 500) | Red box "Could not load encryption settings." + the error. `server` state is nulled so **Save stays disabled** — saving on top of a failed load would write a guess. |
| Save while not entitled | **403** `{error:'feature_locked', code:'encryption_not_entitled', feature:'encryption', tier, message}` → toast with the server message. |
| Save a tier the server cannot deliver | **409** `{error:'tier_unavailable', code:'encryption_tier_not_ready', tier, missing:['MASTER_ENCRYPTION_KEY'], message}`. Refusing outright is deliberate: storing it would make `resolveCrypto` fall back to plaintext with only a `console.error`, and the org would believe it was encrypted. |
| Unknown tier value | **400** `tier must be one of: none, managed, zk` |
| Empty body | **400** `Nothing to update — provide tier and/or scope` |
| Unknown surface in `scope` | **400** `unknown surface(s): …. Valid: …` |
| Non-boolean scope value | **400** `scope.<key> must be a boolean` |
| Org not found | **404** `Organization not found` |
| DB write fails | **500** `Failed to update encryption settings` |
| Session bust fails after a switch to zk | The save still succeeds; the server logs `[Auth] FAILED to bust sessions for org '<id>' … existing sessions will write PLAINTEXT until they expire`. Ops must force a sign-out. |
| No key resolvable at write time | The write is **plaintext**, never an unopenable ciphertext, and `[MessageCrypto] … no key is available …` is logged (throttled to 1/min per org+tier+kind), with a hint naming `MASTER_ENCRYPTION_KEY` / the org escrow / the entitlement. |
| A shared-project key cannot be produced | This is the one failure that is **not** absorbed: the error is tagged `PROJECT_KEY_UNAVAILABLE` and rethrown; routes map it to a **503**. Falling back would strip protection from rows that are already encrypted. |
| An envelope cannot be decrypted | `decryptField` **throws** `FieldDecryptError` (`code: FIELD_DECRYPT_FAILED`). It must never degrade to `''` or `{}` — a silent empty `meta_json` would destroy attachment sidecars on the next edit. |
| Policy lookup itself fails (DB down, column missing mid-deploy) | Resolves to the disabled policy = write plaintext. An encryption lookup must not be able to fail a chat request. |
| Entitlement lookup fails | Fails **closed** — `isOrgEntitled` returns false and logs `[EncryptionAvailability] entitlement check failed`. |

---

## 10. How it connects to the rest of the product

- **Privacy Shield** (Settings → Organisation → Privacy Shield). The Shield produces the
  `pii_token_map`: the dictionary that turns `[person_1]` back into a real name. That map is an
  encryption surface (`piiTokenMap`) and is escrowed even on `zk`, because the DLP runner writes it with
  no session. The per-user tokenisation vault is encrypted on every tier.
- **Conversation Memory / compaction** (Settings → Organisation → Conversation Memory). The compaction
  summary lives in `conversation_meta` — surface `conversationMeta`, also escrowed on `zk`.
- **Meeting Notes / transcripts.** Surface `transcripts`, keyed to the organisation via
  `org_transcript_dek` (wrapped by the ORK, so an ORK rotation rewraps it and nothing is orphaned).
  Action items, decisions, questions, titles and file names stay plaintext.
- **Notebooks / legal matters.** Surface `notebookMessages`.
- **Projects / shared conversations.** `projectEscrow.js` derives the key from the ORK. Because those
  keys are *derived* rather than wrapped, `rotateOrgRootKey` **refuses outright** when the org has shared
  conversations (`assertNoSharedConversations`) rather than orphan them.
- **Sign-in Method / SSO.** SSO users have no password to derive a KEK from, hence the separate
  **Encryption PIN** and the `EncryptionSetup` gate. `GET /auth/opaque/status` reports `kdfMode`
  (`opaque_v1` vs `legacy_argon2`).
- **Users & Groups.** Admin password reset is the destructive interaction (§7 Workflow E).
- **Compliance Center.** `GDPR-Art32-encryption-at-rest` (severity `critical`, also mapped to NIS2
  Art. 21(2)(h)) passes only when both `MASTER_ENCRYPTION_KEY` and `SESSION_SECRET` are set; its evidence
  block reports `envelope_encryption: "AES-256-GCM (messageEncryption)"`. Every tier change is written to
  `access_audit_log` as `org.encryption.update` and is readable in the compliance access trail.
- **Ops / key rotation.** `scripts/rotate-master-key.js` rotates `MASTER_ENCRYPTION_KEY` in five steps and
  carries an *envelope inventory* — `organizations.org_root_key` is on it, and omitting it would lose the
  org's entire encrypted history at once. `organizations.org_transcript_dek` is deliberately **not** on
  it (it is wrapped by the ORK, not the master).

---

## 11. Common mistakes

1. **"I turned it on, so we're encrypted."** Only *new* writes are. Existing rows stay plaintext until
   `server/scripts/backfill-encryption.js` has been run (dry-run first). On `zk`, message bodies can never
   be backfilled.
2. **Switching to Zero-knowledge during working hours.** It deletes every session in the org. If the
   session bust silently fails, open sessions keep writing **plaintext** while the UI says "encrypted".
3. **Believing `zk` protects meeting transcripts from the operator.** It does not (§6).
4. **Resetting a user's password on `zk` without asking about their recovery key.** That is the single
   most common way to destroy data here.
5. **Treating the recovery key as one-time paperwork.** Every rescue and every PIN change mints a *new*
   key and invalidates the old one. The password manager entry has to be updated each time.
6. **Confusing the encryption PIN with the SSO password.** The setup screen says it explicitly:
   "This is separate from your SSO login." A 6-character PIN is the *minimum*, not a recommendation.
7. **Expecting per-surface switches in the UI.** There are none; `scope` is a super-admin API control.
8. **Reading `scope` as proof of protection.** Compare `effective`, not `scope`.
9. **Assuming "encrypted at rest" means the operator cannot read it.** On `managed` it explicitly can.
10. **Running `docker compose down -v` / losing `MASTER_ENCRYPTION_KEY`.** On `managed` the master key is
    the root of the whole chain; losing it loses everything wrapped under it.
11. **Rotating the org root key while shared project conversations exist.** The rotation refuses — by
    design — and the fix is to unshare first.
12. **Assuming a hung PIN screen means a wrong PIN.** An account still on `kdfMode: legacy_argon2` has no
    OPAQUE record; the client must fall through to the legacy endpoint. Repeated wrong entries walk toward
    the 20-attempt hard lockout.

---

## 12. Three scenarios for **Van Dijk Groep** (Dutch SME, ~60 staff)

### Scenario 1 — Procurement (inkoop)
Van Dijk Groep's inkoop team pastes supplier quotations and draft framework contracts into Bee Flow to
compare terms. Prices and rebate ladders are commercially sensitive but the team must be able to hand a
thread to a colleague, and the nightly "open tenders" automation has to summarise them. Marieke (org admin)
opens **Settings → Organisation → Encryption** and picks **Managed**. Result: the quotation text is
AES-256-GCM in the database, a stolen backup yields nothing, the 3am automation still works because it reads
the escrowed key, and when a buyer forgets their password Marieke can reset it without losing the thread.
Afterwards she runs the backfill on the messages surface so the two years of history already in the system
are protected too.

### Scenario 2 — HR (personeelszaken)
HR runs performance conversations, sick-leave notes and a works-council case through Bee Flow. Nobody in
IT — and no Bee Flow employee — should be able to read them. Marieke creates a separate organisation for
HR on the Enterprise plan, opens **Encryption**, selects **Zero-knowledge**, reads the red warning aloud in
the Monday stand-up, and saves on a Friday at 17:00. Everyone is signed out. On Monday the four HR staff
sign in again; the two on Microsoft SSO get the **Set Up Data Encryption** screen, choose a PIN and store
the recovery key in the company password-manager vault that only HR can open. Two things Marieke documents
for the team: (a) if someone loses both PIN and recovery key their history is gone and she cannot help,
and (b) the recorded works-council *meeting transcripts* are keyed to the organisation, not to the user,
so they are **not** zero-knowledge — the team agrees not to record those meetings.

### Scenario 3 — Sales
Sales keeps deal threads and call transcripts in Bee Flow and shares them into a project so the whole team
and the follow-up automations can act on them. Van Dijk Groep is on the Community plan, so when the sales
manager opens **Settings → Organisation → Encryption** he sees the amber banner "Encryption is not included
in your current plan. You can still turn it off, but not on.", with **Managed** and **Zero-knowledge**
greyed out, each carrying an **Enterprise** badge and an **Upgrade at beeflow.nl** link. After the upgrade
he picks **Managed** — the right choice here anyway, because every sales thread is shared into a project and
project-shared conversations are keyed to the org on every tier; choosing `zk` would have bought the extra
guarantee only for the handful of private threads while costing a full org-wide sign-out.

---

## 13. API endpoints for "did the learner do it?" checks

All paths below were read in `server/routes` / `server/auth` and confirmed to exist. The auth router is
mounted at `/auth` (`server/index.js:548`); the compliance router at `/api/compliance`
(`server/index.js:605`). Everything is **session-cookie** auth (`authFetch` sends credentials).

### Primary check — the tier itself
**`GET /auth/organizations/:id/encryption`** — `server/auth/admin/orgRoutes.js:150`.
Auth: signed-in **org admin of `:id`** (super admin passes). 403 otherwise, 404 for an unknown org.
JSON:
```jsonc
{
  "tier": "none" | "managed" | "zk",
  "enabled": true,                       // tier !== 'none'
  "scope":   { "messages": true, "messageMeta": true, "conversationMeta": true,
               "piiTokenMap": true, "conversationTitle": true,
               "notebookMessages": true, "transcripts": true },
  "effective": { /* same keys — scope AND implemented; this is what is enforced */ },
  "surfaces": ["messages","messageMeta","conversationMeta","piiTokenMap",
               "conversationTitle","notebookMessages","transcripts"],
  "implementedSurfaces": [ /* subset actually wired */ ],
  "keyVersion": 1,                       // organizations.org_key_version
  "entitled": true,
  "allowedTiers": ["none","managed","zk"],
  "tierOptions": [ { "tier":"managed", "selectable":true, "reason":null,
                     "missing":[], "warnings":[], "warningReason":null,
                     "blockedBy": null | "entitlement" | "readiness" } ],
  "readiness": { "none": {...}, "managed": {...}, "zk": {...} },
  "canEditScope": false                  // true only for a platform super admin
}
```
There is **no owner field** — this resource is the organisation; the `:id` in the path *is* the scope.

### Supporting reads
- **`GET /auth/organizations`** — `orgRoutes.js:60`. Auth: signed in **and** one of `all`,
  `manage_users`, `admin_security`, `org_admin`; a non-super-admin's list is filtered to their own orgs.
  Returns an **array** of full organisation rows (`SELECT *` → `parseOrg`), each containing `id`, `name`,
  `encryption_tier`, `encryption_scope`, `org_key_version`, `allowedDomains`, `authMethod`, plan/status
  fields, etc. Useful for a check that must find the learner's org id first.
- **`GET /auth/organizations/:id`** — `orgRoutes.js:116`, middleware `requireOrgAdmin('id')`. The single
  org row, same shape as one element of the list (so `encryption_tier` is present here too).
- **`GET /auth/user`** — `server/auth/login/currentUserRoutes.js:17`. Any signed-in session; returns
  `{authenticated:true}` plus `user.id`, `user.organizationId`, `user.orgRole`, `user.isAdmin`, and the
  encryption gate flags **`encryptionEnabled`**, **`needsEncryptionSetup`**, **`needsEncryptionPin`**.
  This is the read that tells you whether a *user* has finished their PIN setup.
- **`GET /auth/opaque/status`** — `server/auth/opaqueRoutes.js:795`, `requireAuth`. Returns
  `{ "kdfMode": "legacy_argon2" | "opaque_v1", "hasOpaqueRecord": bool, "opaqueMode": bool }` for the
  **calling user** — the per-user "did they enrol on the strong path?" check.
- **`GET /api/compliance/access-audit`** — `server/routes/compliance/accessAudit.js:125`. Auth:
  `requireAuth` + `requirePermission('admin_compliance')`, and the whole `/api/compliance` mount needs
  the `compliance_hub_gdpr` capability. Query: `action=org.encryption.update`, plus
  `targetType`, `targetId`, `actor`, `since`, `until`, `limit` (default 100, max 500), `offset`.
  Returns `{ entries, total, limit, offset, scope }`; each entry is an `access_audit_log` row:
  `id`, `action` (`"org.encryption.update"`), `target_type` (`"organization"`), `target_id` (the org id),
  `organization_id`, **`changed_by`** (the acting user id — the closest thing to an owner field),
  `old_values` (`{tier, scope}` before), `new_values` (`{tier, scope}` after), `created_at`.
  Always org-scoped from the caller's own account; an account with no organisation gets 403.
- **`GET /api/compliance/access-audit/actions`** — same gates; `{ actions: [{action, count, last_at}] }`.
  A cheap way to assert that `org.encryption.update` has happened at all in this org.

### Write endpoints (for reference, not for verification)
- `PUT /auth/organizations/:id/encryption` — body `{ tier?, scope? }`; response
  `{ success, tier, enabled, scope, sessionsBusted }` (`sessionsBusted: true` only on a fresh switch into `zk`).
- `POST /auth/sso-encryption-setup` `{pin}` → `{success, recoveryKey}`
- `POST /auth/sso-encryption-unlock` `{pin}` → `{success}` | `{needsSetup:true}` | 401 `Incorrect PIN`
- `POST /auth/sso-change-pin` `{oldPin, newPin}` → `{success, recoveryKey}`
- `POST /auth/sso-recovery` `{recoveryKey, newPin}` → `{success, recoveryKey}`
- `POST /auth/opaque/register/start|finish`, `/login/start|finish`, `/pin/register/start|finish`,
  `/pin/login/start|finish`

There is **no HTTP endpoint** for org-root-key rotation or for the backfill — both are CLI only
(`scripts/rotate-master-key.js`, `server/scripts/backfill-encryption.js`).
