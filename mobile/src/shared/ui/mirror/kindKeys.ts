/**
 * The Studio kinds and the names the rest of the product uses for them: the one
 * table the web and the phone share. mobile/src/shared/ui/mirror/kindKeys.ts is a
 * generated copy (scripts/shared-mirror.manifest.json, `npm run gen:shared`):
 * edit this file, never the copy.
 */

/** The thirteen kinds, in rail order: Bouwen, AI, Bundelen — then the one area you administer. */
export const KIND_KEYS = Object.freeze([
    'automation', 'datatable', 'app', 'webpage', 'document', 'form',
    'agent', 'skill', 'kb', 'meeting',
    'playbook', 'solution',
    'compliance',
] as const);

export type KindKey = (typeof KIND_KEYS)[number];

/**
 * The names the rest of the product already uses for these objects — API
 * resource types, sidebar section ids, usage rows, plurals — folded onto
 * the twelve keys, so a caller can hand over whatever it has.
 */
export const KIND_ALIASES: Readonly<Record<string, KindKey>> = Object.freeze({
    automations: 'automation', automation: 'automation', flow: 'automation',
    datatables: 'datatable', table: 'datatable', tables: 'datatable', data_table: 'datatable',
    apps: 'app', application: 'app',
    webpages: 'webpage', web: 'webpage', page: 'webpage', pages: 'webpage', website: 'webpage',
    documents: 'document', doc: 'document', invoice: 'document', quote: 'document', letter: 'document',
    forms: 'form', form_page: 'form',
    agents: 'agent', assistant: 'agent',
    skills: 'skill',
    kbs: 'kb', knowledge: 'kb', knowledge_base: 'kb', knowledge_bases: 'kb', knowledgebase: 'kb',
    meetings: 'meeting', meet: 'meeting', meeting_note: 'meeting', meeting_notes: 'meeting',
    transcription: 'meeting', transcriptions: 'meeting',
    playbooks: 'playbook', recipe: 'playbook',
    solutions: 'solution', bundle: 'solution',
    compliance_hub: 'compliance', gdpr: 'compliance', privacy: 'compliance',
});

/** The CSS variable each kind paints with (the phone reads the same table, minus the var()). */
export const KIND_VARS: Readonly<Record<KindKey, string>> = Object.freeze({
    automation: 'var(--type-trigger)',
    datatable: 'var(--type-data)',
    app: 'var(--kind-app)',
    webpage: 'var(--kind-web)',
    document: 'var(--kind-doc)',  // a printable artefact — rose (2026-09-15)
    form: 'var(--type-pause)',
    agent: 'var(--type-ai)',
    skill: 'var(--kind-skill)',
    kb: 'var(--kind-kb)',
    meeting: 'var(--kind-meet)',
    playbook: 'var(--kind-playbook)',  // a phased build the AI runs — emerald (2026-09-13)
    solution: 'var(--text-secondary)', // a container, deliberately neutral
    compliance: 'var(--kind-compliance)', // an area you administer — teal, retuned from --type-guard (2026-09-14)
});
