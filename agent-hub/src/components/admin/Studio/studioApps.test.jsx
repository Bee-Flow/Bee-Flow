import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    STUDIO_APPS, STUDIO_CATEGORIES, DEFAULT_STUDIO_CATEGORY,
    groupStudioApps, makeCanUse, resolveStudioNav, studioLockHint, createAutomationDraft,
    createFormAutomation, firstOpenStudioSection,
} from './studioApps';
import studioAppsSource from './studioApps.jsx?raw';
import EN_DEFAULTS from '../../../i18n/en-defaults';
import { KIND_KEYS } from '../../shared/kindColors';

// The lazy onCreate callbacks import()` this module at call time; mocking it
// here means the dynamic import resolves to the mock too.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
// createFormAutomation import()s the builder's form declaration at call time.
vi.mock('../../automation/Builder/flow/settings/FormBuilderFields', () => ({
    defaultFormDeclaration: () => ({ title: 'New form', fields: [{ name: 'q1' }] }),
}));

const app = (id) => STUDIO_APPS.find((a) => a.id === id);

// Every licence/capability key the registry's gates ask about, so a case can
// hold the licence side constant and vary only the permission.
const ALL_FEATURES = ['automations', 'approvals', 'webpages', 'app_studio', 'projects', 'meeting_notes'];

// Gate context builder — mirrors the ctx Sidebar.jsx passes to gate() and
// resolveStudioNav(): the legacy trio PLUS the EntitlementsContext pair
// (`can`, `lockReason`). A gate written against ctx.can works in the app and
// must work here too.
const ctx = ({ features = [], canUseIds = [], perms = [], canIds = [], locks = {}, user = {} } = {}) => ({
    user,
    hasLicenseFeature: (f) => features.includes(f),
    canUse: (id) => canUseIds.includes(id),
    hasPermission: (p) => perms.includes(p),
    can: (id) => canIds.includes(id),
    lockReason: (id) => (canIds.includes(id) ? null : (locks[id] || null)),
});

describe('studioApps registry shape', () => {
    it('has unique ids and unique urlSegments', () => {
        const ids = STUDIO_APPS.map((a) => a.id);
        const segs = STUDIO_APPS.map((a) => a.urlSegment);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(segs).size).toBe(segs.length);
    });

    it('covers the built-in Studio apps in tab order', () => {
        // Security Scan is no longer built-in — it ships as a downloadable module
        // and its tab is injected at runtime by moduleRuntime/registry.js.
        // Cowork is not here either: it was a tab that duplicated the sidebar's
        // Work page, and is now the standalone /app/cowork page. Support went
        // the same way in reverse: its components still ship (the demo mounts
        // them) but the org-facing inbox people use is the ADMIN dashboard's,
        // so the Studio section was dropped rather than kept as a second one.
        expect(STUDIO_APPS.map((a) => a.id)).toEqual([
            'agents', 'skills', 'knowledge', 'aiTasks', 'approvals', 'datatables',
            'webpages', 'documents', 'apps', 'forms', 'playbooks', 'solutions', 'runs', 'meetingNotes',
        ]);
    });

    it('keeps every urlSegment exactly as it was', () => {
        // mobile/app/notifications/route.ts hard-codes these; the regroup
        // renames headings, never addresses.
        expect(Object.fromEntries(STUDIO_APPS.map((a) => [a.id, a.urlSegment]))).toEqual({
            agents: 'agents', skills: 'skills', knowledge: 'knowledge', aiTasks: 'automations',
            approvals: 'approvals', datatables: 'datatables', webpages: 'webpages', documents: 'documents',
            apps: 'apps', forms: 'forms', playbooks: 'playbooks', solutions: 'solutions', runs: 'runs',
            meetingNotes: 'meeting-notes',
        });
    });


    it('files every section under a declared category', () => {
        // An unknown category silently falls into the "Add-ons" bucket, which
        // for a BUILT-IN section is always a mistake — it would show up under
        // a heading meaning "things you installed".
        const known = new Set(STUDIO_CATEGORIES.map((c) => c.id));
        for (const a of STUDIO_APPS) {
            expect(known.has(a.category), `${a.id} has category "${a.category}"`).toBe(true);
        }
    });

    it('the categories are the artboard\'s three groups plus the Add-ons bucket, in rail order', () => {
        expect(STUDIO_CATEGORIES.map((c) => c.id)).toEqual(['build', 'ai', 'bundle', 'modules']);
        // The fallback MUST be one of them — that is the whole eviction guard.
        expect(STUDIO_CATEGORIES.some((c) => c.id === DEFAULT_STUDIO_CATEGORY)).toBe(true);
    });

    it('every category labelKey resolves in the English defaults', () => {
        for (const c of STUDIO_CATEGORIES) {
            expect(EN_DEFAULTS[c.labelKey], `missing i18n key ${c.labelKey}`).toBeTruthy();
        }
    });

    it('every descriptor declares a gate, Component, getProps and Icon', () => {
        for (const a of STUDIO_APPS) {
            expect(typeof a.gate).toBe('function');
            expect(typeof a.getProps).toBe('function');
            expect(a.Component).toBeTruthy();
            expect(a.Icon).toBeTruthy();
        }
    });


    it('lockOn: every licence-gated section locks; only the permission-style gates (agents, knowledge, approvals) hide', () => {
        const locking = STUDIO_APPS.filter((a) => a.lockOn === 'disable').map((a) => a.id);
        expect(locking).toEqual(['skills', 'aiTasks', 'datatables', 'webpages', 'apps', 'forms', 'playbooks', 'solutions', 'runs', 'meetingNotes']);
        // Automations, Datatables and Forms share the one entitlement they
        // gate on — all three mirror the /api/automation mount.
        expect(app('aiTasks').gateCapability).toBe('automations');
        expect(app('datatables').gateCapability).toBe('automations');
        expect(app('forms').gateCapability).toBe('automations');
        expect(app('runs').gateCapability).toBe('automations');
        // A locking descriptor must say WHICH entitlement to ask about.
        for (const id of locking) expect(app(id).gateCapability, `${id}.gateCapability`).toBeTruthy();
    });
});

// The two sections that are not things you MAKE. Approvals is a decision and
// Runs is what an automation already did — neither is one of the ten kinds in
// shared/kindColors.js, so neither gets a kind colour and neither has anything
// to create. The list is closed on purpose: a section joins it by being added
// here, with a reason, not by omitting a field.
const NOT_A_KIND = ['approvals', 'runs'];

// WRITTEN-DOWN DEBT, in the shape i18n/i18nGuard.test.js uses for the same
// reason: the two dictionaries are one stage's at a time (I18N-CONVENTIES §3),
// so a section that ships before its namespace's turn renders through its
// `labelFallback`.
// Sections whose label key is written but not yet in the dictionary, because
// only one stage at a time may append to the two EN files. The assertion below
// runs the OTHER way round on purpose — it fails once the key HAS landed — so
// this list cannot quietly outlive the debt it records. `runs.title` came off
// it the moment the H2 keys were placed.
const PENDING_LABEL_KEYS = new Map([]);

describe('the registry contract the rail, the New menu and the dictionary share', () => {
    it('kind and create travel together — the rail tints exactly what the New menu can make', () => {
        // The rail colours a row by its `kind` and the universal "New" menu is
        // built from `create`, so a section that is a kind must be creatable
        // and one that is not must offer nothing to create. `kind` is checked
        // for UNDEFINED on the exempt two, not merely for falsiness: a typo'd
        // kind must fail here rather than land quietly in the neutral-ink
        // branch.
        for (const a of STUDIO_APPS) {
            const isKind = !NOT_A_KIND.includes(a.id);
            if (isKind) expect(KIND_KEYS.includes(a.kind), `${a.id} kind "${a.kind}"`).toBe(true);
            else expect(a.kind, `${a.id} must declare no kind`).toBeUndefined();
            expect(!!a.create, `${a.id}: create must be ${isKind ? 'present' : 'absent'}`).toBe(isKind);
        }
    });

    it('every labelKey resolves in the English defaults, or is pending debt with a fallback', () => {
        // Both directions. A pending key must still be missing — a key that
        // HAS landed must leave the ledger, or the exemption starts covering
        // whatever is written next to it (I18N-CONVENTIES §4.3: a stale
        // exemption is worse than no exemption). Seeing this fail means the
        // dictionary caught up: drop the entry.
        for (const [key, why] of PENDING_LABEL_KEYS) {
            expect(EN_DEFAULTS[key], `${key} has landed — remove it from PENDING_LABEL_KEYS (${why})`).toBeFalsy();
            expect(STUDIO_APPS.some((a) => a.labelKey === key), `${key} is on the ledger, unused`).toBe(true);
        }
        for (const a of STUDIO_APPS) {
            if (PENDING_LABEL_KEYS.has(a.labelKey)) {
                expect(a.labelFallback, `${a.id} renders ${a.labelKey} through a fallback and has none`).toBeTruthy();
            } else {
                expect(EN_DEFAULTS[a.labelKey], `missing i18n key ${a.labelKey}`).toBeTruthy();
            }
        }
    });
});

describe('makeCanUse — canUseFeature ?? (all-permission || betaFeatures)', () => {
    it('server canUseFeature=true wins', () => {
        expect(makeCanUse({ canUseFeature: { webpages: true } })('webpages')).toBe(true);
    });
    it('server canUseFeature=false wins even over the all permission + beta opt-in', () => {
        const user = { canUseFeature: { webpages: false }, permissions: ['all'], betaFeatures: ['webpages'] };
        expect(makeCanUse(user)('webpages')).toBe(false);
    });
    it('absent map falls back to the all permission', () => {
        expect(makeCanUse({ permissions: ['all'] })('webpages')).toBe(true);
    });
    it('absent map falls back to betaFeatures membership', () => {
        expect(makeCanUse({ betaFeatures: ['webpages'] })('webpages')).toBe(true);
    });
    it('denies when neither source grants it', () => {
        expect(makeCanUse({ permissions: ['manage_agents'], betaFeatures: [] })('webpages')).toBe(false);
        expect(makeCanUse({})('webpages')).toBe(false);
        expect(makeCanUse(undefined)('webpages')).toBe(false);
    });
});

// Everything a role grants an org_admin today, so a case can drop ONE
// permission and prove the gate is what stopped it.
const ALL_PERMS = [
    'manage_agents', 'manage_skills', 'manage_knowledge', 'use_datatables', 'manage_datatables',
    'use_webpages', 'use_automations', 'use_approvals', 'use_apps', 'manage_apps',
    'use_forms', 'use_solutions', 'use_meeting_notes',
];
const without = (perm) => ALL_PERMS.filter((p) => p !== perm);

describe('gates — legacy canSee* truth tables', () => {
    it('agents / knowledge need no licence or capability, only the org role', () => {
        // Community features, so the licence never gated them — but WHO builds
        // them is still the organisation's call, from its Roles screen.
        for (const id of ['agents', 'knowledge']) {
            expect(app(id).gate(ctx({ perms: ALL_PERMS }))).toBe(true);
        }
        expect(app('agents').gate(ctx({ perms: without('manage_agents') }))).toBe(false);
        expect(app('knowledge').gate(ctx({ perms: without('manage_knowledge') }))).toBe(false);
    });

    it('skills needs the capability AND the org role', () => {
        // The branch's capability gate (mirrors requireCapability) plus main's
        // org-role gate: both must pass, either one alone closes the section.
        expect(app('skills').gate(ctx({ canIds: ['skills'], perms: ALL_PERMS }))).toBe(true);
        expect(app('skills').gate(ctx({ perms: ALL_PERMS }))).toBe(false);
        expect(app('skills').gate(ctx({ canIds: ['skills'], perms: without('manage_skills') }))).toBe(false);
    });

    it.each([
        ['agents', 'manage_agents'],
        ['skills', 'manage_skills'],
        ['knowledge', 'manage_knowledge'],
        ['aiTasks', 'use_automations'],
        ['approvals', 'use_approvals'],
        ['datatables', 'use_datatables'],
        ['webpages', 'use_webpages'],
        ['apps', 'manage_apps'],
        ['solutions', 'use_solutions'],
        ['meetingNotes', 'use_meeting_notes'],
    ])('%s is closed by dropping %s alone, licence and canUse untouched', (id, perm) => {
        // The permission is a THIRD gate beside the licence and the org's beta
        // opt-in, never a substitute for either — a fully licensed org that
        // takes the permission off a role still hides the section from it.
        const licensed = { features: ALL_FEATURES, canUseIds: ALL_FEATURES, canIds: [...ALL_FEATURES, 'skills'] };
        expect(app(id).gate(ctx({ ...licensed, perms: ALL_PERMS }))).toBe(true);
        expect(app(id).gate(ctx({ ...licensed, perms: without(perm) }))).toBe(false);
    });

    it('skills: the skills capability, and the capability only (mirrors requireCapability)', () => {
        // /api/skills is mounted behind requireCapability('skills'): licence
        // AND beta opt-in, resolved server-side into the effective set that
        // EntitlementsContext.can reads. Neither the licence flag nor canUse
        // alone stands in for it. The org role (manage_skills) gates on top —
        // the merge keeps main's third gate — so every case below holds the
        // permission constant.
        const gate = app('skills').gate;
        expect(gate(ctx({ canIds: ['skills'], perms: ALL_PERMS }))).toBe(true);
        expect(gate(ctx({ features: ['skills'], canUseIds: ['skills'], perms: ALL_PERMS }))).toBe(false);
        expect(gate(ctx({ perms: ALL_PERMS }))).toBe(false);
    });

    it('aiTasks: automations only — the agent_routines leg is gone with the segment', () => {
        // The tab used to hold two lists behind a segmented control, so it was
        // visible on either licence. It is now just the Automations builder;
        // scheduled agent runs are managed from the agent that owns them, and an
        // agent_routines-only org would have landed on a segment that no
        // longer exists.
        const gate = app('aiTasks').gate;
        const p = ALL_PERMS;
        expect(gate(ctx({ features: ['automations'], canUseIds: ['automations'], perms: p }))).toBe(true);
        expect(gate(ctx({ features: ['agent_routines'], canUseIds: ['agent_routines'], perms: p }))).toBe(false);
        // Licence AND canUse — neither alone is enough.
        expect(gate(ctx({ features: ['automations'], canUseIds: [], perms: p }))).toBe(false);
        expect(gate(ctx({ features: [], canUseIds: ['automations'], perms: p }))).toBe(false);
        expect(gate(ctx({ perms: p }))).toBe(false);
    });

    it.each([
        ['webpages', 'webpages'],
        ['meetingNotes', 'meeting_notes'],
    ])('%s: licence AND canUse on %s', (id, feature) => {
        const gate = app(id).gate;
        const p = ALL_PERMS;
        expect(gate(ctx({ features: [feature], canUseIds: [feature], perms: p }))).toBe(true);
        expect(gate(ctx({ features: [feature], canUseIds: [], perms: p }))).toBe(false);
        expect(gate(ctx({ features: [], canUseIds: [feature], perms: p }))).toBe(false);
    });

    it('solutions: the projects licence key, and the LICENCE only', () => {
        // Same reasoning as Approvals below: 'projects' is a pure Enterprise
        // licence capability, never beta-gated, so it never enters
        // user.canUseFeature — ANDing canUse would hide the tab from every
        // ordinary member of a licensed org.
        const gate = app('solutions').gate;
        const p = ALL_PERMS;
        expect(gate(ctx({ features: ['projects'], perms: p }))).toBe(true);
        expect(gate(ctx({ features: ['automations', 'app_studio', 'webpages'], perms: p }))).toBe(false);
        expect(gate(ctx({ perms: p }))).toBe(false);
    });

    it('playbooks: BOTH the automation pair and the app pair — a playbook owns an automation and an app', () => {
        // Community has automations; app_studio is the ceiling. Either half
        // missing (licence OR canUse) closes the door, so a member who may
        // build automations but not apps never sees a playbook start and fail
        // at phase four.
        const gate = app('playbooks').gate;
        const both = { features: ['automations', 'app_studio'], canUseIds: ['automations', 'app_studio'] };
        expect(gate(ctx(both))).toBe(true);
        expect(gate(ctx({ features: ['automations'], canUseIds: ['automations'] }))).toBe(false);
        expect(gate(ctx({ features: ['app_studio'], canUseIds: ['app_studio'] }))).toBe(false);
        expect(gate(ctx({ features: ['automations', 'app_studio'], canUseIds: ['automations'] }))).toBe(false);
        expect(gate(ctx({ features: ['automations'], canUseIds: ['automations', 'app_studio'] }))).toBe(false);
        expect(gate(ctx())).toBe(false);
        // Locks on the HIGHER ceiling: the hint a Community org reads is about App Studio.
        expect(app('playbooks').gateCapability).toBe('app_studio');
        expect(app('playbooks').lockOn).toBe('disable');
    });

    it('approvals: its own Enterprise licence key, and the LICENCE only', () => {
        // The paid boundary is the collaboration layer: building an automation is
        // free (`automations` is Community), routing its decision past a
        // colleague is not. An org with the free builder and nothing else must
        // NOT see the Approvals tab.
        const gate = app('approvals').gate;
        const p = ALL_PERMS;
        expect(gate(ctx({ features: ['automations'], canUseIds: ['automations'], perms: p }))).toBe(false);
        expect(gate(ctx({ features: ['approvals'], perms: p }))).toBe(true);
        expect(gate(ctx({ perms: p }))).toBe(false);
        // canUse is NOT part of this gate, on purpose. `approvals` is a pure
        // core capability, so it never enters user.canUseFeature (loginRoutes
        // fills that from listCompoundGatedFeatures() — beta features only).
        // ANDing canUse here would hide the tab from every ordinary member of a
        // paying org, which is exactly the bug this case pins.
        expect(gate(ctx({ features: ['approvals'], canUseIds: [], perms: p }))).toBe(true);
    });

    it('forms: the SAME gate as Automations, because it is the same mount', () => {
        // GET /api/automation/forms carries no gate of its own — it inherits
        // requireModule('automation') + requireLicenseFeature('automations')
        // from the mount, exactly like the builder and the tables. A Forms row
        // that were visible on a licence the list 403s would be a dead door.
        const gate = app('forms').gate;
        expect(gate(ctx({ features: ['automations'], canUseIds: ['automations'], perms: ALL_PERMS }))).toBe(true);
        expect(gate(ctx({ features: ['automations'], canUseIds: [], perms: ALL_PERMS }))).toBe(false);
        expect(gate(ctx({ features: [], canUseIds: ['automations'], perms: ALL_PERMS }))).toBe(false);
        // Main's third gate applies here too: same mount, same org role.
        expect(gate(ctx({ features: ['automations'], canUseIds: ['automations'], perms: without('use_automations') }))).toBe(false);
        expect(gate(ctx())).toBe(false);
        // The SAME source as the Automations gate, whitespace aside — a truth
        // table alone would keep passing if that gate gained a condition and
        // this one did not.
        const src = (fn) => String(fn).replace(/\s+/g, ' ').trim();
        expect(src(gate)).toBe(src(app('aiTasks').gate));
    });

    it('support is no longer a Studio section at all', () => {
        // Removed rather than gated to nobody: a descriptor that can never
        // pass its gate is still a route, a lazy chunk and a line of registry
        // everyone has to reason about.
        expect(app('support')).toBeUndefined();
    });
});

describe('groupStudioApps', () => {
    it('groups in STUDIO_CATEGORIES order and keeps registry order inside a group', () => {
        const groups = groupStudioApps(STUDIO_APPS);
        expect(groups.map((g) => g.category.id)).toEqual(['build', 'ai', 'bundle']);
        // Forms is last in Build, the way the Studio Nav artboard draws it.
        expect(groups[0].apps.map((a) => a.id)).toEqual(['aiTasks', 'approvals', 'datatables', 'webpages', 'documents', 'apps', 'forms']);
        expect(groups[1].apps.map((a) => a.id)).toEqual(['agents', 'skills', 'knowledge', 'meetingNotes']);
        // Runs sits under Solutions in Bundle, the way the Studio Nav artboard
        // draws it: everything above builds something, this is what they did.
        expect(groups[2].apps.map((a) => a.id)).toEqual(['playbooks', 'solutions', 'runs']);
    });

    it('drops empty groups instead of rendering an empty heading', () => {
        const groups = groupStudioApps(STUDIO_APPS.filter((a) => a.category === 'ai'));
        expect(groups.map((g) => g.category.id)).toEqual(['ai']);
        expect(groupStudioApps([])).toEqual([]);
        expect(groupStudioApps(undefined)).toEqual([]);
    });

    it('files an uncategorised or unknown-category descriptor under Add-ons', () => {
        // Runtime (remotely-installed) module descriptors predate the field,
        // so this is the common path for them — not an edge case.
        const groups = groupStudioApps([
            { id: 'uptime', runtime: true },
            { id: 'evil', category: 'not-a-category' },
        ]);
        expect(groups.map((g) => g.category.id)).toEqual(['modules']);
        expect(groups[0].apps.map((a) => a.id)).toEqual(['uptime', 'evil']);
    });

    it('a runtime module may file itself under a first-party heading by naming one', () => {
        const groups = groupStudioApps([
            ...STUDIO_APPS.filter((a) => a.category === 'bundle'),
            { id: 'security', runtime: true, category: 'build' },
            { id: 'uptime', runtime: true },
        ]);
        expect(groups.map((g) => g.category.id)).toEqual(['build', 'bundle', 'modules']);
        expect(groups[0].apps.map((a) => a.id)).toEqual(['security']);
        expect(groups[2].apps.map((a) => a.id)).toEqual(['uptime']);
    });

    it('never loses a descriptor: every input lands in exactly one group', () => {
        // The eviction guard. A category rename that leaves the fallback
        // pointing nowhere throws in dev/test instead of silently dropping
        // every installed module from the nav.
        const input = [...STUDIO_APPS, { id: 'uptime', runtime: true }, { id: 'x', category: 'nope' }];
        const groups = groupStudioApps(input);
        const placed = groups.flatMap((g) => g.apps);
        expect(placed.length).toBe(input.length);
        for (const app of input) expect(placed.filter((p) => p === app).length).toBe(1);
    });
});

describe('resolveStudioNav — hide vs. lock', () => {
    const passing = { id: 'p', gate: () => true, lockOn: 'disable', gateCapability: 'x' };
    const failing = { id: 'f', gate: () => false, lockOn: 'disable', gateCapability: 'x' };
    const hiding = { id: 'h', gate: () => false, gateCapability: 'x' }; // lockOn defaults to 'hide'
    const throwing = { id: 't', gate: () => { throw new Error('boom'); }, lockOn: 'disable', gateCapability: 'x' };

    it('a passing gate is listed with locked: null', () => {
        expect(resolveStudioNav([passing], ctx())).toEqual([{ ...passing, locked: null }]);
    });

    it('a failed gate with lockOn: disable is LISTED, locked with lockReason\'s answer', () => {
        expect(resolveStudioNav([failing], ctx({ locks: { x: 'ceiling' } }))[0].locked).toBe('ceiling');
        expect(resolveStudioNav([failing], ctx({ locks: { x: 'not_granted' } }))[0].locked).toBe('not_granted');
        expect(resolveStudioNav([throwing], ctx({ locks: { x: 'ceiling' } }))[0].locked).toBe('ceiling');
    });

    it('a failed gate whose entitlement IS effective is a permission matter → hidden', () => {
        // lockReason answers null when the capability is in the effective set,
        // so the gate must have failed for another reason (an org role).
        expect(resolveStudioNav([failing], ctx({ canIds: ['x'] }))).toEqual([]);
    });

    it('lockOn: hide (the default) keeps hiding, even with a lock reason to show', () => {
        expect(resolveStudioNav([hiding], ctx({ locks: { x: 'ceiling' } }))).toEqual([]);
    });

    it('survives a ctx without lockReason (older callers) by hiding', () => {
        const legacy = { user: {}, hasLicenseFeature: () => false, canUse: () => false, hasPermission: () => false };
        expect(resolveStudioNav([failing, passing], legacy).map((a) => a.id)).toEqual(['p']);
    });

    it('registry end-to-end: a Community org sees the licence-gated rows locked, Skills locked on the beta', () => {
        const nav = resolveStudioNav(STUDIO_APPS, ctx({
            features: ['automations'], canUseIds: ['automations'], perms: ALL_PERMS,
            locks: { skills: 'not_granted', app_studio: 'ceiling', webpages: 'ceiling', meeting_notes: 'ceiling', projects: 'ceiling' },
        }));
        expect(Object.fromEntries(nav.map((a) => [a.id, a.locked]))).toEqual({
            agents: null, skills: 'not_granted', knowledge: null, aiTasks: null, datatables: null,
            // Documents is the one Build row a Community org keeps: it replaces
            // the ```quote``` block every chat could already render, so gating
            // it would withdraw a capability rather than add one. Asserted
            // rather than left implicit — the day somebody gives it a gate,
            // this line should be what objects.
            webpages: 'ceiling', documents: null, apps: 'ceiling', forms: null, playbooks: 'ceiling',
            solutions: 'ceiling', runs: null, meetingNotes: 'ceiling',
        });
        // Approvals hides on its licence (lockOn defaults to hide) — the
        // caller's hiddenFromNav filter never even sees it.
        expect(nav.find((a) => a.id === 'approvals')).toBeUndefined();
    });
});

describe('firstOpenStudioSection — where the Studio row lands', () => {
    it('skips locked sections and falls back when every section is locked', () => {
        const a = { id: 'a', locked: 'ceiling' };
        const b = { id: 'b', locked: null };
        const c = { id: 'c', locked: null };
        expect(firstOpenStudioSection([a, b, c], STUDIO_APPS[0])).toBe(b);
        expect(firstOpenStudioSection([a], STUDIO_APPS[0])).toBe(STUDIO_APPS[0]);
        expect(firstOpenStudioSection([], STUDIO_APPS[0])).toBe(STUDIO_APPS[0]);
        expect(firstOpenStudioSection(undefined, STUDIO_APPS[0])).toBe(STUDIO_APPS[0]);
    });
});

describe('studioLockHint', () => {
    const t = (k, fb) => `${k}|${fb}`;
    it('distinguishes "ask an admin" from "upgrade"', () => {
        expect(studioLockHint('not_granted', t)).toMatch(/^studio\.locked_not_granted\|/);
        expect(studioLockHint('ceiling', t)).toMatch(/^studio\.locked_upgrade\|/);
        // Any other reason string is a plan matter.
        expect(studioLockHint('tier', t)).toMatch(/^studio\.locked_upgrade\|/);
    });
});

describe('create — the universal "New" menu contract', () => {
    it('every nav section that is a kind has a create entry; Approvals and Runs have none', () => {
        for (const a of STUDIO_APPS.filter((x) => !x.hiddenFromNav && x.kind)) {
            expect(a.create, `${a.id}.create`).toBeTruthy();
            expect(typeof a.create.labelKey).toBe('string');
            expect(typeof a.create.labelFallback).toBe('string');
            expect(typeof a.create.onCreate).toBe('function');
        }
        expect(app('approvals').create).toBeUndefined();
        // You cannot make a run; you make an automation and it runs. NewMenu skips
        // a section without a create entry, which is what Approvals already
        // relies on.
        expect(app('runs').create).toBeUndefined();
    });

    it('navigation-only creates go to the section\'s own "new" entry', () => {
        const onNavigate = vi.fn();
        const c = { onNavigate, t: (k, fb) => fb };
        app('knowledge').create.onCreate(c);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/knowledge/new');
        app('datatables').create.onCreate(c);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/datatables/new');
        app('webpages').create.onCreate(c);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/webpages/new');
        app('apps').create.onCreate(c);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/apps/new');
        app('playbooks').create.onCreate(c);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/playbooks/new');
        app('solutions').create.onCreate(c);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/solutions/new');
        app('meetingNotes').create.onCreate(c);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/meeting-notes/new');
        app('agents').create.onCreate(c);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/agents');
    });

    describe('creates that post first', () => {
        beforeEach(() => fetchMock.mockReset());

        it('skills: posts the same untitled body SkillsStudio.createEmpty posts, then opens it', async () => {
            fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'sk9' }) });
            const onNavigate = vi.fn();
            await app('skills').create.onCreate({ onNavigate, t: (k, fb) => fb });
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/skills');
            expect(init.method).toBe('POST');
            const body = JSON.parse(init.body);
            expect(body).toMatchObject({ name: 'Untitled skill', icon: '⚡', isShared: false, sharedGroups: [], enabledIntegrations: [] });
            expect(onNavigate).toHaveBeenCalledWith('studio/skills/sk9');
        });

        it('automations: creates the row the builder would create on first save, then opens it', async () => {
            fetchMock.mockResolvedValue({ ok: true, json: async () => ({ automation: { id: 'au1' } }) });
            const onNavigate = vi.fn();
            await app('aiTasks').create.onCreate({ onNavigate, t: (k, fb) => fb });
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/automation');
            const body = JSON.parse(init.body);
            expect(body.title).toBe('Untitled automation');
            expect(body.definition).toEqual({
                schemaVersion: 1,
                trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
                steps: [], edges: [], vars: {},
            });
            expect(onNavigate).toHaveBeenCalledWith('studio/automations/au1');
        });

        it('createAutomationDraft accepts a trigger override (the Form item) and throws on a refused post', async () => {
            fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'au2' }) });
            const onNavigate = vi.fn();
            const trigger = { id: 'trg', type: 'trigger', kind: 'form', form: { title: 'Intake' }, output: {} };
            await createAutomationDraft({ onNavigate, t: (k, fb) => fb }, { title: 'Untitled form', trigger });
            expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ title: 'Untitled form', definition: { trigger } });
            expect(onNavigate).toHaveBeenCalledWith('studio/automations/au2');

            fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'feature_locked' });
            await expect(createAutomationDraft({ onNavigate: vi.fn(), t: (k, fb) => fb })).rejects.toThrow('feature_locked');
        });
    });
});

describe('hiddenFromNav', () => {
    it('approvals is the only section kept out of the Studio panel', () => {
        // It has its own top-level sidebar row. The descriptor stays so the
        // route, the deep link and the shell rendering are unchanged — see
        // Sidebar.studioNav.test.jsx for the nav side.
        expect(STUDIO_APPS.filter((a) => a.hiddenFromNav).map((a) => a.id)).toEqual(['approvals']);
    });
});

describe('import discipline', () => {
    it('top-level imports stay limited to react, lazyWithReload and lucide-react', () => {
        const src = studioAppsSource;
        const specifiers = [
            ...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm),
            ...src.matchAll(/^import\s+['"]([^'"]+)['"]/gm),
        ].map((m) => m[1]);
        expect(specifiers.length).toBeGreaterThan(0);
        const allowed = new Set(['react', 'lucide-react', '../../../utils/lazyWithReload']);
        for (const spec of specifiers) {
            expect(allowed.has(spec), `top-level import of "${spec}" would pull it into the main chunk`).toBe(true);
        }
        // Each app component must be referenced only inside a lazy() callback.
        const lazyImports = src.match(/lazy\(\(\) => import\(/g) || [];
        expect(lazyImports.length).toBe(STUDIO_APPS.length);
        // The create callbacks may import() at CALL time only — never a
        // top-level `import x from` of the API layer (checked above) and never
        // a dynamic import at MODULE scope (a column-0 line; the callbacks'
        // imports are indented inside their function bodies).
        expect(/^(?:const|let|var)\s[^\n]*\bimport\(/m.test(src)).toBe(false);
        expect(/^await\s+import\(/m.test(src)).toBe(false);
        // …and there ARE call-time imports, so the check is not vacuous.
        expect(/^\s+const \{[^}]*\} = await import\(/m.test(src)).toBe(true);
    });
});

describe('createFormAutomation', () => {
    beforeEach(() => fetchMock.mockReset());

    it('posts an automation whose trigger is a form, and opens the builder on it', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ automation: { id: 'au-form' } }) });
        const onNavigate = vi.fn();
        await createFormAutomation({ onNavigate, t: (k, fb) => fb });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/automation');
        const body = JSON.parse(init.body);
        expect(body.title).toBe('Untitled form');
        expect(body.definition.trigger).toMatchObject({ id: 'trg', type: 'trigger', kind: 'form', form: { title: 'New form' } });
        // The builder, not a form editor: there is no such screen.
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/au-form');
    });

    it('throws when the post is refused, so the caller can say so', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'feature_locked' });
        await expect(createFormAutomation({ onNavigate: vi.fn(), t: (k, fb) => fb })).rejects.toThrow('feature_locked');
    });
});
