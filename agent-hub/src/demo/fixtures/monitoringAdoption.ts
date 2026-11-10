/**
 * Fixtures for the Adoption tab of the organisation Usage & Monitoring demo
 * (pages/settings/usage/adoption), spread into ./monitoring.ts ROUTES.
 */

import { pick } from '../lang';
import { demoDate, demoNow } from '../demoClock';

/* ── Adoption tab ─────────────────────────────────────────────────────
   GET /api/usage/adoption/* (pages/settings/usage/adoption). One organisation
   of 148 members; the hero, the areas, the groups and the people all add up to
   the same 107 AI-active members, 31 makers and € 1 284 of spend. People are
   pseudonymous ("Member · K7Q2") unless the request says `reveal=true`, as
   the server's are; the drill-down's top users are pseudonymous always. */

const AD_WEEK_SHARE = [0.22, 0.24, 0.23, 0.2, 0.11];
const AD_PSEUDO_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** [area, cost, calls, people, objects, [source, share of the area]] — the spend apportioned per area. */
const AD_AREAS: Array<[string, number, number, number, number, Array<[string, number]>]> = [
    ['agents', 526, 12_480, 84, 29, [['agent_stream', 0.91], ['agent_test_chat', 0.09]]],
    ['chat', 283, 6910, 71, 0, [['direct_chat', 0.97], ['chat_title', 0.03]]],
    ['automations', 193, 3120, 23, 31, [['automation', 0.88], ['automation_builder', 0.12]]],
    ['forms', 0, 0, 0, 0, []],
    ['apps', 116, 1980, 39, 17, [['studio_app_ai', 0.7], ['studio_app_action', 0.3]]],
    ['cowork', 77, 640, 12, 9, [['cowork', 1]]],
    ['meetings', 51, 210, 18, 0, [['meeting_summary', 0.8], ['meeting_actions', 0.2]]],
    ['knowledge', 9, 120, 14, 4, [['knowledge_embedding', 1]]],
    ['documents', 6, 60, 9, 0, [['document_ai', 1]]],
    ['projects', 0, 0, 0, 0, []],
    ['webpages', 11, 70, 5, 3, [['webpage_bridge_ai', 1]]],
    ['skills', 2, 20, 4, 2, [['skill_ai_draft', 1]]],
    ['datatables', 4, 15, 6, 0, [['datatable_ai_draft', 1]]],
    ['media', 6, 15, 3, 0, [['image_generation', 1]]],
    ['system', 0, 0, 0, 0, []],
    ['other', 0, 0, 0, 0, []],
];
const AD_AREA_KIND: Record<string, string | null> = {
    agents: 'agent', automations: 'automation', forms: 'form', apps: 'app', cowork: 'cowork', meetings: 'meeting',
    knowledge: 'kb', documents: 'document', webpages: 'webpage', skills: 'skill', datatables: 'datatable',
};
const AD_COST = AD_AREAS.reduce((s, a) => s + a[1], 0);
const AD_CALLS = AD_AREAS.reduce((s, a) => s + a[2], 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

function adRange(query: URLSearchParams) {
    const end = demoDate();
    const days = Number(query.get('days')) || 30;
    const startDate = query.get('startDate');
    const endDate = query.get('endDate');
    if (startDate && endDate) return { startDate, endDate, days: null, relative: false };
    return { startDate: new Date(end.getTime() - days * 86_400_000).toISOString(), endDate: end.toISOString(), days, relative: true };
}

function isoWeek(d: Date): string {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const AD_SUMMARY = (query: URLSearchParams) => {
    const range = adRange(query);
    return {
        range,
        members: {
            total: 148, aiActive: 107,
            seenOnly: range.relative ? 22 : null, dormant: range.relative ? 19 : null, never: range.relative ? 0 : null,
            newInPeriod: 6, seats: { used: 148, max: 150 },
        },
        makers: { total: 31, newInPeriod: 4 },
        spend: { cost: AD_COST, calls: AD_CALLS, people: 107, perActiveMember: round2(AD_COST / 107) },
        adoptionRate: round2((107 / 148) * 100),
        prev: { aiActive: 98, adoptionRate: round2((98 / 145) * 100), cost: 1146, calls: 22_900 },
        partial: false,
    };
};

const AD_AREAS_ROUTE = () => {
    const areas = AD_AREAS.map(([area, cost, calls, people, objects, sources]) => ({
        area, kind: AD_AREA_KIND[area] ?? null, calls, cost, people, objects,
        sources: sources.map(([source, share]) => ({ source, calls: Math.round(calls * share), cost: round2(cost * share) })),
    }));
    const now = demoNow();
    const weeks = AD_WEEK_SHARE.map((share, i) => {
        const start = new Date(now - (AD_WEEK_SHARE.length - 1 - i) * 7 * 86_400_000);
        const byArea: Record<string, number> = {};
        for (const [area, cost] of AD_AREAS) byArea[area] = round2(cost * share);
        const total = round2(Object.values(byArea).reduce((s, v) => s + v, 0));
        return {
            week: isoWeek(start), start: start.toISOString(), end: new Date(start.getTime() + 7 * 86_400_000).toISOString(),
            complete: i < AD_WEEK_SHARE.length - 1, total, byArea,
        };
    });
    return { areas, timeline: { weeks }, partial: false };
};

/** [kind, total, published, makers, newInPeriod, usage|null, cost|null, deltaPct|null] */
const AD_KINDS: Array<[string, number, number, number, number, [number, number, string] | null, number | null, number | null]> = [
    ['agent', 42, 29, 11, 3, [3140, 84, 'conversations'], 526, 9],
    ['automation', 67, 31, 14, 2, [4870, 23, 'runs'], 193, 28],
    ['form', 19, 15, 8, 1, [612, 56, 'submissions'], null, 4],
    ['app', 23, 17, 9, 2, [1980, 39, 'action_runs'], 116, 15],
    ['datatable', 54, 21, 12, 3, null, 4, null],
    ['kb', 18, 12, 7, 1, null, 9, null],
    ['skill', 26, 19, 6, 1, [1120, 48, 'activations'], 2, 11],
    ['webpage', 14, 9, 5, 0, [2310, 0, 'public_views'], 11, 2],
    ['document', 211, 96, 38, 12, null, 6, null],
    ['meeting', 88, 40, 18, 4, [88, 18, 'recordings'], 51, 6],
    ['playbook', 6, 0, 3, 0, null, null, null],
    ['solution', 9, 4, 4, 1, [240, 17, 'activities'], null, 3],
    ['cowork', 31, 0, 12, 2, [640, 12, 'cowork_runs'], 77, 19],
];

const AD_STUDIO = () => ({
    kinds: AD_KINDS.map(([kind, total, published, makers, newInPeriod, usage, cost, deltaPct]) => {
        const base = usage ? usage[0] : (cost ?? 0);
        return {
            kind, total, published, makers, newInPeriod,
            usage: usage ? { events: usage[0], people: usage[1], label: usage[2] } : null,
            cost, deltaPct,
            trend: AD_WEEK_SHARE.map(s => (usage ? Math.round(base * s) : round2(base * s))),
        };
    }),
    partial: false,
});

const AD_MAKERS = ['Alex Morgan', 'Sam Rivera', 'Robin Patel', 'Jamie Chen', 'Taylor Brooks', 'Jordan Kim', 'Casey Novak', 'Morgan Ellis', 'Riley Hart', 'Drew Okafor', 'Avery Lund'];

const AD_ITEM_NAMES: Record<string, () => string[]> = {
    agent: () => pick({
        en: ['Sales assistant', 'Contract reviewer', 'HR policy helper', 'IT helpdesk', 'Proposal writer', 'Meeting prep', 'Invoice checker', 'Onboarding buddy'],
        nl: ['Verkoopassistent', 'Contractcontrole', 'HR-beleidshulp', 'IT-servicedesk', 'Offerteschrijver', 'Vergadervoorbereiding', 'Factuurcontrole', 'Inwerkmaatje'],
    }),
};

function adItems(kind: string) {
    const row = AD_KINDS.find(k => k[0] === kind) || AD_KINDS[0];
    const [, total, published, , , usage, cost] = row;
    const names = (AD_ITEM_NAMES[kind] || (() => pick({ en: ['Item'], nl: ['Item'] })))();
    const n = Math.min(total, 40);
    const items = Array.from({ length: n }, (_, i) => {
        const weight = Math.max(0, (n - i * 1.6) / n);
        const uses = usage && i < published ? Math.round((usage[0] / 6) * weight) : (usage ? 0 : null);
        return {
            id: `${kind}_demo_${i + 1}`,
            name: `${names[i % names.length]}${i >= names.length ? ` ${Math.floor(i / names.length) + 1}` : ''}`,
            ownerId: `user_demo_${i % AD_MAKERS.length}`,
            ownerName: AD_MAKERS[i % AD_MAKERS.length],
            audience: (i < published * 0.6 ? 'org' : i < published ? 'group' : 'private'),
            createdAt: new Date(demoNow() - (30 + i * 9) * 86_400_000).toISOString(),
            lastUsedAt: uses ? new Date(demoNow() - (i + 1) * 3_600_000 * 7).toISOString() : null,
            people: usage ? Math.round((usage[1] / 3) * weight) : null,
            uses,
            cost: cost == null ? null : round2((cost / 5) * weight),
        };
    });
    const unused = items.filter(i => i.audience !== 'private' && i.uses === 0).slice(0, 10)
        .map(i => ({ id: i.id, name: i.name, ownerName: i.ownerName, publishedAt: i.createdAt, lastUsedAt: null }));
    const topPeople = ['K7Q2', '3FX9', 'A8L1', 'P2M6', 'Q9R4'].map((code, i) => ({
        person: `Member · ${code}`, uses: usage ? Math.round(usage[0] / (12 + i * 6)) : 0, cost: round2((cost ?? 0) / (14 + i * 5)),
    }));
    return { kind, items, topPeople, unused, total };
}

const AD_GROUPS = () => ({
    groups: [
        { id: 'grp_demo_sales', name: pick({ en: 'Sales', nl: 'Verkoop' }), source: 'entra', members: 41, aiActive: 36, adoptionRate: 87.8, makers: 7, cost: 402, topArea: 'agents' },
        { id: 'grp_demo_ops', name: pick({ en: 'Operations', nl: 'Operatie' }), source: 'entra', members: 37, aiActive: 29, adoptionRate: 78.4, makers: 9, cost: 318, topArea: 'automations' },
        { id: 'grp_demo_fin', name: pick({ en: 'Finance', nl: 'Financiën' }), source: 'entra', members: 22, aiActive: 14, adoptionRate: 63.6, makers: 4, cost: 196, topArea: 'apps' },
        { id: 'grp_demo_hr', name: 'HR', source: 'local', members: 14, aiActive: 9, adoptionRate: 64.3, makers: 3, cost: 120, topArea: 'meetings' },
        { id: 'grp_demo_it', name: 'IT', source: 'local', members: 12, aiActive: 11, adoptionRate: 91.7, makers: 6, cost: 154, topArea: 'agents' },
    ],
    folded: { count: 3, members: 22, aiActive: 8, adoptionRate: 36.4, makers: 2, cost: 94, topArea: 'chat' },
    partial: false,
});

const AD_FIRST = ['Alex', 'Sam', 'Robin', 'Jamie', 'Taylor', 'Jordan', 'Casey', 'Morgan', 'Riley', 'Drew', 'Avery', 'Quinn', 'Rowan', 'Skyler', 'Parker', 'Reese'];
const AD_LAST = ['Morgan', 'Rivera', 'Patel', 'Chen', 'Brooks', 'Kim', 'Novak', 'Ellis', 'Hart', 'Okafor', 'Lund', 'Sato', 'Moreau'];
const AD_ROLES = ['member', 'member', 'member', 'agent_editor', 'org_admin'];

/** A stable four-character pseudonym per member, from the server's 32-symbol alphabet. */
function adPseudonym(i: number): string {
    let x = (i + 1) * 2_654_435_761 % 4_294_967_296;
    let out = '';
    for (let k = 0; k < 4; k++) { out += AD_PSEUDO_ALPHABET[x % 32]; x = Math.floor(x / 32) + (k + 1) * 977; }
    return out;
}

/** The 148 members: group sizes as in AD_GROUPS, 107 AI-active whose costs sum to the spend. */
function adPeopleAll() {
    const groups = AD_GROUPS();
    const groupOf: string[] = [];
    for (const g of groups.groups) for (let k = 0; k < g.members; k++) groupOf.push(g.name);
    while (groupOf.length < 148) groupOf.push('');
    const weights = Array.from({ length: 107 }, (_, i) => 1 / (i + 3));
    const wSum = weights.reduce((s, w) => s + w, 0);
    const areas = ['agents', 'chat', 'automations', 'apps', 'cowork', 'meetings'];
    return Array.from({ length: 148 }, (_, i) => {
        const active = i < 107;
        const seen = !active && i < 129;
        const cost = active ? round2((weights[i] / wSum) * AD_COST) : 0;
        return {
            index: i,
            name: `${AD_FIRST[i % AD_FIRST.length]} ${AD_LAST[(i * 7) % AD_LAST.length]}`,
            role: AD_ROLES[i % AD_ROLES.length],
            groups: groupOf[(i * 41) % 148] ? [groupOf[(i * 41) % 148]] : [],
            lastSeenAt: new Date(demoNow() - (active ? (i % 9) : seen ? 10 + (i % 15) : 35 + (i % 40)) * 86_400_000).toISOString(),
            status: active ? 'ai_active' : seen ? 'seen_only' : 'dormant',
            calls: active ? Math.round((weights[i] / wSum) * AD_CALLS) : 0,
            cost,
            areas: active ? areas.slice(i % 3, (i % 3) + 1 + (i % 3)) : [],
            built: i < 31 ? { agent: (i % 4) + 1, ...(i % 3 === 0 ? { automation: 2 } : {}) } : {},
            firstAiUseAt: active ? new Date(demoNow() - (60 + i) * 86_400_000).toISOString() : null,
        };
    });
}

const AD_PEOPLE = (query: URLSearchParams) => {
    const reveal = query.get('reveal') === 'true';
    const group = query.get('group');
    const groupName = group ? AD_GROUPS().groups.find(g => g.id === group)?.name : null;
    const limit = Math.min(Number(query.get('limit')) || 50, 200);
    const cursor = Number(query.get('cursor')) || 0;
    const all = adPeopleAll().filter(p => !groupName || p.groups.includes(groupName));
    const page = all.slice(cursor, cursor + limit).map(({ index, name, ...rest }) => ({
        ...rest,
        // Pseudonymous rows carry an opaque, collision-free id (the server sends 16 hex characters), never the label.
        id: reveal ? `user_demo_${index}` : index.toString(16).padStart(16, '0'),
        name: reveal ? name : `Member · ${adPseudonym(index)}`,
        avatarType: null,
        avatar: null,
    }));
    return { reveal, auditRecorded: reveal, people: page, total: all.length, nextCursor: cursor + limit < all.length ? cursor + limit : null };
};

export const ADOPTION_ROUTES = {
    'GET /api/usage/adoption/summary': ({ query }: { query: URLSearchParams }) => AD_SUMMARY(query),
    'GET /api/usage/adoption/areas': () => AD_AREAS_ROUTE(),
    'GET /api/usage/adoption/studio': () => AD_STUDIO(),
    'GET /api/usage/adoption/studio/items': ({ query }: { query: URLSearchParams }) => adItems(query.get('kind') || 'agent'),
    'GET /api/usage/adoption/groups': () => AD_GROUPS(),
    'GET /api/usage/adoption/people': ({ query }: { query: URLSearchParams }) => AD_PEOPLE(query),
};
