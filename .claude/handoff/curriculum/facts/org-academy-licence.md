# Fact sheet — Organisation ▸ Academy, Licence/subscription gates, Organisation Info, Meeting templates

Audience for lessons: **org admins** (orgRole `org_admin`, legacy `admin`).
Status: **exists and is fully built** (not a stub). Everything below was read from the code in
the repo root on 2026-09-14.

Key source files
- Frontend: `agent-hub/src/pages/settings/OrgAcademyPanel.jsx`,
  `agent-hub/src/pages/settings/learning/admin/AcademyContentEditor.jsx`,
  `agent-hub/src/pages/settings/learning/admin/academyApi.js`,
  `agent-hub/src/pages/settings/OrganisationSection.jsx`,
  `agent-hub/src/pages/AdvancedSettings.jsx`,
  `agent-hub/src/components/admin/org/orgInfo/OrgLicenseSection.jsx`,
  `agent-hub/src/components/admin/org/orgInfo/OrgInfoSection.jsx`,
  `agent-hub/src/components/admin/org/orgInfo/orgInfoShared.jsx`,
  `agent-hub/src/components/admin/org/GroupAccessMatrix.jsx`,
  `agent-hub/src/components/meetings/SummaryTemplatesAdminPanel.jsx`,
  `agent-hub/src/components/licensing/Gate.jsx` (`useCan`),
  `agent-hub/src/authedApp/settingsRoutes.js`, `agent-hub/src/i18n/en-defaults.js`
- Backend: `server/routes/ai/learning.js`, `server/routes/ai/learningAdmin.js`,
  `server/routes/ai.js` (mounts), `server/learning/orgOverview.js`,
  `server/learning/courseCatalog.js`, `server/learning/completion.js`,
  `server/stores/learningContentStore.js`, `server/license/tiers.js`,
  `server/license/index.js`, `server/license/featureMap.js`,
  `server/core/entitlements/entitlements.js`, `server/core/entitlements/betaFeatures.js`,
  `server/modules/catalog.js`, `server/auth/permissions.js`, `server/config/orgRoles.json`,
  `server/routes/summaryTemplates.js`, `server/stores/summaryTemplateStore.js`,
  `server/auth/admin/orgRoutes.js`, `server/routes/subscriptions.js`, `server/jobs/learningNudge.js`

---

## 1. What the feature is for

Three admin-facing things live next to each other under **Settings → Organisation**:

1. **Academy** — one screen where the org admin sees *who in the team has learned what*
   (courses completed, badges, certificates, last activity) and, with a beta capability,
   *authors the org's own courses* (slides, quizzes, AI-coached exercises) that appear inside
   members' Learning Center next to Bee Flow's nine built-in courses.
2. **License & Usage** — the org's plan/subscription (cloud) or licence key (self-hosted), what
   tier it is, the AI-usage cost cap and the plan limits. The tier is the *ceiling*: what the
   organisation is even allowed to switch on.
3. **Organisation Info** and **Meeting templates** — the org's identity (branding, legal/invoicing,
   default language) and org-wide/group Meeting Notes summary styles.

They belong in one lesson block because the Academy's authoring half is gated by a capability that
comes from the licence/plan, and Organisation Info is the org row the whole gating machinery hangs
off (`organizationId`).

---

## 2. Screens and their real labels

### 2.1 Getting there

Settings sidebar → accordion **"Organisation"** (`settings.organisation`, en: *Organisation*).
Its rows, in order (`BASE_ORG_SUB_ITEMS` in `AdvancedSettings.jsx`):

| Row label (en) | i18n key | URL |
|---|---|---|
| License & Usage | `settings.license_usage` | `/app/settings/organisation/license` |
| Sign-in Method | `settings.signin_method` | `/app/settings/organisation/auth` |
| Privacy Shield | `settings.privacy_shield` | `/app/settings/organisation/privacy` |
| Encryption | `settings.encryption` | `/app/settings/organisation/encryption` |
| AI Context / Integration cache | `settings.ai_context`, `settings.integration_cache` | `…/info` group |
| Organisation Info | `settings.org_info` | `/app/settings/organisation/info` |
| Usage & Monitoring | `settings.usage_monitoring` | `/app/settings/organisation/usage` |
| Compliance | `settings.compliance` | `/app/settings/organisation/compliance` |
| Users & Groups | `settings.users_groups` | `/app/settings/organisation/users` |
| **Academy** | `settings.academy` → **"Academy"** | `/app/settings/organisation/academy` |
| Integrations | `settings.integrations` | `/app/settings/organisation/integrations` |
| GitHub Sync / Nextcloud Sync | … | `…/github-sync`, `…/nextcloud-sync` |
| **Meeting templates** | `settings.meeting_templates` → **"Meeting templates"** | `/app/settings/organisation/meeting-templates` |

The whole Organisation accordion is hidden on phones (`settingsNavItems.jsx`); only
`org_compliance` is let through. Academy is therefore a **desktop screen**.

### 2.2 Academy → Overview tab (always present for an org admin with the Learning Center)

Header: 🎓 **Academy** · subtitle **"Course progress, badges and certificates across your team."**
Top-right button **"Refresh"** (spins while loading).

Four stat cards: **Members**, **Courses completed**, **Certificates issued**, **Active last 30 days**
(each shows `—` until data arrives).

Filter row: search box placeholder **"Search members…"**, and a dropdown whose first option is
**"All courses"**, then one option per built-in course prefixed **"Completed:"** (e.g.
*Completed: Prompt Engineering*).

Member table header (desktop only): **Member · Courses · Badges · Certificates · Last activity**.
Each row: avatar, display name, e-mail, a row of **dots** (one per built-in course — filled emerald
= completed, hollow = not) with an `n/9` counter, `🏅 N` or `—` for badges, certificate pills
`📜 <level>` (hover shows the issue date) or `—`, and a relative timestamp.

Relative-time strings: **"Today"**, **"Yesterday"**, **"{n} days ago"**, **"{n}mo ago"**, a locale
date beyond 12 months, and **"Not started"** when the member has no activity at all.

Empty / error states
- No members with any activity: **"No learning activity in your organisation yet."**
- Filters hide everything: **"No members match the current filters."**
- Load failure: **"Could not load the learning overview."**
- While loading for the first time: a five-row skeleton.

### 2.3 Academy → Content tab (only with the `learning_custom_content` beta)

When the capability is present, the panel grows a tab strip: **Overview** | **Content**.
Without it, the Overview renders alone with no tab chrome at all.

**Course list view** — 📖 **"Custom courses"**, subtitle **"Author your own Academy courses. Drafts
stay private until you publish them to your members."**, primary button **"+ New course"**.
Empty state: **"No custom courses yet — create your first one."** Each row shows the title, a status
chip **"Draft"** / **"Published"**, and the `updatedAt` date.

**Course edit view** — toolbar: **"All courses"** (back), the status chip, then
**"Delete"**, **"Publish"** (green) or **"Unpublish"**, and **"Save course"**.
Fields: **Course title**, **Level** (options **Beginner** / **Intermediate** / **Advanced**),
**Description**, **Icon** (emoji picker: 📘 🐝 🧭 🛠️ 💬 📊 🔌 🧠 ✍️ 🎯 🤝 🧩),
**Badge title (earned on completion)** (placeholder = course title),
**Badge emoji** (🏵️ 🏅 🎖️ 🏆 ⭐ 🎓 💎 🚀 🐝 🧠 🎯 📘).
Lesson list header **Lessons** with **"+ Add lesson"**; empty state
**"No lessons yet — a course needs at least one lesson before publishing."**
Each lesson row: icon, title (or **"Untitled lesson"**), and either **"Not saved yet"** or
`N steps · M min`; icon buttons **Move up**, **Move down**, **Delete lesson**.
Save feedback: **"Saved"** / **"Lesson saved"** (auto-clears after 2.5 s),
**"Published — members can now see this course."**, **"Unpublished — hidden from members again."**

Confirm dialogs (browser `confirm`)
- **"Delete this course and all its lessons? This also removes it for members."**
- **"Remove this lesson from the course?"**
- **"Delete this step?"**

**Lesson editor view** — **"Back to course"**, **"Save lesson"**.
Fields: **Lesson title**, **Estimated minutes** (1–120), **Description**, **Icon**.
Step toolbar: **Steps** and three add buttons **Slide** / **Quiz** / **Exercise**.
Empty: **"No steps yet — add a slide, quiz or exercise above."**
- Slide: **Title**, **Body (Markdown)**, live **Preview**.
- Quiz: **Title** (placeholder *Quick check*), **Question**,
  **Choices (2–6, tick the correct ones)** with **+ Add choice** and a **Correct answer** checkbox,
  **Multiple answers can be correct**, **Explanation (shown after answering)**.
- Exercise: **Title** (placeholder *Hands-on practice*), **Task (what the learner must do)**,
  **Instruction (shown above the answer box)**, **Answer box placeholder**,
  **Grading criteria (private, max 6)** with hint
  **"The AI coach grades against these. Learners never see them."**, **+ Add criterion**,
  **Pass score (1–100)**, **Max attempts (1–10)**,
  **Grading guidance (private note to the AI coach)**.

### 2.4 License & Usage

Heading **"License & Usage"** (cloud consumer variant: *Subscription & Usage*), subtitle
**"Your current plan and usage for this billing period"**.
No plan: **"No license assigned"** + **"Contact your administrator to set up a plan for your
organisation."** and, on cloud, **"Choose a Plan"** with per-plan **"Subscribe"** buttons; if the
platform has none: **"No plans are available right now."**
With a plan: the plan card, **"Change plan"** / **"Manage Billing"**, **cost cap / month**,
**"AI usage of cap this period"**, **Usage this period**, **Plan limits** (Users / Agents /
Knowledge sources), **"AI usage sharing"** with the toggle **"Share AI usage across the
organisation"** (**Pooled across the organisation** vs **Each user has their own budget**),
**"Cancel subscription"** and the confirm copy
**"Cancel your subscription at the end of the current billing period? …"**.
Self-hosted with a server licence: **"Tier is managed server-wide"**. On self-hosted the whole
**License & Usage** row is removed from the sidebar — licensing is governed from the admin
dashboard's **Server licence** panel instead.

### 2.5 Organisation Info

Sections **Branding** (*"Logo, name, and public-facing details"*) with **Logo**
(hint: *"Displayed in the UI header and exports. PNG or SVG, max 500×200px."*), **Company Name**,
**Tagline**, **Description**, **Email**, **Phone**, **Website**; **Legal & Invoicing** with
**Street** (*"Used on invoices and to calculate tax at checkout."*), **Address line 2**,
**Postal code**, **City**, **Country**, **Chamber of Commerce (KVK)**, **VAT Number**; and
**Default Language** → **New User Language** (*"Set the default interface language for new users in
your organisation"*).
A save bar appears above the content when anything changed: **"Unsaved changes"** +
**"Save changes"** (**"Saving…"** while in flight).

### 2.6 Meeting templates

📄 **"Organization summary templates"**, description **"Add Meeting Notes summary styles for your
whole organization or a specific group. Members pick them from the Regenerate menu; a default is
applied to new meetings automatically."**, empty state **"No organization or group templates yet."**
Rows show the template name, a **Default** badge, and the scope label **"Just me"** /
**"Whole organization"** / the group name (fallback *"Specific group"*); **"New template…"** creates
one. The panel self-hides when the caller is not an org admin or Meeting Notes is not licensed.

---

## 3. Concepts a learner must understand

- **Organisation (org)** — the tenant row (`organizations` table: id, name, description, tagline,
  address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup,
  authMethod, encryption_tier…). Everything org-scoped hangs off its id.
- **Org role vs permission** — `server/config/orgRoles.json` maps an org role to permissions.
  `org_admin` = Organisation Admin and carries `org_admin, manage_users, manage_agents,
  manage_skills, manage_knowledge, manage_apps, manage_components, manage_automations,
  page_settings, use_notebooks, modify_n8n_workflows, support_inbox, admin_agents,
  admin_agents_chat, admin_agents_system, admin_agents_pipeline, admin_components, admin_ai_config,
  admin_security, admin_monitoring, admin_compliance, admin_subscriptions, use_datatables,
  manage_datatables`. Other roles: `dpo`, `isms_auditor`, `agent_admin`, `agent_editor`, `member`.
- **Licence tier** — `community → enterprise → full` (`server/license/tiers.js`, hierarchical: a
  higher tier inherits everything below). The legacy `pro` tier is silently normalised to
  `enterprise`. Cloud subscription plans may only be tier `pro`/`enterprise` or NULL (Free);
  `community` and `full` are rejected for plans.
- **Licence feature** — a string in `TIER_FEATURES` (e.g. `learning_center` is **community**;
  `meeting_notes`, `app_studio`, `compliance_hub_gdpr`, `sso_saml`, `approvals`, `encryption` are
  **enterprise**). `automations` and `agent_routines` deliberately sit in **community**.
- **Capability** — the newer, single gate id used by both server and SPA. The server middleware is
  `requireCapability('<id>')`; the SPA asks `useCan('<id>')` / `<Gate capability="…">`. Capabilities
  have a *kind* (`core`, `beta`, `integration`) and may carry a `licenseFeature`.
- **Ceiling vs grant** — the plan/licence sets the **ceiling** (what the org *could* have); the org
  admin then **grants** capabilities to **All members** or to a **group** (Admin → Access →
  **Grants**, `GroupAccessMatrix`). A user has a capability if it is granted to All members *or* to
  any group they are in, and it is inside the ceiling. Locked (🔒) cards are outside the ceiling.
- **Module** — a whole product surface that can be de-imported per instance
  (`server/modules/catalog.js`). The `learning` module (**"Learning Center"**, category
  *Productivity*, `defaultImported: true`) owns the capabilities `learning_center` and
  `learning_custom_content`. A de-imported module makes its routes **404**, not 403.
- **`learning_center`** — GA capability + community licence feature. Gates the member Learning
  Center page, the lesson player, the achievements/certificate APIs, and (in the SPA) the Academy
  sidebar row.
- **`learning_custom_content`** — **beta** capability, *Academy Custom Courses (Beta)*, whose
  `licenseFeature` is `learning_center`. Gates the whole `/ai/learning/admin` authoring surface and
  the Content tab.
- **Draft vs published** — the authoring surface always edits **drafts**. **Publish** copies the
  course *and* all its lessons to separate published keys; members only ever read the published
  snapshot, through a sanitizer that strips quiz answer keys and exercise rubrics.
- **Progress blob** — per-user `configStore` key `learning_progress_user_<userId>`, shape
  `{ [lessonId]: { completedAt } }`. Badges, course completion and certificate eligibility are
  **recomputed server-side** from it; the client is never trusted.
- **Badge vs certificate** — a badge is earned by completing every *visible* lesson of a course.
  Certificates are `cert-foundations` (*Foundations*), `cert-builder` (*Agent Builder*) and
  `cert-practitioner` (*Practitioner*, rule: 4 completed courses). **Org-authored courses earn
  badges but never count toward a certificate** — otherwise an org could mint a "Bee Flow AI
  Practitioner" with four trivial courses.
- **Visible lessons** — a lesson can be gated by permission and/or licence feature
  (`LESSON_GATES`), so "course complete" means *every lesson this user can see* is done. A member
  without `manage_users` is not held back by the admin lessons.

---

## 4. End-to-end workflows (exact clicks)

### W1 — Read the team's learning progress
1. Sign in as an org admin.
2. Sidebar → **Organisation** → **Academy** (`/app/settings/organisation/academy`).
3. Read the four cards: **Members**, **Courses completed**, **Certificates issued**,
   **Active last 30 days**.
4. Type a name or e-mail into **Search members…** to narrow the table.
5. Pick **Completed: Prompt Engineering** in the course dropdown to see only members who finished
   that course.
6. Hover a course dot to read the course title, hover a `📜` pill to read the issue date.
7. Press **Refresh** for fresh numbers (see §5 — the server caches for 60 s).

### W2 — Author and publish a custom course
1. **Organisation → Academy → Content** (tab only exists with the beta capability).
2. **+ New course**.
3. Fill **Course title**, choose **Level**, write **Description**, pick an **Icon**.
4. Optionally set **Badge title (earned on completion)** and **Badge emoji**.
5. **Save course** → toast **"Saved"** (the course id is minted server-side, `orgc-…`).
6. **+ Add lesson** → the lesson opens, marked **"Not saved yet"**.
7. Fill **Lesson title**, **Estimated minutes**, **Description**, **Icon**.
8. Add steps with **Slide** / **Quiz** / **Exercise**, reorder with **Move up** / **Move down**.
9. **Save lesson** → toast **"Lesson saved"** (the editor also re-saves the course so the lesson id
   is attached; that second write is what stops the lesson being orphaned).
10. **Back to course**, repeat 6–9 for further lessons.
11. **Publish** → chip flips to **Published**, notice
    **"Published — members can now see this course."**
12. Verify as a member: **Settings → Learning Center → Curriculum**; org courses appear in a
    trailing column headed **"Your organisation"**.

### W3 — Take a course back off the shelf
1. **Content** → open the published course.
2. **Unpublish** → **"Unpublished — hidden from members again."** Drafts are untouched; the
   published snapshots are deleted, so the course disappears from members' catalog.
3. To remove it permanently: **Delete** → confirm
   **"Delete this course and all its lessons? This also removes it for members."**

### W4 — Check what the plan allows, then grant it
1. **Organisation → License & Usage** — read the tier, the **cost cap / month** and **Plan limits**.
2. Admin dashboard → **Access** → **Grants**.
3. Pick **All members** or a group in the left column.
4. Toggle the capability (e.g. *Academy Custom Courses (Beta)*). 🔒 items are outside the ceiling
   and cannot be toggled — those need a plan/licence change first.
5. Return to **Organisation → Academy**; the **Content** tab appears after the entitlements snapshot
   reloads (the SPA reads `GET /auth/my-entitlements`).

### W5 — Fill in Organisation Info
1. **Organisation → Organisation Info**.
2. Upload a **Logo** (PNG/SVG, max 500×200 px), set **Company Name**, **Tagline**, **Description**,
   **Email**, **Phone**, **Website**.
3. Fill **Legal & Invoicing**: **Street**, **Address line 2**, **Postal code**, **City**,
   **Country**, **Chamber of Commerce (KVK)**, **VAT Number**.
4. Set **New User Language**.
5. The bar at the top shows **Unsaved changes** → **Save changes**.

### W6 — Add an org-wide meeting summary template
1. **Organisation → Meeting templates**.
2. **New template…**, give it a name and a prompt, keep the scope **Whole organization** (or pick a
   group), optionally mark it **Default**.
3. Save. Members see it in the meeting note's **Regenerate** menu; a default is applied to new
   meetings automatically.

---

## 5. Defaults, limits and numbers

Authoring limits — `server/stores/learningContentStore.js` `LIMITS` (server authoritative; the
editor mirrors them so it never offers a rejected input):

| Limit | Value |
|---|---|
| Custom courses per organisation | **50** |
| Lessons per course | **20** |
| Steps per lesson | **30** |
| Title characters | **120** |
| Description / question / explanation characters | **400** |
| Slide body characters | **8000** |
| Quiz choices | **2 minimum, 6 maximum** |
| Choice label characters | **200** |
| Exercise criteria | **1 minimum, 6 maximum** |
| Criterion characters | **300** |
| Estimated minutes | 1–120, **default 5** |
| Pass score | 1–100, **default 70** |
| Max attempts | 1–10, **default 3** |
| Default course icon / badge icon | **📘** / **🏵️** |
| Default level | **beginner** |
| Minted ids | courses `orgc-<12 hex>`, lessons `orgl-<12 hex>`, badge `badge-org-<hex>` |

Overview aggregation — `server/learning/orgOverview.js`
- **60 000 ms (60 s) cache** per org, no invalidation. **Refresh** inside that window returns the
  same snapshot.
- **"Active last 30 days"** = the member's newest `completedAt` is within 30×24 h. Opening a lesson
  is *not* activity; finishing one is.
- Members = users whose `organizationId` is the org **or** who are in one of the org's groups,
  minus `isSystem` rows, the `admin` user, and anyone with `status: 'pending'`.
- Exactly **two batched SQL reads** (all progress blobs, all certificate blobs) regardless of org
  size; permissions per member come from a Redis-cached lookup.
- Certificates expose **only** `certificateId`, `level`, `issuedAt` — serials and verify-token
  hashes never leave the server.

Other numbers
- Member catalog response is cached client-side: `Cache-Control: private, max-age=300` (**5 min**).
- AI-coach rate limits: coach/tutor **20 requests/min/user**, quiz grade **60/min**, practice
  generate **10/hour**, practice grade **60/min**; submissions capped at **4000 characters**.
- Save-notice toasts clear after **2500 ms**.
- Built-in catalog: **9 courses**, **26 lesson ids**, **3 certificates**.
- Weekly-review nudge job (`server/jobs/learningNudge.js`): nudges after **7** quiet days, gives up
  after **60**, at most one nudge per user per **14** days, ≤ **500** blobs and ≤ **50**
  notifications per daily tick.
- Meeting templates: name ≤ **120** chars, prompt ≤ **20 000** chars; at most **one default** per
  user, per org and per group (enforced by unique indexes).
- Tier limits (`TIER_LIMITS`) are `-1` (unlimited) for users/agents/messages/KB sources on **every**
  tier — the paid line is *features*, not counts. Per-org caps come from the subscription plan, not
  from the tier.

---

## 6. What happens on failure

| Situation | Result |
|---|---|
| Not signed in | `401 {"error":"Unauthorized"}` (admin routes) / `{"error":"Not authenticated"}` |
| Signed in, not an org admin | `403 {"error":"Organization admin access required"}`; the SPA also hides the Academy row |
| Org admin with no organisation (incl. a super-admin without one) | `400 {"error":"No organization for this account"}` |
| Org lacks `learning_custom_content` but the plan could have it | `403 {"error":"feature_disabled","feature":"learning_custom_content"}` — "ask your admin" |
| Capability outside the plan/licence ceiling | `403 {"error":"feature_locked","feature":…,"required":"enterprise","current":<tier>,"upgrade_url":…}` |
| Entitlement resolution degraded/unavailable | `503 {"error":"entitlement_unavailable","retry_after":1}` with `Retry-After: 1` |
| `learning` module de-imported on the instance | `404 {"error":"not_found"}` — the surface is concealed, not refused |
| Overview aggregation throws | `500 {"error":"Failed to load learning overview"}`; the panel shows **"Could not load the learning overview."** |
| Validation failure while saving | `400` with a human message, shown in red under the editor. Real strings: *"Course title is required"*, *"Lesson title is required"*, *"A lesson needs at least one step"*, *"A lesson can have at most 30 steps"*, *"Slide step 2 needs body text"*, *"Quiz step 2 needs at least 2 choices"*, *"Quiz step 2 needs a correct choice"*, *"Exercise step 3 needs a task"*, *"Exercise step 3 needs at least one rubric criterion"*, *"Step 4 has unsupported type 'tour' (allowed: slide, quiz, exercise)"*, *"An organisation can have at most 50 custom courses"* |
| Publish with no lessons | `400 "A course needs at least one lesson before publishing"` |
| Publish while a referenced lesson is missing | `400 "Lesson orgl-… is missing"` — nothing is published |
| Subscriptions API on a self-hosted install | `404 {"error":"not_available_in_self_hosted"}` |
| Meeting templates without org admin | `403 {"error":"Org admin required"}`; the panel silently hides itself |

Over-length text is **truncated**, not refused (`trimTo`): a 200-character course title is saved as
its first 120 characters without a warning.

---

## 7. Permission / licence gates (exact call sites)

Server
- `server/routes/ai.js:89`
  `router.use('/learning/admin', requireModule('learning'), requireCapability('learning_custom_content'), learningAdminRoutes)`
  — mounted **before** `/learning` on purpose, because `router.use('/learning')` also matches
  `/learning/admin/*`.
- `server/routes/ai.js:100`
  `router.use('/learning', requireModule('learning'), requireCapability('learning_center'), learningRoutes)`
- `server/routes/ai/learningAdmin.js:26` `router.use(requireAuth, requirePrimaryOrgAdmin())` — every
  handler is scoped to `req.primaryOrgId`, **never** to an org id from the body or query.
- `server/routes/ai/learning.js:749`
  `router.get('/org-overview', requireAuth, requirePrimaryOrgAdmin(), …)`
- `server/routes/ai/learning.js:40` inline `hasCapability('learning_custom_content', …)` decides
  whether a member's catalog/achievements include org courses.
- `server/index.js:916`
  `app.use('/api/summary-templates', requireModule('meetingNotes'), requireLicenseFeature('meeting_notes'), …)`
  plus per-route `isOrgAdminForOrg(req, orgId)` for `/org`, create, patch, delete.
- `server/auth/admin/orgRoutes.js` — `GET /auth/organizations` needs one of
  `all|manage_users|admin_security|org_admin`; `GET/PUT /auth/organizations/:id` uses
  `requireOrgAdmin('id')`.
- `server/routes/subscriptions.js` — `GET /orgs/:orgId` is readable by any member of that org
  (`requireAuthOrOrgMember`); lifecycle POSTs need org admin; everything else needs super admin.
- `requirePrimaryOrgAdmin()` (`server/auth/permissions.js:1143`) accepts super admins and any user
  whose `orgRole` passes `isOrgAdminRole` (`org_admin` or the legacy `admin`), resolved from the
  **database**, not the session.

Frontend
- `OrgAcademyPanel.jsx`: `const canAuthor = useCan('learning_custom_content')` — no capability, no
  tabs, Overview only.
- `AdvancedSettings.jsx:347`: `if (s.id === 'org_academy') return canSeeOrg && canUseLearning;`
  with `canUseLearning = useCan('learning_center')` and `canSeeOrg` = permissions
  `all | org_admin` or orgRole `admin | org_admin`.
- `OrganisationSection.jsx:180`: `{activeSection === 'academy' && isOrgAdmin && <OrgAcademyPanel/>}`.
- `components/licensing/Gate.jsx`: `Gate`/`useCan` are **display-only**; the authoritative gate is
  always the server's `requireCapability`.

Licence-tier placement that matters here
- `learning_center` → **community** (so self-hosted installs always keep the Academy; on cloud the
  plan's *Included beta features* list is the authority).
- `learning_custom_content` → a **beta** capability; on self-hosted betas are an enterprise+ benefit,
  on cloud the plan's allowed beta features decide.
- `meeting_notes` → **enterprise**.

---

## 8. How it connects to the rest of the product

- **Member Learning Center** (`/app/settings/learning`, tabs **Curriculum**, **Review**,
  **Achievements**) is the other half: published org courses land in a trailing curriculum column
  headed **"Your organisation"**, earn badges, and are graded by the same AI coach.
- **Users & Groups** supplies the member list the Overview reports on and the groups the Grants
  matrix and group-scoped meeting templates target.
- **Access & Permissions (Grants / Ceiling)** is where a capability is actually switched on.
- **License & Usage / server licence** sets the ceiling those grants are capped by.
- **Usage & Monitoring** shows the AI cost the coach/tutor calls contribute to (they run on the
  `fast` tier and are rate-limited per user).
- **Meeting Notes** consumes the org summary templates; the panel disappears without the
  `meeting_notes` licence feature.
- **Compliance Hub** sits in the same accordion and is the other capability-per-plan surface
  (`compliance_hub_gdpr`), so the gating story generalises.
- **Notification centre**: the weekly-review nudge job pings lapsed learners, which is what makes
  the Overview's *Active last 30 days* move.

---

## 9. Common mistakes

1. **Expecting custom courses in the Overview.** `orgOverview.js` calls
   `completedCourses(progress, visible)` and `computeEarnedBadges(progress, visible)` **without**
   `extraCourses`, and `data.courses` comes from the built-in `COURSES`. So the dots, the course
   filter, *Courses completed* and the **Badges** count cover the **nine built-in courses only** —
   a member who finished the org's own course shows no change there (they do see it in their own
   Achievements).
2. **Pressing Refresh and expecting live data.** The server caches the aggregation for 60 s per org.
3. **Saving a lesson and assuming it is in the course.** Lessons are stored standalone; the course's
   `lessonIds` must be re-saved. The editor does that automatically — a script or MCP caller must do
   `PUT /lessons/new` then `PUT /courses/:courseId` itself, or the lesson is orphaned and never
   publishes.
4. **Editing a draft and telling members it changed.** Nothing reaches members until **Publish**;
   publishing re-snapshots *all* lessons in the course.
5. **Assuming Unpublish deletes.** Unpublish only removes the published snapshots; Delete removes
   drafts, snapshots and the members' access.
6. **Writing the answer into the quiz explanation.** Quiz answer keys and exercise rubrics are
   stripped from the member payload on purpose (`publicLessonView`, server-side grading) — putting
   the answer in **Explanation** or **Instruction** hands it straight to the learner.
7. **Members joined via a group only.** The member catalog resolves org courses from
   `req.session.user.organizationId`; a user whose org membership comes solely from a group has no
   `organizationId` and therefore sees **no** custom courses — even though they *do* appear as a
   member in the Academy Overview (which counts group membership).
8. **Looking for Academy on a phone.** The Organisation accordion is desktop-only.
9. **Looking for License & Usage on self-hosted.** That row is removed; use the admin dashboard's
   server-licence panel.
10. **Confusing "locked 🔒" with "off".** Locked = outside the plan ceiling (needs a plan/licence
    change). Unlocked-but-off = granted to nobody yet (a toggle away).
11. **Typing long titles.** Over-limit text is silently truncated to 120/400/8000 characters.
12. **Trying to add a guided-tour step.** Only `slide`, `quiz` and `exercise` exist for org authors;
    tour steps need code-bound DOM anchors.
13. **Expecting a certificate from custom courses.** By design they never satisfy a certificate rule.
14. **Two default meeting templates in one scope.** A unique index allows exactly one default per
    user / org / group.

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

**A. Procurement — "Inkoopbeleid in Bee Flow" (custom course).**
Inkoopmanager Sanne asks admin Erik for a course teaching buyers how to run the PO-intake routine.
Erik opens **Organisation → Academy → Content → + New course**, titles it *Inkoop: van offerte tot
PO*, level **Beginner**, badge **Inkoop-expert** 🏅. Lesson 1 is three **Slide** steps (policy: three
quotes above € 5 000) and one **Quiz** — *"Vanaf welk bedrag zijn drie offertes verplicht?"* with
choices € 1 000 / € 5 000 / € 10 000 and the **Explanation** pointing at the intranet page. Lesson 2
is an **Exercise**: task *"Schrijf een korte samenvatting van een offerte voor de PO-aanvraag"*,
criteria *noemt leverancier*, *noemt bedrag exclusief btw*, *noemt levertermijn*, pass score **70**,
max attempts **3**. He clicks **Publish**; the eight buyers see it under **Your organisation** in the
Learning Center. Two weeks later he filters the Overview on **Completed: Inkoop: van offerte tot PO**
— and discovers pitfall #1: the dropdown only lists built-in courses, so he checks per-member
badges in their Achievements instead.

**B. HR — onboarding evidence.** HR-adviseur Miriam must show that every new hire finished
*Bee Flow Foundations* in their first month. She opens **Organisation → Academy**, reads
**Members 42**, **Courses completed 118**, **Active last 30 days 31**, picks
**Completed: Bee Flow Foundations** and searches for the three September starters. Two are green;
one shows **Not started**, so she sends a reminder (the nudge job would only ping after 7 quiet
days, and only if they had started at all). For the yearly file she notes who carries the
📜 **Foundations** pill — dates only, no certificate serials, which is what makes the screen
GDPR-safe to share internally.

**C. Sales — a plan upgrade and a meeting template.** Sales lead Joost wants meeting summaries in
the Van Dijk sales format, plus the ability to write a short sales course. Erik opens
**Organisation → License & Usage**, sees the org is on a plan without Meeting Notes, uses
**Change plan** → the confirm dialog shows **Takes effect**, **Prorated charge today**, **Then**
€ x / month. After the upgrade, **Meeting templates** appears: he adds *Sales-gesprek NL* scoped to
the group **Sales**, marks it **Default**. For the course, *Academy Custom Courses (Beta)* is still
🔒 in **Access → Grants** until the new plan's beta list includes it; once it is toggled on for the
group **Sales**, the **Content** tab appears in Academy.

---

## 11. List / read endpoints a "did the learner do it?" check can call

All paths are relative to the API origin (`API_BASE`; the server mounts `/ai`, `/auth` and `/api/*`
at the root). All use the session cookie (`authFetch`).

| Method | Path | Auth / gates | JSON the response contains |
|---|---|---|---|
| GET | `/ai/learning/admin/courses` | session + `requireModule('learning')` + `requireCapability('learning_custom_content')` + org admin | `{ courses: [{ courseId, title, status: 'draft'\|'published', updatedAt }] }` — **org-scoped, no per-row owner field**; the owner is the caller's org (`req.primaryOrgId`) |
| GET | `/ai/learning/admin/courses/:courseId` | same | `{ course: { id, title, desc, icon, level, lessonIds[], badge:{id,title,icon}, updatedAt }, lessons: [{ id, title, desc, icon, estMinutes, steps[], updatedAt }] }` — draft docs, rubrics and answer keys included |
| GET | `/ai/learning/org-overview` | session + org admin (`requirePrimaryOrgAdmin`), inside the `learning_center` mount | `{ orgId, generatedAt, courses:[{id,title,lessonCount}], totals:{members,coursesCompleted,badges,certificatesIssued,activeLast30d}, members:[{ userId, displayName, email, avatar, avatarType, lessonsDone, coursesDone[], badges[], certificates:[{certificateId,level,issuedAt}], lastActivity }] }` — **`userId`/`email` are the per-member owner fields**; 60 s cached |
| GET | `/ai/learning/catalog` | session + `learning_center` | the built-in catalog plus published org courses appended with `source: 'org'`, `id: 'orgc-…'`, sanitized lessons (`serverGraded` quizzes, no rubrics). `Cache-Control: private, max-age=300` |
| GET | `/ai/learning/achievements` | session + `learning_center` | `{ badges: [{ badgeId, courseId, title, earnedAt, version }], certificates: [{ certificateId, title, level, eligible, issued, isPublic, progress, issuedAt?, …urls }], version }` — **caller's own** data only |
| GET | `/ai/user-settings` | session | includes `learningProgress` = `{ [lessonId]: { completedAt … } }` for the **caller only** |
| GET | `/auth/my-entitlements` | session | the entitlements snapshot (tier, effective capability sets, `mode`) + `registry: [{ id, kind, name, description, category, lifecycle, userFacing, licenseFeature, moduleId }]` — use it to assert `learning_custom_content` is effective |
| GET | `/api/license/status` | session (rate-limited) | `{ tier, source, scope, license, subscription, features[], limits{}, serverOverride?, serverLicense }` |
| GET | `/api/subscriptions/orgs/:orgId` | session; any member of that org (super admins any org). **404 on self-hosted** | the subscription row + `effective` limits (incl. `max_cost_per_month`), billing period and usage summary |
| GET | `/auth/organizations` | session + `all \| manage_users \| admin_security \| org_admin`; filtered to the caller's orgs | array of org rows: `id, name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod, encryption_tier…` |
| GET | `/auth/organizations/:id` | `requireOrgAdmin('id')` | one org row (same shape) |
| GET | `/api/summary-templates` | session + `requireModule('meetingNotes')` + `requireLicenseFeature('meeting_notes')` | `{ builtins:[{id,name,nameKey,prompt}], custom:[…], defaultTemplateId, canManageOrg, primaryOrgId }` |
| GET | `/api/summary-templates/org` | same + org admin of the caller's org | `{ orgId, templates: [{ id, scope, name, prompt, userId, organizationId, groupId, isDefault, version, **createdBy**, createdAt, updatedAt }], groups:[{id,name,description}] }` — `createdBy` is the owner field |

Write endpoints (for completeness, not for verification):
`POST /ai/learning/admin/courses`, `PUT /ai/learning/admin/courses/:courseId`,
`DELETE /ai/learning/admin/courses/:courseId`, `PUT /ai/learning/admin/lessons/:lessonId`
(`new` mints an id), `POST /ai/learning/admin/courses/:courseId/publish`,
`POST /ai/learning/admin/courses/:courseId/unpublish`;
`POST|PATCH|DELETE /api/summary-templates[/:id]`; `PUT /auth/organizations/:id`.

**Suggested verification checks**
- *"The admin published a custom course"* → `GET /ai/learning/admin/courses`, expect a row with
  `status === 'published'` (optionally match the title).
- *"The course really has content"* → `GET /ai/learning/admin/courses/:courseId`, expect
  `course.lessonIds.length >= 1` and every returned lesson to have `steps.length >= 1`.
- *"Members can actually see it"* → `GET /ai/learning/catalog` as a member, expect a course with
  `source === 'org'`.
- *"The admin looked at the team overview"* → not observable; check instead that
  `GET /ai/learning/org-overview` returns `members.length > 0` so the lesson step is answerable.
- *"An org meeting template exists"* → `GET /api/summary-templates/org`, expect a row with
  `scope === 'org'` (and `isDefault === true` when the lesson asked for a default).
- *"Organisation Info is filled in"* → `GET /auth/organizations/:id`, expect non-empty `name`,
  `kvk`/`vat` or `address`.
