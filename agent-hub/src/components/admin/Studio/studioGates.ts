// Studio's gate and helper functions: everything a Studio surface needs to
// decide what to LIST, LOCK or OFFER without loading the registry
// (studioRegistry.tsx), which lazy-imports every section. A section's own
// files import from here, never from the registry or the studioApps.jsx shim
// that re-exports it — that back edge was what tied all of Studio into one
// import cycle (studioRegistry.boundary.test.ts keeps it cut).
//
// Import-free at module scope: this file sits in the main chunk with the
// registry. createFormAutomation, the one helper that needs more, import()s
// at CALL time.

/** The app's translator, passed in so this file stays import-free. */
export type Translate = (key: string, fallback?: string) => string;

/** The context every gate(ctx) and resolveStudioNav receive (see the descriptor shape in studioRegistry.tsx). */
export interface StudioGateCtx {
    user?: unknown;
    hasLicenseFeature: (feature: string) => boolean;
    hasPermission: (permission: string) => boolean;
    canUse: (id: string) => boolean;
    can: (id: string) => boolean;
    lockReason?: (id: string) => string | null;
}

/** What a create entry's onCreate receives. */
export interface StudioCreateCtx {
    onNavigate?: ((target: string) => void) | null;
    t: Translate;
    user?: unknown;
}

/** The part of a Studio descriptor the functions below read; runtime modules carry the same fields. */
export interface StudioNavDescriptor {
    id?: string;
    category?: string;
    gate: (ctx: StudioGateCtx) => unknown;
    gateCapability?: string | null;
    lockOn?: string;
    permission?: string | readonly string[];
    trainingArea?: string | null;
}

/** The user fields makeCanUse reads. */
interface CanUseUser {
    canUseFeature?: Record<string, boolean | null | undefined> | null;
    permissions?: readonly string[] | null;
    betaFeatures?: readonly string[] | null;
}

export interface StudioCategory {
    id: string;
    labelKey: string;
    labelFallback: string;
}

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
export const makeCanUse = (user: CanUseUser | null | undefined) => (id: string): boolean =>
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
// STUDIO_APPS (studioRegistry.tsx), so a section only ever declares its place once.
export const STUDIO_CATEGORIES: readonly StudioCategory[] = [
    { id: 'build', labelKey: 'studio.category.build', labelFallback: 'Build' },
    { id: 'ai', labelKey: 'studio.category.ai', labelFallback: 'AI' },
    { id: 'bundle', labelKey: 'studio.category.bundle', labelFallback: 'Bundle' },
    { id: 'modules', labelKey: 'studio.category.modules', labelFallback: 'Add-ons' },
];

// Where a descriptor with no (or an unknown) category ends up. Runtime module
// descriptors predate the field entirely, so this is the common path for them.
// MUST name an id in STUDIO_CATEGORIES — groupStudioApps asserts it (below).
export const DEFAULT_STUDIO_CATEGORY: string = 'modules';

// True everywhere except a production build. Vite stamps import.meta.env.MODE
// ('development' | 'test' | 'production'); a missing env (plain node) counts
// as non-production so the assertion below also runs under any test runner.
const IS_DEV_OR_TEST: boolean = (() => {
    try { return (import.meta.env?.MODE || 'development') !== 'production'; } catch { return true; }
})();

/**
 * Group an already-gated, already-ordered list of Studio descriptors into
 * `[{ category, apps }]`, in STUDIO_CATEGORIES order, skipping empty groups.
 * Pure and import-free, like everything at module scope here.
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
export function groupStudioApps<T extends { id?: string; category?: string }>(
    apps: readonly T[] | null | undefined,
): Array<{ category: StudioCategory; apps: T[] }> {
    const known: ReadonlySet<unknown> = new Set(STUDIO_CATEGORIES.map((c) => c.id));
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
// Three mechanisms gate a section: the client `gate(ctx)` (studioRegistry), the server
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
export function resolveStudioNav<T extends StudioNavDescriptor>(
    apps: readonly T[] | null | undefined,
    ctx: StudioGateCtx,
): Array<T & { locked: string | null }> {
    const out: Array<T & { locked: string | null }> = [];
    for (const app of apps || []) {
        let passes = false;
        try { passes = !!app.gate(ctx); } catch { passes = false; }
        if (passes) { out.push({ ...app, locked: null }); continue; }
        if (app.lockOn !== 'disable' || !app.gateCapability) continue;
        // A lock is an upsell for someone who could otherwise use the section.
        // lockReason() only knows the entitlement, so without this a member
        // whose role lacks the permission AND whose plan lacks the feature got
        // a locked row ("Available on a higher plan") for a section an upgrade
        // would still not open for them. A permission miss hides, always.
        if (!studioPermissionHeld(app, ctx?.hasPermission)) continue;
        let reason: string | null = null;
        try { reason = ctx?.lockReason ? ctx.lockReason(app.gateCapability) : null; } catch { reason = null; }
        if (!reason) continue; // entitled but gated for another reason → hide
        out.push({ ...app, locked: reason });
    }
    return out;
}

/**
 * Does this person hold the section's role permission(s)? `permission` is the
 * descriptor's declaration of the hasPermission leg of its gate (a string, or
 * an array when the gate asks for several); studioApps.test.jsx holds the two
 * in lockstep. A section without one (Documents, runtime modules) has no
 * permission leg, so the answer is yes — as it is when no resolver is passed.
 */
export function studioPermissionHeld(
    app: Pick<StudioNavDescriptor, 'permission'> | null | undefined,
    hasPermission?: ((permission: string) => unknown) | null,
): boolean {
    if (!app?.permission || typeof hasPermission !== 'function') return true;
    const needed: readonly string[] = typeof app.permission === 'string' ? [app.permission] : app.permission;
    return needed.every((p) => {
        try { return !!hasPermission(p); } catch { return false; }
    });
}

/**
 * Where the Studio row itself lands: the first listed section that is not
 * locked — a locked row is a signpost, not a door. `fallback` is used when
 * every section is locked (or there are none).
 */
export function firstOpenStudioSection<T extends { locked?: unknown }, F>(
    sections: ReadonlyArray<T | null | undefined> | null | undefined,
    fallback: F,
): T | F {
    return (sections || []).find((s): s is T => !!s && !s.locked) || fallback;
}

/**
 * The one-line hint a locked row and a locked "New" item carry. `t` is the
 * app's translator (passed in so this file stays import-free).
 */
export function studioLockHint(reason: string | null | undefined, t: Translate): string {
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
export function studioTrainingArea(app: Pick<StudioNavDescriptor, 'trainingArea'> | null | undefined): string | null {
    return app?.trainingArea || null;
}

// "New form" — an automation with a form TRIGGER, and nothing else.
//
// THE DEVIATION, in the one place a reader will look for it: a form is not an
// object of its own in this product, so there is no form editor to open and
// the Forms section (studioRegistry.tsx) is a directory rather than an editor. The
// declaration a visitor fills in lives on the automation's trigger
// (`trigger.kind === 'form'`, `trigger.form`); the pages after page one are
// `form_page` STEPS in the same automation; and the public ADDRESS is a row in
// `automation_form_pages` the server mints on save (crud.js's
// ensureFormPages), never something the client creates. Three places, one
// automation — which is why "new form" is "new automation" and why editing one
// means opening the builder.
//
// `defaultFormDeclaration` lives with the builder and is import()ed at CALL
// time, so this module does not drag the builder chunk into the main one;
// the POST itself (api/queries/automation/createDraft.ts) is import()ed the
// same way.
//
// `collect: true` asks the server to make the form's ANSWERS TABLE on the
// same POST (automation/formAnswers) — the "just a form" of Studio → Forms.
// `title` names both the automation and the form. Navigation is the caller's
// when `onNavigate` is null (the New-form dialog lands on the Form page,
// not the builder).
export async function createFormAutomation(
    ctx: StudioCreateCtx,
    { title = null, collect = false }: { title?: string | null; collect?: boolean } = {},
): Promise<string | undefined> {
    const { defaultFormDeclaration } = await import('../../automation/Builder/flow/settings/FormBuilderFields');
    const form = defaultFormDeclaration();
    const name = title || ctx.t('studio.new.untitled_form', 'Untitled form');
    const { createAutomationDraft } = await import('../../../api/queries/automation/createDraft');
    return createAutomationDraft(ctx, {
        title: name,
        trigger: { id: 'trg', type: 'trigger', kind: 'form', form: { ...form, title: title || form.title, ...(collect ? { collect: true } : {}) }, output: {} },
    });
}
