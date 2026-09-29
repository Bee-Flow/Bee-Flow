/**
 * Fixtures for the Skills demo.
 *
 * Six skills, written the way the product stores them: instructions, rules,
 * worked examples, and the dynamic-activation settings that decide when an
 * assistant reaches for one. That is enough for the list, the editor and the
 * sharing controls to render their real layouts.
 *
 * All invented. The skills describe plausible internal conventions rather
 * than anything drawn from a real customer's workspace.
 */

import { COMMON_ROUTES, daysAgo, minutesAgo } from './common';

const SKILLS = () => ([
    {
        id: 'skl_demo_tone',
        name: 'House writing style',
        icon: '🖊️',
        description: 'How we write to customers: plain, short, and never breezy about bad news.',
        instructions: 'Write in plain language at roughly a B1 reading level. Prefer short sentences.\n\nNever open with an apology unless something actually went wrong. Do not use "just", "simply" or "easy" about anything the reader has to do — if it were easy they would not be asking.\n\nWhen the answer is no, say no in the first sentence, then explain. Burying it is worse than saying it.',
        rules: [
            'No exclamation marks in customer-facing text.',
            'Numbers under ten are written as words, except in tables and version numbers.',
            'Never promise a date we have not confirmed with the person who owns the work.',
        ],
        examples: [
            { input: 'Tell the customer their export failed', output: 'Your export did not complete. The job stopped at 40 minutes because the connection timed out, not because the data is missing — nothing was lost, and we can restart it whenever suits you.' },
        ],
        dynamicActivation: { enabled: true, keywords: ['email', 'reply', 'draft', 'customer'] },
        isShared: true,
        sharedGroups: ['grp_support', 'grp_sales'],
        workflow: null,
    },
    {
        id: 'skl_demo_tender',
        name: 'Tender question triage',
        icon: '📋',
        description: 'Sorts tender questions into who should answer them and what evidence they need.',
        instructions: 'For each question in a tender document, decide which of four buckets it belongs to: technical, legal, commercial, or references.\n\nFor each one, name the evidence the answer will need — a certificate, a policy document, a named customer, a figure from the platform. Do not draft the answer itself; the point is to make the work visible before anyone starts writing.',
        rules: [
            'A question that needs a figure we do not publish is flagged, not guessed.',
            'Anything mentioning a deadline is surfaced first, regardless of bucket.',
        ],
        examples: [],
        dynamicActivation: { enabled: true, keywords: ['tender', 'aanbesteding', 'rfp', 'bid'] },
        isShared: true,
        sharedGroups: ['grp_sales'],
        workflow: null,
    },
    {
        id: 'skl_demo_incident',
        name: 'Incident write-up',
        icon: '🚀',
        description: 'Turns a messy incident channel into a timeline someone can actually read.',
        instructions: 'Produce four sections: what happened, when we knew, what we changed, and what is still open.\n\nUse timestamps from the source material rather than relative wording. Separate what was observed from what was inferred — a write-up that presents a theory as a fact is how the same incident happens twice.',
        rules: [
            'Never name an individual as a cause. Name the system and the gap.',
            'If the root cause is not known, the section says so rather than offering the best guess.',
        ],
        examples: [],
        dynamicActivation: { enabled: false, keywords: [] },
        isShared: false,
        sharedGroups: [],
        workflow: null,
    },
    {
        id: 'skl_demo_dutch',
        name: 'Nederlandse zakelijke brief',
        icon: '📧',
        description: 'Formele Nederlandse correspondentie met de juiste aanhef en afsluiting.',
        instructions: 'Gebruik "u" tenzij expliciet anders gevraagd. Begin met "Geachte heer/mevrouw" wanneer de naam onbekend is, anders met de achternaam.\n\nVermijd letterlijk vertaald Engels. "Please find attached" wordt "In de bijlage vindt u", niet "Vind alstublieft bijgevoegd".',
        rules: [
            'Datum voluit: 3 maart 2026, niet 03-03-2026.',
            'Sluit af met "Met vriendelijke groet" en een witregel voor de naam.',
        ],
        examples: [],
        dynamicActivation: { enabled: true, keywords: ['brief', 'nederlands', 'geachte'] },
        isShared: true,
        sharedGroups: ['grp_support'],
        workflow: null,
    },
    {
        id: 'skl_demo_review',
        name: 'Contract clause review',
        icon: '🔍',
        description: 'Reads a clause against our standard positions and flags the deltas.',
        instructions: 'Compare each clause to our standard position. Report only where they differ, and say whether the difference is acceptable, negotiable, or a blocker.\n\nQuote the exact wording that creates the problem. A summary of a clause is not reviewable — the counterparty will negotiate the words, not the summary.',
        rules: [
            'Liability caps, IP assignment and data-processing terms are always reported, even when they match.',
            'Never state a legal conclusion. Flag it for a lawyer instead.',
        ],
        examples: [],
        dynamicActivation: { enabled: false, keywords: [] },
        isShared: true,
        sharedGroups: ['grp_legal'],
        workflow: null,
    },
    {
        id: 'skl_demo_summary',
        name: 'Weekly digest',
        icon: '📊',
        description: 'Condenses a week of activity into something worth reading on a Monday.',
        instructions: 'Lead with what changed, not with what happened. Three sections at most.\n\nIf nothing meaningful changed, say that in one line rather than padding. A digest people learn to skip is worse than no digest.',
        rules: ['Never longer than 200 words.'],
        examples: [],
        dynamicActivation: { enabled: true, keywords: ['digest', 'weekly', 'summary'] },
        isShared: false,
        sharedGroups: [],
        workflow: null,
    },
]);

const GROUPS = () => ([
    { id: 'grp_support', name: 'Support' },
    { id: 'grp_sales', name: 'Sales' },
    { id: 'grp_legal', name: 'Legal' },
]);

/**
 * Which agents attach each skill and which routine AI steps apply it — the
 * rows behind the detail's "Used by" tab, in the shared/UsedByTab contract
 * ({ kind, id, title, role, siteLabel?, stepId?, lastAt, ownerId }). The
 * agents and routines named here are invented; the demo mounts SkillsStudio
 * with `onNavigate: null`, so the tab renders them as plain text and none
 * of these ids ever needs a page behind it.
 *
 * The incident skill deliberately has NO entry: "not linked yet" is a real
 * state of the overview, and a demo where everything is used by something
 * would never show it.
 */
const USAGE = () => ({
    skl_demo_tone: [
        { kind: 'agent', id: 'ag_demo_support', title: 'Support assistant', role: 'chat', lastAt: minutesAgo(35), ownerId: null },
        { kind: 'agent', id: 'ag_demo_sales', title: 'Sales mailbox', role: 'chat', lastAt: daysAgo(1), ownerId: null },
        { kind: 'automation', id: 'auto_demo_ticket_replies', title: 'Draft replies to new tickets', role: 'ai_step', siteLabel: 'step Draft the reply', stepId: 'step_draft_reply', lastAt: minutesAgo(95), ownerId: 'demo-user' },
    ],
    skl_demo_tender: [
        { kind: 'agent', id: 'ag_demo_tenders', title: 'Tender desk', role: 'chat', lastAt: daysAgo(3), ownerId: null },
    ],
    skl_demo_dutch: [
        { kind: 'agent', id: 'ag_demo_support', title: 'Support assistant', role: 'chat', lastAt: daysAgo(6), ownerId: null },
    ],
    skl_demo_review: [
        // A colleague's routine: UsedByTab renders it as plain text that says
        // whose it is — a real state worth showing, not a broken link.
        { kind: 'automation', id: 'auto_demo_contract_intake', title: 'Contract intake triage', role: 'ai_step', siteLabel: 'step Compare against standard positions', stepId: 'step_compare', lastAt: daysAgo(12), ownerId: 'demo-colleague' },
    ],
    skl_demo_summary: [
        { kind: 'automation', id: 'auto_demo_weekly_digest', title: 'Monday team digest', role: 'ai_step', siteLabel: 'step Write the digest', stepId: 'step_write', lastAt: daysAgo(2), ownerId: 'demo-user' },
    ],
});

/**
 * What the step editor's pickers may point a step at (useSkillPickerData).
 * Only the `agent_call`-trigger routine is ever offered — the client
 * filters (skillModel.isAgentCallable) — and the schedule-triggered one is
 * here precisely so that filter has something real to leave out.
 */
const AUTOMATIONS = () => ([
    { id: 'auto_demo_product_answer', title: 'Answer a product question', triggerKind: 'agent_call', isActive: true },
    { id: 'auto_demo_weekly_digest', title: 'Monday team digest', triggerKind: 'schedule', isActive: true },
]);

// The same bases the Knowledge demo seeds, so a visitor who opens both
// demos meets one workspace, not two.
const KNOWLEDGE_BASES = () => ([
    { id: 'kb_demo_productdocs', name: 'Product documentation', icon: '📘' },
    { id: 'kb_demo_handbook', name: 'Employee handbook', icon: '📕' },
]);

const DATATABLES = () => ([
    { id: 'tbl_demo_pricelist', name: 'Pricelist', key: 'pricelist' },
    { id: 'tbl_demo_renewals', name: 'Policy renewals', key: 'policy_renewals' },
]);

export function createState() {
    return {
        skills: SKILLS(),
        groups: GROUPS(),
        usage: USAGE(),
        automations: AUTOMATIONS(),
        knowledgeBases: KNOWLEDGE_BASES(),
        datatables: DATATABLES(),
    };
}

export const ROUTES = {
    ...COMMON_ROUTES,

    // Returned BARE, not enveloped: SkillsStudio does `setSkills(await
    // res.json())` and then maps over it, so an object here blanks the list.
    'GET /api/skills': ({ state }) => state.skills,
    'GET /auth/groups': ({ state }) => state.groups,

    // ── Usage (Builder redesign Track 0.4 / S2) ─────────────────────
    // The overview's "2 agents · 1 automation" subline and the detail's
    // Used-by tab. The summary is DERIVED from the usage table at request
    // time so the two surfaces cannot disagree, and a skill with no rows is
    // present with zeros — the server's own contract
    // (routes/skills.js: { summary: { [id]: { agents, automations, lastUsedAt } } }).
    'GET /api/skills/usage-summary': ({ state }) => ({
        summary: Object.fromEntries(state.skills.map((s) => {
            const rows = state.usage[s.id] || [];
            return [s.id, {
                agents: rows.filter(r => r.kind === 'agent').length,
                automations: rows.filter(r => r.kind === 'automation').length,
                // ISO strings order lexicographically, so the last is the latest.
                lastUsedAt: rows.map(r => r.lastAt).filter(Boolean).sort().pop() || null,
            }];
        })),
    }),
    'GET /api/skills/:id/usage': ({ state, params }) => ({ usage: state.usage[params.id] || [] }),

    // ── The step editor's pickers (useSkillPickerData) ──────────────
    // `/api/kb` answers BARE — the reader takes an array or an envelope,
    // and the agents fixture already set the bare-array precedent.
    'GET /api/automation': ({ state }) => ({ automations: state.automations }),
    'GET /api/kb': ({ state }) => state.knowledgeBases,
    'GET /api/datatables': ({ state }) => ({ datatables: state.datatables }),

    'POST /api/skills': ({ state, body }) => {
        const created = {
            id: `skl_demo_new_${state.skills.length + 1}`,
            name: body?.name || 'Untitled skill',
            icon: body?.icon || '⚡',
            description: body?.description || '',
            instructions: body?.instructions || '',
            rules: body?.rules || [],
            examples: body?.examples || [],
            dynamicActivation: body?.dynamicActivation || { enabled: false, keywords: [] },
            isShared: false,
            sharedGroups: [],
            workflow: null,
        };
        state.skills.push(created);
        return created;
    },

    'PUT /api/skills/:id': ({ state, params, body }) => {
        const skill = state.skills.find(s => s.id === params.id);
        if (skill) Object.assign(skill, body || {});
        return skill || {};
    },

    'DELETE /api/skills/:id': ({ state, params }) => {
        const i = state.skills.findIndex(s => s.id === params.id);
        if (i >= 0) state.skills.splice(i, 1);
        return { ok: true };
    },
};
