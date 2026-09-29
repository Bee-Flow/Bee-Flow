import React from 'react';
import { lazy } from '../../../utils/lazyWithReload';
import { Bot, Sparkles, ListChecks, ShieldCheck, BookOpen, Globe, Mic, LayoutGrid, Boxes, Table2, ClipboardList, History, Clapperboard, FileText } from 'lucide-react';

// Studio app registry — the single source of truth for which apps live inside
// the unified Studio shell, in what order, behind which gates, and with which
// props. Studio/index.jsx renders tabs + the active app from this list, and
// studioRoutes.js derives the URL segment ↔ section maps from it.
//
// IMPORT DISCIPLINE: this module is imported (via studioRoutes.js) from
// App.jsx, so it lands in the MAIN chunk. Top-level imports must stay limited
// to react, utils/lazyWithReload and lucide-react — the app components
// themselves may only be referenced inside the lazy() callbacks so each app
// stays a separate on-demand chunk. Enforced by studioApps.test.jsx.

// THREE GATES, ASKING THREE DIFFERENT QUESTIONS. A section is listed only when
// all three say yes, and none of them substitutes for another:
//
//   hasLicenseFeature(id)  does this INSTALLATION have the feature at all
//                          (tier / licence key — see server/license/tiers.js)
//   canUse(id)             is this ORGANISATION in the programme for it
//                          (server-resolved licence × beta intersection)
//   hasPermission(id)      may this PERSON reach it, per the org role assigned
//                          to them in Settings → Users & Groups → Roles
//                          (server/config/orgRoles.json)
//
// The permission layer is the newest of the three: until it existed, every
// section that cleared the licence was visible to everyone who could open
// Studio at all, which meant an organisation had no way to say "our support
// team does not build webpages" short of dropping the licence for everyone.
// Grants ship matching the previous behaviour exactly, so nobody loses a
// section on upgrade.
//
// Feature gate helper — the server-resolved canUseFeature map (licence × beta
// intersection) is authoritative when present; otherwise fall back to the
// legacy permissions/betaFeatures spot-check. `??` (not `||`) so an explicit
// server `false` wins over a stale 'all' permission.
export const makeCanUse = (user) => (id) =>
    !!(user?.canUseFeature?.[id] ?? (user?.permissions?.includes('all') || user?.betaFeatures?.includes(id)));

// ── Categories ────────────────────────────────────────────────────────────
// Studio grew past the length at which a flat list of ten rows is readable,
// so the sidebar panel groups its sections under headings. The grouping is
// declarative here (one `category` per descriptor) rather than hard-coded in
// Sidebar.jsx, so a runtime module can land in a group by declaring one and
// the nav does not have to know its name.
//
// The three groups are the Studio Nav artboard's (Bee Flow Builder redesign,
// Sep 2026): a "make vs. use" taxonomy — everything you MAKE is in Studio,
// split by what kind of thing it is. The fourth group is the repo's, not the
// artboard's: an installed add-on is neither made nor first-party, and the
// artboard's closed twelve-row rail has no slot for one. Without this bucket
// every runtime module section (moduleRuntime/registry.js) would silently
// fall out of the nav while staying fully routable — the one failure mode
// the kritiekronde ruled out.
//
//   build    — what you build, wire together and ship
//              (automations, datatables, apps, webpages, forms)
//   ai       — what the assistant knows and can do
//              (agents, skills, knowledge, meeting notes)
//   bundle   — how the pieces ship together (solutions, and the run log of
//              everything they do)
//   modules  — installed add-ons ("Add-ons" in the UI); the fallback for
//              anything uncategorised. A runtime module MAY declare
//              `category: 'build' | 'ai' | 'bundle'` to file itself under a
//              first-party heading; without one it lands here.
//
// Order here IS the order of the headings; order WITHIN a group follows
// STUDIO_APPS below, so a section only ever declares its place once.
export const STUDIO_CATEGORIES = [
    { id: 'build', labelKey: 'studio.category.build', labelFallback: 'Build' },
    { id: 'ai', labelKey: 'studio.category.ai', labelFallback: 'AI' },
    { id: 'bundle', labelKey: 'studio.category.bundle', labelFallback: 'Bundle' },
    { id: 'modules', labelKey: 'studio.category.modules', labelFallback: 'Add-ons' },
];

// Where a descriptor with no (or an unknown) category ends up. Runtime module
// descriptors predate the field entirely, so this is the common path for them.
// MUST name an id in STUDIO_CATEGORIES — groupStudioApps asserts it (below).
export const DEFAULT_STUDIO_CATEGORY = 'modules';

// True everywhere except a production build. Vite stamps import.meta.env.MODE
// ('development' | 'test' | 'production'); a missing env (plain node) counts
// as non-production so the assertion below also runs under any test runner.
const IS_DEV_OR_TEST = (() => {
    try { return (import.meta.env?.MODE || 'development') !== 'production'; } catch { return true; }
})();

/**
 * Group an already-gated, already-ordered list of Studio descriptors into
 * `[{ category, apps }]`, in STUDIO_CATEGORIES order, skipping empty groups.
 * Pure and import-free so it can live next to the registry.
 *
 * A descriptor with a KNOWN category files under it; anything else — a
 * runtime module without one, a built-in with a typo — files under
 * DEFAULT_STUDIO_CATEGORY. In dev/test the function asserts that every input
 * descriptor landed in exactly one group, so a future category rename can
 * never quietly evict an installed module from the nav: the only way to lose
 * one is DEFAULT_STUDIO_CATEGORY pointing at an id that is not in
 * STUDIO_CATEGORIES, which is a static config error and should fail loudly
 * before it ships. Production keeps rendering whatever it can.
 */
export function groupStudioApps(apps) {
    const known = new Set(STUDIO_CATEGORIES.map((c) => c.id));
    const input = apps || [];
    const groups = STUDIO_CATEGORIES
        .map((category) => ({
            category,
            apps: input.filter((app) => {
                const id = known.has(app.category) ? app.category : DEFAULT_STUDIO_CATEGORY;
                return id === category.id;
            }),
        }))
        .filter((group) => group.apps.length > 0);
    if (IS_DEV_OR_TEST) {
        const placed = groups.reduce((n, g) => n + g.apps.length, 0);
        if (placed !== input.length) {
            const lost = input.filter((app) => !groups.some((g) => g.apps.includes(app))).map((app) => app?.id);
            throw new Error(`groupStudioApps: ${lost.join(', ')} landed in no group — DEFAULT_STUDIO_CATEGORY ('${DEFAULT_STUDIO_CATEGORY}') must be one of STUDIO_CATEGORIES`);
        }
    }
    return groups;
}

// ── Gate resolution: hide vs. lock ────────────────────────────────────────
// Three mechanisms gate a section: the client `gate(ctx)` below, the server
// middleware on the route, and org-role permissions. The rule (kritiekronde,
// Sep 2026): a PERMISSION gate hides the row (today's behaviour — a member
// who may not manage agents should not see a dead door), a LICENCE or
// CAPABILITY gate shows the row disabled with an upgrade hint, so a Community
// org learns what App Studio is instead of never hearing of it. The server
// stays the authority either way.
//
// Which of the two applies is decided by EntitlementsContext.lockReason(id):
// it answers null when the entitlement IS effective (so a failing gate must
// be a permission matter → hide), 'not_granted' when the plan includes it but
// the org has not switched it on (→ "ask an admin"), and 'ceiling' when the
// plan does not include it (→ "upgrade").

/**
 * The gate-passing sections plus the locked ones, each spread with a
 * `locked` field (null | 'not_granted' | 'ceiling' | <reason>). A descriptor
 * opts into locking with `lockOn: 'disable'` and names the entitlement to
 * ask about in `gateCapability`; everything else keeps hiding on a failed
 * gate. `hiddenFromNav` is NOT applied here — it is a nav concern the caller
 * keeps (Approvals stays routable and its own top-level row).
 *
 * ctx is the same object gate() receives, plus `lockReason(id)`.
 */
export function resolveStudioNav(apps, ctx) {
    const out = [];
    for (const app of apps || []) {
        let passes = false;
        try { passes = !!app.gate(ctx); } catch { passes = false; }
        if (passes) { out.push({ ...app, locked: null }); continue; }
        if (app.lockOn !== 'disable' || !app.gateCapability) continue;
        let reason = null;
        try { reason = ctx?.lockReason ? ctx.lockReason(app.gateCapability) : null; } catch { reason = null; }
        if (!reason) continue; // entitled but gated for another reason → hide
        out.push({ ...app, locked: reason });
    }
    return out;
}

/**
 * Where the Studio row itself lands: the first listed section that is not
 * locked — a locked row is a signpost, not a door. `fallback` is used when
 * every section is locked (or there are none).
 */
export function firstOpenStudioSection(sections, fallback) {
    return (sections || []).find((s) => s && !s.locked) || fallback;
}

/**
 * The one-line hint a locked row and a locked "New" item carry. `t` is the
 * app's translator (passed in so this file stays import-free).
 */
export function studioLockHint(reason, t) {
    if (reason === 'not_granted') return t('studio.locked_not_granted', 'Not switched on for your organisation — ask an admin');
    // 'training' carries its own hint (which course, and how far along), built
    // by hooks/useTrainingGates.trainingLockHint — this is only the fallback.
    if (reason === 'training') return t('studio.locked_training', 'Finish the required course first');
    return t('studio.locked_upgrade', 'Available on a higher plan');
}

/**
 * `trainingArea` — which "finish the course first" rule a section's CREATE
 * action falls under (server/learning/trainingGates.js).
 *
 * Deliberately NOT part of `gate`. A licence lock hides or disables the whole
 * section; a training rule never does. Someone who has not finished the agents
 * course still opens Agents, reads what colleagues built and talks to them —
 * the rule only reaches the New menu and the create buttons. Folding it into
 * the gate would blank the very screens the course is about.
 */
export function studioTrainingArea(app) {
    return app?.trainingArea || null;
}

// ── Create actions shared by the "New" menu ───────────────────────────────
// Every onCreate below is a LAZY callback: the module it needs is imported
// inside the call, never at the top of this file (import discipline above).
// Navigation-only creates take the section's own "new" route so the section
// keeps owning its dialog; creates that today happen without a dialog
// (Skills' createEmpty) post first and open the result, exactly as the
// section does.
const navigateTo = (target) => ({ onNavigate }) => { if (onNavigate) onNavigate(target); };

// A fresh automation row: the same body BuilderShell.ensureAutomationCreated
// posts on first save (title + a manual-trigger graph shaped like the
// server's emptyDefinition), so the builder opens on a document it already
// understands. `trigger` lets the Form item swap in a form trigger.
export async function createAutomationDraft({ onNavigate, t }, { title, trigger } = {}) {
    const { API_BASE, authFetch } = await import('../../../utils/helpers');
    const res = await authFetch(`${API_BASE}/api/automation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: title || t('studio.new.untitled_automation', 'Untitled automation'),
            definition: {
                schemaVersion: 1,
                trigger: trigger || { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
                steps: [],
                edges: [],
                vars: {},
            },
        }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    const body = await res.json();
    const id = body?.automation?.id || body?.id;
    if (id && onNavigate) onNavigate(`studio/automations/${id}`);
    return id;
}

// "New form" — an automation with a form TRIGGER, and nothing else.
//
// THE DEVIATION, in the one place a reader will look for it: a form is not an
// object of its own in this product, so there is no form editor to open and
// the Forms section (below) is a directory rather than an editor. The
// declaration a visitor fills in lives on the routine's trigger
// (`trigger.kind === 'form'`, `trigger.form`); the pages after page one are
// `form_page` STEPS in the same routine; and the public ADDRESS is a row in
// `automation_form_pages` the server mints on save (crud.js's
// ensureFormPages), never something the client creates. Three places, one
// routine — which is why "new form" is "new automation" and why editing one
// means opening the builder.
//
// `defaultFormDeclaration` lives with the builder and is import()ed at CALL
// time, so this module does not drag the builder chunk into the main one.
//
// `collect: true` asks the server to make the form's ANSWERS TABLE on the
// same POST (automation/formAnswers) — the "just a form" of Studio → Forms.
// `title` names both the routine and the form. Navigation is the caller's
// when `onNavigate` is null (the New-form dialog lands on the Form page,
// not the builder).
export async function createFormAutomation(ctx, { title = null, collect = false } = {}) {
    const { defaultFormDeclaration } = await import('../../automation/Builder/flow/settings/FormBuilderFields');
    const form = defaultFormDeclaration();
    const name = title || ctx.t('studio.new.untitled_form', 'Untitled form');
    return createAutomationDraft(ctx, {
        title: name,
        trigger: { id: 'trg', type: 'trigger', kind: 'form', form: { ...form, title: title || form.title, ...(collect ? { collect: true } : {}) }, output: {} },
    });
}

// Descriptor shape:
//   id             — Studio section key (state / <Studio section=...> value)
//   urlSegment     — canonical /app/studio/<segment> slug
//   legacySegments — extra accepted URL/navigation aliases (id itself is
//                    always accepted too — see studioRoutes.js)
//   labelKey       — i18n key for the tab label
//   labelFallback  — literal fallback when the key resolves empty (only the
//                    tabs that historically had one — keeps t() output exact)
//   descKey        — i18n key for the one-line description shown in the
//   descFallback     sidebar's Studio flyout panel (see Sidebar.jsx)
//   Icon           — lucide icon for the tab
//   kind           — shared/kindColors.js key ('automation' | 'datatable' |
//                    'app' | 'webpage' | 'agent' | 'skill' | 'kb' |
//                    'meeting' | 'playbook' | 'solution'); tints the row glyph and the
//                    "New" item. Absent on a section that is not a kind
//                    (Approvals) and on runtime modules, which render neutral.
//   countKey       — key in GET /api/studio/counts this section's row count
//                    reads (defaults to `id`; aiTasks reads `automations`).
//                    No key → no count, which is what a runtime module gets.
//   category       — STUDIO_CATEGORIES id; the heading the sidebar files this
//                    section under (defaults to DEFAULT_STUDIO_CATEGORY)
//   hiddenFromNav  — true keeps the section routable and renderable but out of
//                    the sidebar's Studio panel (it has its own entry there)
//   moduleId       — informational link to the admin modules registry
//   gate(ctx)      — tab visibility; ctx = { user, hasLicenseFeature,
//                    hasPermission, canUse, can, lockReason }:
//                      hasLicenseFeature(f) — LicenseContext.hasFeature
//                      hasPermission(p)     — org-role permission resolver
//                      canUse(id)           — makeCanUse(user): the server's
//                                             canUseFeature map (licence × beta)
//                      can(id)              — EntitlementsContext.can: the
//                                             unified effective set — the SAME
//                                             set the server's
//                                             requireCapability(id) enforces
//                      lockReason(id)       — EntitlementsContext.lockReason
//                                             (see resolveStudioNav above)
//                    The active section still renders when its gate is false
//                    (the server 403s the data).
//   gateCapability — the entitlement id lockReason() is asked about when the
//                    gate fails (mirrors the runtime descriptor's field)
//   lockOn         — 'hide' (default: a failed gate removes the row, today's
//                    behaviour) | 'disable' (a failed LICENCE/CAPABILITY gate
//                    shows the row disabled with an upgrade hint; a failed
//                    permission gate still hides — see resolveStudioNav)
//   create         — the section's entry in the universal "New" menu:
//                    { labelKey, labelFallback, kind?, onCreate(ctx) } where
//                    onCreate is a LAZY callback (any module it needs is
//                    import()ed inside the call — see the import discipline
//                    above) and ctx = { onNavigate, t, user }. Absent → the
//                    section has no "New" item (runtime modules, Approvals).
//   Component      — lazy-loaded app component
//   getProps(ctx)  — props passed to the app; ctx additionally carries
//                    setEditing (per-app fullscreen-editing reporter)
export const STUDIO_APPS = [
    {
        id: 'agents',
        trainingArea: 'agents',
        urlSegment: 'agents',
        labelKey: 'studio.tab.agents',
        descKey: 'studio.tab.agents_desc',
        descFallback: 'Create and manage your agents',
        Icon: Bot,
        kind: 'agent',
        category: 'ai',
        // No licence — agents are Community — but an organisation still decides
        // WHO builds them, from Settings → Users & Groups → Roles.
        gate: ({ hasPermission }) => hasPermission('manage_agents'),
        // AgentStudio's own "new" entry (createDraft) has no route of its own
        // yet; the section root is where its wizard landing lives.
        create: { labelKey: 'studio.new.agent', labelFallback: 'Agent', onCreate: navigateTo('studio/agents') },
        Component: lazy(() => import('../../agents/AgentStudio/index')),
        getProps: ({ user, initialAgentId, onClose, onNavigate, hasPermission, setEditing }) => ({
            user,
            initialAgentId,
            onClose,
            onNavigate,
            hasPermission,
            onEditingChange: setEditing,
        }),
    },
    {
        id: 'skills',
        trainingArea: 'skills',
        urlSegment: 'skills',
        labelKey: 'studio.tab.skills',
        descKey: 'studio.tab.skills_desc',
        descFallback: 'Reusable abilities for your agents',
        Icon: Sparkles,
        kind: 'skill',
        category: 'ai',
        // Mirrors the mount: /api/skills sits behind requireCapability('skills')
        // (server/index.js), and `skills` is a COMPOUND capability — Community
        // licence AND the beta opt-in (core/entitlements/betaFeatures.js). The
        // row used to be `() => true`, so an org that never enabled the beta
        // saw a Skills section whose list silently 403'd into "no skills yet".
        // ctx.can resolves the same effective set the server enforces.
        // hasPermission adds the org-role layer on top: the organisation
        // decides WHO builds skills (Settings → Users & Groups → Roles).
        gate: ({ can, hasPermission }) => can('skills') && hasPermission('manage_skills'),
        gateCapability: 'skills',
        lockOn: 'disable',
        // SkillsStudio.createEmpty, verbatim: post an untitled skill, open it.
        create: {
            labelKey: 'studio.new.skill',
            labelFallback: 'Skill',
            onCreate: async ({ onNavigate, t }) => {
                const { API_BASE, authFetch } = await import('../../../utils/helpers');
                const res = await authFetch(`${API_BASE}/api/skills`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: t('skills_studio.untitled', 'Untitled skill'),
                        description: '', instructions: '', workflow: '', rules: '', examples: '',
                        icon: '⚡', isShared: false, dynamicActivation: false,
                        sharedGroups: [], enabledIntegrations: [],
                    }),
                });
                if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
                const created = await res.json();
                if (created?.id && onNavigate) onNavigate(`studio/skills/${created.id}`);
            },
        },
        Component: lazy(() => import('./SkillsStudio')),
        getProps: ({ user, initialSkillId, onNavigate, hasPermission }) => ({
            user,
            initialSkillId,
            onNavigate,
            hasPermission,
        }),
    },
    {
        id: 'knowledge',
        trainingArea: 'knowledge',
        urlSegment: 'knowledge',
        labelKey: 'studio.tab.knowledge',
        descKey: 'studio.tab.knowledge_desc',
        descFallback: 'Knowledge bases your AI can search',
        Icon: BookOpen,
        kind: 'kb',
        category: 'ai',
        // No licence gate (Knowledge is Community), but the organisation
        // decides WHO manages bases, per role.
        gate: ({ hasPermission }) => hasPermission('manage_knowledge'),
        // KnowledgeStudio treats the 'new' id as "create one and open it",
        // so this stays a plain navigation.
        create: { labelKey: 'studio.new.knowledge', labelFallback: 'Knowledge base', onCreate: navigateTo('studio/knowledge/new') },
        Component: lazy(() => import('./KnowledgeStudio')),
        getProps: ({ user, initialKbId, initialKbTab, initialSourceId, onNavigate, hasPermission }) => ({
            user,
            initialKbId,
            // The open tab and the open source travel in the URL, so both
            // are deep-linkable: "look at what still uses this" and "these
            // two files were skipped" are links people send each other.
            initialKbTab,
            initialSourceId,
            onNavigate,
            hasPermission,
        }),
    },
    {
        // The section id stays 'aiTasks': it is the key the whole navigation
        // layer (studioRoute.section, AgentHub's initialTaskId wiring, the
        // builder's query state) is written against. Only the name and the URL
        // change — the tab is the Automations builder and nothing else now that
        // prompt tasks live in Cowork and agent routines are managed from the
        // agent that owns them.
        id: 'aiTasks',
        trainingArea: 'automations',
        urlSegment: 'automations',
        legacySegments: ['routines', 'ai-tasks'],
        labelKey: 'studio.tab.automations',
        labelFallback: 'Automations',
        descKey: 'studio.tab.automations_desc',
        descFallback: 'Multi-step routines that run for you',
        Icon: ListChecks,
        kind: 'automation',
        countKey: 'automations',
        category: 'build',
        // There is no URL that opens an EMPTY builder (a fresh builder is
        // builderAutomationId '' with no route), so this creates the row the
        // builder would have created on first save and opens it.
        create: { labelKey: 'studio.new.automation', labelFallback: 'Automation', onCreate: (ctx) => createAutomationDraft(ctx) },
        // BFSF-226: this tab was previously shown unconditionally, so
        // restricted/Free-tier orgs saw a feature the backend 403s and the
        // admin panel flags as "Blocked". Now that the tab is only the
        // Automations builder, `automations` is the whole gate: an org with
        // agent_routines but no automations used to land on the second segment,
        // and that segment is gone. Their agent routines are managed from the
        // agent that owns them, and a deep link still renders (the registry
        // only gates the tab, not the section).
        gate: ({ hasLicenseFeature, canUse, hasPermission }) =>
            hasLicenseFeature('automations') && canUse('automations') && hasPermission('use_automations'),
        // Locks like the other licensed rows (a Community org learns the
        // section exists) rather than hiding. A failed PERMISSION leg still
        // hides: lockReason() answers null when the entitlement is effective,
        // so resolveStudioNav drops the row instead of disabling it.
        gateCapability: 'automations',
        lockOn: 'disable',
        Component: lazy(() => import('../../automation/index')),
        getProps: ({ user, initialTaskId, initialStepId, initialFlowletKey, initialBuilderView, initialRunId, initialRunStepId, initialFrom, onClose, onNavigate, modelTiers, setEditing }) => ({
            initialTaskId,
            initialStepId,
            initialFlowletKey,
            initialBuilderView,
            initialRunId,
            initialRunStepId,
            initialFrom,
            onClose,
            onNavigate,
            modelTiers,
            embedded: true,
            user,
            onEditingChange: setEditing,
        }),
    },
    {
        // The decision surface for approval steps. Deliberately its own tab
        // rather than a corner of the builder: the person deciding is often
        // not the person who built the routine, and must never need the
        // canvas to say yes.
        id: 'approvals',
        urlSegment: 'approvals',
        labelKey: 'studio.tab.approvals',
        labelFallback: 'Approvals',
        descKey: 'studio.tab.approvals_desc',
        descFallback: 'Requests waiting on a person, and every past decision',
        Icon: ShieldCheck,
        category: 'build',
        // NOT in the Studio panel. Deciding is a member act, not a builder
        // one, so Approvals has its own top-level sidebar row (Sidebar.jsx,
        // coreNav) — listing it here as well put the same destination in two
        // places one hover apart. The section stays fully routable: the
        // sidebar row, the notification bell and every e-mail deep link land
        // on /app/studio/approvals, and the shell renders it from this
        // descriptor exactly as before.
        hiddenFromNav: true,
        // Its OWN licence key, not the Automations one: building a routine is
        // free (n8n-style), routing its decision past a colleague is the paid
        // collaboration layer — the same line `automation_sharing` draws.
        //
        // `hasLicenseFeature` ALONE, unlike the beta-backed tabs above and
        // below: `approvals` is a pure CORE capability, and canUse reads
        // user.canUseFeature, which loginRoutes builds only from the COMPOUND
        // (beta + licenceFeature) registry — so canUse('approvals') is
        // undefined for every ordinary member and ANDing it would hide the tab
        // from the whole org. hasLicenseFeature resolves through
        // EntitlementsContext against effective.core, the same set the server's
        // requireCapability('approvals') enforces, so the two cannot drift.
        // Notebooks/Projects in Sidebar.jsx are gated the same way.
        //
        // Hiding the tab is only cosmetic: a deep link still renders, and
        // ApprovalsStudio itself shows the upgrade panel — except for a link to
        // ONE approval, which stays open so a lapsed org can still finish
        // decisions already pending (the server's drain exemption).
        gate: ({ hasLicenseFeature, hasPermission }) =>
            hasLicenseFeature('approvals') && hasPermission('use_approvals'),
        Component: lazy(() => import('./Approvals/ApprovalsStudio')),
        getProps: ({ user, initialApprovalId }) => ({
            user,
            initialApprovalId,
        }),
    },
    {
        // Datatables — the rows routines keep BETWEEN runs, and share with each
        // other. Its own section rather than a panel inside the builder because
        // a table outlives the routine that made it and is usually read by a
        // different one: you cannot manage the shape of shared org data from
        // inside a single document, and the "Used by" list is precisely the
        // thing no canvas can show you.
        id: 'datatables',
        trainingArea: 'datatables',
        urlSegment: 'datatables',
        labelKey: 'studio.tab.datatables',
        labelFallback: 'Datatables',
        descKey: 'studio.tab.datatables_desc',
        descFallback: 'Rows your routines keep between runs',
        Icon: Table2,
        kind: 'datatable',
        category: 'build',
        // DatatablesStudio owns its NewDatatableDialog (name + scope); the
        // "new" id is the section's cue to open it.
        create: { labelKey: 'studio.new.datatable', labelFallback: 'Table', onCreate: navigateTo('studio/datatables/new') },
        // Mirrors the Automations tab exactly, because it mirrors the server:
        // /api/datatables is mounted behind requireModule('automation') +
        // requireLicenseFeature('automations'). SHARING a table is the separate
        // paid line (automation_sharing) and is refused per-request, not here —
        // gating the whole tab on it would hide a lapsed org's own tables from
        // them, and reading your own rows must never stop working.
        gate: ({ hasLicenseFeature, canUse, hasPermission }) =>
            hasLicenseFeature('automations') && canUse('automations') && hasPermission('use_datatables'),
        // Same lock as Automations: one entitlement, one hint. A failed
        // permission leg still hides (lockReason is null when entitled).
        gateCapability: 'automations',
        lockOn: 'disable',
        Component: lazy(() => import('./Datatables/DatatablesStudio')),
        getProps: ({ user, initialDatatableId, initialDatatableTab, onNavigate, hasPermission }) => ({
            user,
            initialDatatableId,
            initialDatatableTab,
            onNavigate,
            hasPermission,
        }),
    },
    // Cowork used to be a tab here, duplicating the sidebar's Work page: one
    // could edit and show run history, the other could create. It is now a
    // single top-level page at /app/cowork, and /app/studio/cowork/:id
    // resolves there (see pageFromPath in AuthedApp).
    {
        id: 'webpages',
        trainingArea: 'webpages',
        urlSegment: 'webpages',
        labelKey: 'studio.tab.webpages',
        labelFallback: 'Webpages',
        descKey: 'studio.tab.webpages_desc',
        descFallback: 'Design and publish public webpages',
        Icon: Globe,
        kind: 'webpage',
        category: 'build',
        // Licence feature is authoritative. canUseFeature is the server-derived
        // intersection of licence × beta and includes webpages automatically
        // when the tier matches, but we re-check the licence explicitly so a
        // stale session can't keep the tab visible after a downgrade.
        // Personal webpages are Community since the enterprise split
        // (2026-10), so this row opens on a Community org; SHARING a page is
        // the separate Enterprise capability `webpage_sharing`, locked inside
        // the section (pages/webpages/webpageSharingLock.ts), not here.
        gate: ({ hasLicenseFeature, canUse, hasPermission }) =>
            hasLicenseFeature('webpages') && canUse('webpages') && hasPermission('use_webpages'),
        gateCapability: 'webpages',
        lockOn: 'disable',
        // Webpages asks for a name first: "new" is the cue to open the list
        // with the create form (WebpagesPage.NEW_WEBPAGE_ID), not a webpage id.
        create: { labelKey: 'studio.new.webpage', labelFallback: 'Webpage', onCreate: navigateTo('studio/webpages/new') },
        Component: lazy(() => import('../../../pages/WebpagesPage')),
        getProps: ({ user, initialWebpageId, onNavigate, hasPermission }) => ({
            user,
            initialWebpageId,
            onWebpageChange: (id) => onNavigate && onNavigate(id ? `studio/webpages/${id}` : 'studio/webpages'),
            embedded: true,
            hasPermission,
        }),
    },
    {
        // Documents — printable artefacts: invoices, quotes, letters. The
        // sibling of Webpages and deliberately next to it, because "is this
        // thing visited or printed?" is the one question that decides which of
        // the two you want, and the model is told to choose between them too.
        //
        // Enterprise since the enterprise split (2026-10): `studio_documents`,
        // a GA capability whose id is its licence feature, so ctx.can resolves
        // the same effective set the server's requireCapability does. It locks
        // rather than hides, like the other licensed rows. The lock is about
        // MAKING and CHANGING: the server keeps reading, downloading and
        // archiving open without it, and the page itself (reached from a chat
        // link or its address) shows existing documents read-only.
        id: 'documents',
        urlSegment: 'documents',
        labelKey: 'studio.tab.documents',
        labelFallback: 'Documents',
        descKey: 'studio.tab.documents_desc',
        descFallback: 'Invoices, quotes and letters — editable by hand, downloadable as PDF',
        Icon: FileText,
        kind: 'document',
        category: 'build',
        // The capability alone, no org-role leg: there is no documents role
        // permission, and a failed gate is therefore always a licence matter
        // (locked, never hidden).
        gate: ({ can }) => can('studio_documents'),
        gateCapability: 'studio_documents',
        lockOn: 'disable',
        create: { labelKey: 'studio.new.document', labelFallback: 'Document', onCreate: navigateTo('studio/documents') },
        Component: lazy(() => import('../../../pages/documents/DocumentsPage')),
        getProps: ({ initialDocumentId, onNavigate }) => ({
            initialDocumentId,
            onDocumentChange: (id) => onNavigate && onNavigate(id ? `studio/documents/${id}` : 'studio/documents'),
        }),
    },
    // Security Scan is no longer a built-in Studio app: it ships as a
    // downloadable module (Modules → Marketplace) and its Studio tab is supplied
    // at runtime by the module registry (moduleRuntime/registry.js) after install.
    // Support Studio is no longer a Studio section. Its components still ship
    // (the guided demo mounts them) but the tab is gone: the shared support
    // inbox people actually use is the one in the ADMIN dashboard
    // (components/support/SupportInboxPanel, `admin_support`), and carrying a
    // second, near-identical inbox in the builder's menu only split the
    // audience. Nothing about the admin surface changed.
    {
        id: 'apps',
        trainingArea: 'apps',
        urlSegment: 'apps',
        labelKey: 'studio.tab.apps',
        labelFallback: 'Apps',
        descKey: 'studio.tab.apps_desc',
        descFallback: 'Build and publish internal apps',
        Icon: LayoutGrid,
        kind: 'app',
        category: 'build',
        // App Studio — Enterprise, GA (auto-on; org admin may disable), gated
        // like Webpages: licence × capability via canUseFeature. GA removed
        // the per-org beta opt-in, so canUse now resolves true for every
        // Enterprise org by default. NOTE the capability id is app_studio
        // (plain `apps` is the marketplace); only the tab label says "Apps".
        // manage_apps is the org-role layer on top: who in the org may BUILD
        // apps (consuming a published one is the sidebar's Apps row instead).
        gate: ({ hasLicenseFeature, canUse, hasPermission }) =>
            hasLicenseFeature('app_studio') && canUse('app_studio') && hasPermission('manage_apps'),
        gateCapability: 'app_studio',
        lockOn: 'disable',
        // AppList's NewAppModal (blank or from a template); "new" is its cue.
        create: { labelKey: 'studio.new.app', labelFallback: 'App', onCreate: navigateTo('studio/apps/new') },
        Component: lazy(() => import('./AppStudio')),
        getProps: ({ initialStudioAppId, onNavigate, setEditing }) => ({
            initialAppId: initialStudioAppId,
            onNavigate,
            onEditingChange: setEditing,
        }),
    },
    {
        // Forms — the directory of every form PUBLISHED in the organisation
        // (GET /api/automation/forms), and the only place the public address
        // of one can still be found now that the builder stopped showing it.
        //
        // A DIRECTORY, NOT AN EDITOR — see createFormAutomation above for why
        // (a form has no document of its own). Two consequences are visible
        // from here:
        //
        //   THE `/:id` SEGMENT IS THE ROUTINE'S ID, NEVER THE PAGE TOKEN. The
        //   only id a form ROW has of its own is its public URL token — its
        //   whole credential — so `/app/studio/forms/<automationId>[/<tab>]`
        //   (the Form page: Questions · Share · Answers · Settings) is keyed
        //   by the routine behind the form, an ordinary id. The token still
        //   never travels: not in a route, not in the history, and not in
        //   utils/studioRecentSources.js (whose sub-panel navigates to
        //   `studio/<segment>/<item.id>` — Forms stays out of it).
        //
        //   NO STUDIO SEARCH ENTRY either (routes/studio/search.js has no
        //   `forms` kind). Should one ever be added, the id it returns is the
        //   AUTOMATION's, never the page token.
        //
        // NOT `hiddenFromNav`, even though the sidebar already has a Forms
        // row. That row is the CONSUMER directory (/app/forms,
        // pages/forms/FormsHomePage.jsx) — where a colleague goes to fill a
        // form in — and this is the builder's. Approvals is hidden because its
        // two entrances led to the SAME place; this is the Apps arrangement
        // instead (Sidebar.jsx's `apps` row → /app/apps, beside Studio → Apps),
        // where the two rows are two audiences and two destinations. On
        // /app/studio* the rail replaces the sidebar entirely, so only one of
        // the two is ever on screen there anyway.
        id: 'forms',
        trainingArea: 'automations',
        urlSegment: 'forms',
        // `sidebar.forms`, not a new `studio.tab.forms` beside it: the key
        // already exists, already says "Forms", and already labels this exact
        // destination on the sidebar's own Forms row. I18N-CONVENTIES §1.3
        // puts reuse first and forbids a second key with the same text — and
        // this one is additionally FROZEN (it feeds mobile's More tab through
        // features/settings/sitemap.ts), so it cannot be renamed out from
        // under this row.
        labelKey: 'sidebar.forms',
        labelFallback: 'Forms',
        descKey: 'studio.tab.forms_desc',
        descFallback: 'Published forms, and what they start',
        Icon: ClipboardList,
        kind: 'form',
        countKey: 'forms',
        category: 'build',
        // The SAME gate as Automations and Datatables, because it mirrors the
        // same mount: /api/automation is behind requireModule('automation') +
        // requireLicenseFeature('automations'), and GET /forms carries no gate
        // of its own. One entitlement, one lock, one hint.
        gate: ({ hasLicenseFeature, canUse, hasPermission }) =>
            hasLicenseFeature('automations') && canUse('automations') && hasPermission('use_automations'),
        gateCapability: 'automations',
        lockOn: 'disable',
        // "New form" opens the section's own dialog (name + what happens
        // with the answers) instead of posting straight away: the choice to
        // collect answers in a table is made BEFORE the routine exists.
        create: { labelKey: 'studio.new.form', labelFallback: 'Form', onCreate: navigateTo('studio/forms/new') },
        Component: lazy(() => import('./Forms/FormsStudio')),
        getProps: ({ user, initialFormId, initialFormTab, onNavigate, hasPermission }) => ({
            user, initialFormId, initialFormTab, onNavigate, hasPermission,
        }),
    },
    {
        // Playbooks — a phased AI build the user watches and consents to phase
        // by phase: a table, a routine that fills it, an app on top, an
        // approval flow. It COMPOSES a table + routine + app, so it sits in
        // Bundle next to Solutions (which packages them afterwards), first in
        // that group as the door in. A playbook owns a routine AND an app, so
        // the gate needs both feature/capability pairs; the lock hint asks
        // about the higher ceiling (app_studio).
        id: 'playbooks',
        trainingArea: 'playbooks',
        urlSegment: 'playbooks',
        labelKey: 'studio.tab.playbooks',
        labelFallback: 'Playbooks',
        descKey: 'studio.tab.playbooks_desc',
        descFallback: 'Watch the AI build a table, a routine and an app — one phase at a time',
        Icon: Clapperboard,
        kind: 'playbook',
        category: 'bundle',
        gate: ({ hasLicenseFeature, canUse }) => hasLicenseFeature('automations') && canUse('automations') && hasLicenseFeature('app_studio') && canUse('app_studio'),
        gateCapability: 'app_studio',
        lockOn: 'disable',
        create: { labelKey: 'studio.new.playbook', labelFallback: 'Playbook', onCreate: navigateTo('studio/playbooks/new') },
        Component: lazy(() => import('./Playbooks/PlaybooksStudio')),
        getProps: ({ user, initialPlaybookId, onNavigate, hasPermission, setEditing }) => ({ user, initialPlaybookId, onNavigate, hasPermission, onEditingChange: setEditing }),
    },
    {
        // Solutions — the builder's view of a project: the routines, apps and
        // webpages that work together, the wiring between them, and the
        // Blueprint you package it into. The same project's COLLABORATION side
        // (chats, members, memory) stays on /app/projects — this tab is for
        // whoever builds the thing, which is why it lives next to the tabs it
        // bundles. Gate mirrors Approvals: the licence key alone is
        // authoritative ('projects' is Enterprise and not beta-gated, so a
        // canUse check would hide the tab from ordinary members).
        id: 'solutions',
        trainingArea: 'playbooks',
        urlSegment: 'solutions',
        labelKey: 'studio.tab.solutions',
        labelFallback: 'Solutions',
        descKey: 'studio.tab.solutions_desc',
        descFallback: 'Bundle routines, apps and webpages into one installable Solution',
        Icon: Boxes,
        kind: 'solution',
        category: 'bundle',
        gate: ({ hasLicenseFeature, hasPermission }) =>
            hasLicenseFeature('projects') && hasPermission('use_solutions'),
        // Locked, not hidden, on Community: the row is how an org learns
        // Solutions exist. Packaging/exporting inside stays behind the
        // separate Enterprise key (blueprint_packaging) the section enforces.
        // A failed use_solutions PERMISSION still hides the row (lockReason is
        // null when the licence is in place).
        gateCapability: 'projects',
        lockOn: 'disable',
        // SolutionsStudio's NewSolutionForm asks for a name; "new" is its cue.
        create: { labelKey: 'studio.new.solution', labelFallback: 'Solution', onCreate: navigateTo('studio/solutions/new') },
        Component: lazy(() => import('./Solutions/SolutionsStudio')),
        getProps: ({ user, initialSolutionId, onNavigate }) => ({
            user,
            initialSolutionId,
            onNavigate,
        }),
    },
    {
        // Runs & log — every time a routine fired, and the "Now running · last
        // 24 hours" strip above it (Studio.dc.html 1a).
        //
        // FILED UNDER "BUNDLE", not "build", and last: the Studio Nav artboard
        // draws it there, under Solutions, and the reason holds — every other
        // row in the rail is a thing you make, this one is what those things
        // DID. It is the only row that is about the past.
        //
        // ── Three ways it is not like its neighbours ──────────────────────
        //
        // NO `kind`. A run is not one of the ten things you build
        // (shared/kindColors.js), so the rail draws its glyph in the neutral
        // ink — exactly as the artboard does, and as Solutions' own container
        // glyph does. Inventing a kind to satisfy a lint would put a colour on
        // the rail that means nothing anywhere else in the product.
        //
        // NO `create`. You cannot make a run; you make a routine and it runs.
        // The "New" menu skips a section without a create entry, which is the
        // behaviour Approvals already relies on.
        //
        // NO `/:id` SEGMENT. A single run is deep-linked with `?run=<id>` on
        // this section's own URL — the query-string state the builder already
        // uses (studioRoutes.js's parseStudioQuery), not a path segment — so
        // one address shape covers "the log" and "this run inside it".
        //
        // A COUNT, which the artboard does not draw (a deviation, and a small
        // one): `counts.runs` is the caller's own runs in the last 24 hours —
        // the same window and the same scope the section opens on. Every other
        // number on the rail counts things that exist; this one counts what
        // happened, and routes/studio/counts.js says so where it is computed.
        id: 'runs',
        urlSegment: 'runs',
        // `runs.*` is the greenfield namespace this subject owns
        // (.claude/handoff/I18N-CONVENTIES.md §1.2); the old
        // `routines.runs.*` keys are folded into it by the RUN retrofit.
        // Until the dictionaries' turn comes round (§3) the label renders
        // through its fallback — studioApps.test.jsx carries that as written
        // debt rather than as silence.
        labelKey: 'runs.title',
        labelFallback: 'Runs & log',
        descKey: 'runs.tab_desc',
        descFallback: 'Every time a routine fired, and what happened',
        Icon: History,
        countKey: 'runs',
        category: 'bundle',
        // The same gate as Automations, Datatables and Forms, because it is the
        // same mount: /api/automation behind requireModule('automation') +
        // requireLicenseFeature('automations'). Seeing the organisation's runs
        // instead of your own is a further permission (manage_automations) and
        // is checked by the SERVER, per request — never here. A client-side
        // guess would either hide the switch from someone who has the
        // permission (a stale permission list) or predict a refusal the person
        // can do nothing about.
        gate: ({ hasLicenseFeature, canUse }) =>
            hasLicenseFeature('automations') && canUse('automations'),
        gateCapability: 'automations',
        lockOn: 'disable',
        Component: lazy(() => import('./Runs/RunsStudio')),
        getProps: ({ onNavigate, initialRunId, initialRunStepId, setEditing }) => ({
            onNavigate,
            initialRunId,
            initialRunStepId,
            onEditingChange: setEditing,
        }),
    },
    {
        id: 'meetingNotes',
        trainingArea: 'meeting_notes',
        urlSegment: 'meeting-notes',
        labelKey: 'studio.tab.meeting_notes',
        labelFallback: 'Meeting Notes',
        descKey: 'studio.tab.meeting_notes_desc',
        descFallback: 'Transcripts, speakers and actions',
        Icon: Mic,
        kind: 'meeting',
        category: 'ai',
        // Meeting Notes is enterprise + beta opt-in (mirrors webpages/tests).
        // We intentionally rely on canUseFeature (server-resolved licence ×
        // beta) rather than spot-checking betaFeatures so super-admin grants
        // flow correctly down to ordinary org members.
        gate: ({ hasLicenseFeature, canUse, hasPermission }) =>
            hasLicenseFeature('meeting_notes') && canUse('meeting_notes') && hasPermission('use_meeting_notes'),
        gateCapability: 'meeting_notes',
        lockOn: 'disable',
        // ONE item for record-or-upload: creation here is the capture flow
        // (MeetingNotesPage → openCapture), not a new empty thing. "new" is the
        // page's cue to open it.
        create: { labelKey: 'studio.new.meeting', labelFallback: 'Record or upload a meeting', onCreate: navigateTo('studio/meeting-notes/new') },
        Component: lazy(() => import('../../../pages/meeting-notes/MeetingNotesPage')),
        getProps: ({ user, initialMeetingId }) => ({
            user,
            embedded: true,
            onBack: null,
            initialMeetingId,
        }),
    },
];

export default STUDIO_APPS;
