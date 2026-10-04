/**
 * The rest of an automation's Settings and the library around it, for the
 * Automations demo: who can do what (sharing), the folders, the trash, the app
 * buttons in Nextcloud Files, the "Frequently used" values under a step
 * setting, and the whole-automation actions (duplicate, save as template,
 * suggest a description).
 *
 * Sharing is a plan feature (`automation_sharing`). This demo's own
 * entitlements add it, so the sharing dialog is the unlocked one; the other
 * demos keep the common entitlements and are not affected.
 */

import { DEMO_CAPABILITIES, DEMO_ENTITLEMENTS, daysAgo } from './common';
import { recordRun } from './automationsRuns';
import { ACCOUNT_MANAGERS, FINANCE, GROUPS, ME, PEOPLE, SANNE, type DemoGroup, type DemoPerson } from './automationsPeople';

type Obj = Record<string, unknown>;
type Role = 'run' | 'view' | 'edit';
interface ShareRow { principalType: 'user' | 'group'; principalId: string; role: Role }
interface Automation {
    id: string; title?: string; description?: string | null; version: number; definition?: unknown;
    isActive?: boolean; folderId?: string | null; myRole?: string; owner?: { userId: string; name: string };
    deletedAt?: string | null; [key: string]: unknown;
}
interface SettingsState {
    automations: Automation[]; trash: Automation[]; folders: Obj[]; webhooks: Obj[];
    shares: Record<string, ShareRow[]>; orgTemplates: Obj[];
    runs: Parameters<typeof recordRun>[0]['runs'];
    versions: Parameters<typeof recordRun>[0]['versions'];
}

const CAPS = [...DEMO_CAPABILITIES, 'automation_sharing'];
const TRASH_DAYS = 30;

// ── Seeds ────────────────────────────────────────────────────────────────

export const seedFolders = () => ([
    { id: 'fld_demo_finance', name: 'Finance', icon: null, color: null },
    { id: 'fld_demo_clients', name: 'Clients', icon: null, color: null },
]);

const share = (who: DemoPerson | DemoGroup, role: Role): ShareRow => ({
    principalType: 'memberCount' in who ? 'group' : 'user', principalId: who.id, role,
});

export function seedShares(): Record<string, ShareRow[]> {
    return {
        auto_demo_spend_report: [share(FINANCE, 'run'), share(SANNE, 'edit')],
        auto_demo_intake: [share(ACCOUNT_MANAGERS, 'edit')],
        auto_demo_supplier: [share(ME, 'edit'), share(FINANCE, 'run')],
    };
}

/** One automation in the trash: deleted three days ago, purged in 27. */
export function seedTrash(): Automation[] {
    return [{
        id: 'auto_demo_expense_export', userId: ME.id, organizationId: 'demo-org', kind: 'automation',
        title: 'Expense export to the accountant', description: 'Every month: collect the approved expense claims and email them as one spreadsheet.',
        definition: {
            trigger: { id: 'trg', kind: 'schedule', cron: '0 7 1 * *', label: 'First of the month at 07:00' },
            steps: [
                { id: 'collect', type: 'integration_action', label: 'Collect the approved claims' },
                { id: 'email', type: 'notification', label: 'Email the accountant', channel: 'email', to: 'accountant@example.com' },
            ],
            edges: [{ from: 'trg', to: 'collect' }, { from: 'collect', to: 'email' }],
        },
        version: 4, liveVersion: 4, neverLive: false, pendingChanges: 0, isActive: false, isDraft: false,
        triggerType: 'schedule', deletedAt: daysAgo(3), deletedBy: ME.id, myRole: 'owner', accessVia: 'owner',
        createdAt: daysAgo(210), updatedAt: daysAgo(3),
    }];
}

/**
 * One inbound webhook on the spend report, used by the accounting package.
 * The list never carries the secret (server/stores/automationStore/webhooks.js
 * selects no secret column); `name` is what Settings → Advanced shows, and a
 * row without one reads "Webhook".
 */
export function seedWebhooks(): Obj[] {
    return [{
        id: 'wh_demo_accounting', automationId: 'auto_demo_spend_report', name: 'Accounting package',
        allowMethods: ['POST'], lastSeenAt: daysAgo(1), createdAt: daysAgo(30), triggerStepId: null,
    }];
}

// ── Helpers ──────────────────────────────────────────────────────────────

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = () => json({ error: 'Not found' }, 404);
const purgeAt = (deletedAt: string | null | undefined) => new Date(new Date(deletedAt || Date.now()).getTime() + TRASH_DAYS * 86_400_000).toISOString();
const automation = (state: SettingsState, id: string) => state.automations.find(a => a.id === id) || null;
const hookUrl = (slug: unknown) => `https://bee.example.com/api/automation/webhook/${String(slug)}`;
// Shown once after Create or Renew, like the real secret; it opens nothing.
const SHOWN_ONCE = 'demo-only-this-is-not-a-real-signing-key';

function sharesOut(state: SettingsState, a: Automation) {
    const owner = a.owner || { userId: ME.id, name: ME.name };
    const rows = (state.shares[a.id] || []).map((s) => {
        const group = GROUPS.find(g => g.id === s.principalId);
        const person = PEOPLE.find(p => p.id === s.principalId);
        return { ...s, name: group?.name || person?.name || null, ...(group ? { memberCount: group.memberCount } : {}), ...(!group && !person ? { missing: true } : {}) };
    });
    const mine = (a.myRole || 'owner') === 'owner';
    return { owner, runsAs: owner, shares: rows, myRole: a.myRole || 'owner', canManage: mine, sharingAvailable: true };
}

// "Frequently used" chips under a step setting, per input name.
const USAGE_VALUES: Record<string, Array<[string, number]>> = {
    path: [['/Invoices', 41], ['/Finance/Reports', 17], ['/Clients', 12], ['/Shared/Contracts', 5]],
    folder: [['/Invoices', 33], ['/Clients', 21], ['/Finance/Reports', 9]],
    query: [['from:(billing OR invoice OR receipt) newer_than:7d', 12], ['has:attachment subject:invoice', 7], ['from:noreply newer_than:1d', 3]],
    to: [['finance@example.com', 26], ['team@example.com', 14], ['s.deboer@example.com', 6]],
    room: [['Finance', 19], ['Approvals', 11], ['Team', 4]],
};

// ── Routes that must come BEFORE `GET /api/automation/:id` (one segment) ──

export const SETTINGS_LIBRARY_ROUTES = {
    'GET /auth/my-entitlements': () => ({
        ...DEMO_ENTITLEMENTS,
        effective: { ...DEMO_ENTITLEMENTS.effective, core: CAPS, beta: CAPS },
        ceiling: { ...DEMO_ENTITLEMENTS.ceiling, core: CAPS, beta: CAPS },
    }),
    'GET /api/automation/folders': ({ state }: { state: SettingsState }) => ({ folders: state.folders }),
    'POST /api/automation/folders': ({ state, body }: { state: SettingsState; body: Obj | null }) => {
        const folder = { id: `fld_demo_${state.folders.length + 1}`, name: String(body?.name || 'New folder').slice(0, 60), icon: null, color: null };
        state.folders.push(folder);
        return { folder };
    },
    'GET /api/automation/_trash': ({ state }: { state: SettingsState }) => ({
        automations: state.trash.map(a => ({ ...a, purgeAt: purgeAt(a.deletedAt) })),
        retentionDays: TRASH_DAYS,
    }),
    'GET /api/automation/_usage/values': ({ query }: { query: URLSearchParams }) => (
        (USAGE_VALUES[query.get('input') || ''] || []).map(([value, count]) => ({ value, count }))
    ),
};

// ── Routes under one automation ─────────────────────────────────────────────

type Ctx = { state: SettingsState; params: Record<string, string>; body: Obj | null };

export const SETTINGS_ROUTES = {
    'PUT /api/automation/folders/:folderId': ({ state, params, body }: Ctx) => {
        const folder = state.folders.find(f => f.id === params.folderId);
        if (!folder) return notFound();
        if (typeof body?.name === 'string') folder.name = body.name.slice(0, 60);
        return { folder };
    },
    'DELETE /api/automation/folders/:folderId': ({ state, params }: Ctx) => {
        const inside = state.automations.filter(a => a.folderId === params.folderId);
        inside.forEach((a) => { a.folderId = null; });
        state.folders = state.folders.filter(f => f.id !== params.folderId);
        return { success: true, detached: inside.length };
    },
    // Delete = into the trash for 30 days, switched off, runs kept.
    'DELETE /api/automation/:id': ({ state, params }: Ctx) => {
        const a = automation(state, params.id);
        if (!a) return notFound();
        state.automations = state.automations.filter(x => x.id !== a.id);
        Object.assign(a, { isActive: false, deletedAt: new Date().toISOString(), deletedBy: ME.id });
        state.trash.unshift(a);
        return { success: true, automation: a, purgeAt: purgeAt(a.deletedAt) };
    },
    'POST /api/automation/:id/restore': ({ state, params }: Ctx) => {
        const a = state.trash.find(x => x.id === params.id);
        if (!a) return json({ error: 'Not found', code: 'not_in_trash' }, 404);
        state.trash = state.trash.filter(x => x.id !== a.id);
        Object.assign(a, { deletedAt: null, deletedBy: null, isActive: false });
        state.automations.unshift(a);
        return { automation: a };
    },
    'GET /api/automation/:id/shares': ({ state, params }: Ctx) => {
        const a = automation(state, params.id);
        return a ? sharesOut(state, a) : notFound();
    },
    'PUT /api/automation/:id/shares': ({ state, params, body }: Ctx) => {
        const a = automation(state, params.id);
        if (!a) return notFound();
        const list = Array.isArray(body?.shares) ? body.shares as ShareRow[] : [];
        state.shares[a.id] = list.map(s => ({ principalType: s.principalType, principalId: s.principalId, role: s.role }));
        return sharesOut(state, a);
    },
    // Who can be picked in the sharing dialog and as a notification recipient.
    'GET /api/automation/:id/principals': () => ({
        users: PEOPLE.filter(p => p.id !== ME.id).map(p => ({ id: p.id, name: p.name, email: p.email })),
        groups: GROUPS.map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount })),
    }),
    'POST /api/automation/:id/transfer-owner': ({ state, params, body }: Ctx) => {
        const a = automation(state, params.id);
        const to = PEOPLE.find(p => p.id === body?.userId);
        if (!a || !to) return json({ error: 'That person is not in this organisation.', code: 'transfer_target_unknown' }, 400);
        a.owner = { userId: to.id, name: to.name };
        a.myRole = 'edit';
        a.accessVia = 'share';
        state.shares[a.id] = [...(state.shares[a.id] || []).filter(s => s.principalId !== to.id), { principalType: 'user', principalId: ME.id, role: 'edit' }];
        return { automation: a, owner: a.owner, runsAs: a.owner, warnings: [] };
    },
    // Settings → Advanced → webhooks.
    'GET /api/automation/:id/webhooks': ({ state, params }: Ctx) => ({
        webhooks: state.webhooks.filter(w => w.automationId === params.id).map(w => ({ ...w, url: hookUrl(w.id) })),
    }),
    'POST /api/automation/:id/webhook': ({ state, params, body }: Ctx) => {
        const hook = { id: `wh_demo_${state.webhooks.length + 1}`, automationId: params.id, allowMethods: ['POST'], lastSeenAt: null, createdAt: new Date().toISOString(), triggerStepId: body?.triggerStepId || null };
        state.webhooks.push(hook);
        return { webhook: { ...hook, url: hookUrl(hook.id), secret: SHOWN_ONCE } };
    },
    'POST /api/automation/:id/webhook/:slug/rotate': ({ state, params }: Ctx) => {
        const hook = state.webhooks.find(w => w.id === params.slug && w.automationId === params.id);
        return hook ? { webhook: { ...hook, url: hookUrl(hook.id), secret: SHOWN_ONCE } } : json({ error: 'Webhook not found' }, 404);
    },
    'DELETE /api/automation/:id/webhook/:slug': ({ state, params }: Ctx) => {
        const before = state.webhooks.length;
        state.webhooks = state.webhooks.filter(w => !(w.id === params.slug && w.automationId === params.id));
        return state.webhooks.length < before ? { success: true } : json({ error: 'Webhook not found' }, 404);
    },
    'POST /api/automation/:id/duplicate': ({ state, params }: Ctx) => {
        const a = automation(state, params.id);
        if (!a) return notFound();
        const copy: Automation = {
            ...JSON.parse(JSON.stringify(a)) as Automation, id: `auto_demo_copy_${state.automations.length + 1}`,
            title: `${a.title} (copy)`, version: 1, liveVersion: null, liveAt: null, neverLive: true, pendingChanges: 0,
            isActive: false, isDraft: true, myRole: 'owner', accessVia: 'owner', owner: undefined,
            lastRunAt: null, lastStatus: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        state.automations.unshift(copy);
        return { automation: copy, duplicatedFrom: a.id, warnings: [] };
    },
    'POST /api/automation/:id/save-as-template': ({ state, params, body }: Ctx) => {
        const a = automation(state, params.id);
        if (!a) return notFound();
        const steps = ((a.definition as { steps?: unknown[] } | undefined)?.steps || []).length;
        const template = {
            id: `org-demo-saved-${state.orgTemplates.length + 1}`, title: String(body?.title || a.title || 'Template'),
            description: String(body?.description ?? a.description ?? ''), category: null, icon: a.icon || null, tags: [],
            source: 'org', createdBy: ME.id, createdByName: ME.name, mine: true, createdAt: new Date().toISOString(),
            requiredIntegrations: [], triggerReadiness: 'ready', stepCount: steps, definition: a.definition,
        };
        state.orgTemplates.unshift(template);
        return { template, warnings: [] };
    },
    'POST /api/automation/:id/suggest-description': ({ state, params }: Ctx) => {
        const a = automation(state, params.id);
        return {
            description: a?.id === 'auto_demo_spend_report'
                ? 'Collects last week’s billing emails from the AI and SaaS vendors, totals them per vendor and emails finance a short summary when the week goes over €2,000.'
                : `Runs "${a?.title || 'this automation'}" step by step and reports what it did.`,
        };
    },
};
