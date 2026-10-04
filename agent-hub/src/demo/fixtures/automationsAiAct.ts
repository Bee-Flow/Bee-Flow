/**
 * "Ready to activate?" and the AI Act check of the Automations demo (Settings
 * of an automation, handoff 5 package S4).
 *
 * The demo organisation has the compliance hub (DEMO_CAPABILITIES carries
 * compliance_hub_gdpr), so every automation gets a check:
 *   - the spend report: Bee answered everything itself, "Checked
 *     automatically · Minimal risk";
 *   - the client intake: it reads client documents, and Bee cannot tell
 *     whether it helps decide about people, so one question is left;
 *   - the supplier onboarding: checked by hand, with a disclosure duty.
 * Answering the intake's question records the check, as the server does.
 *
 * Evidence lines use the server's codes and English texts
 * (server/automation/aiActTexts.js); areas follow Annex III as
 * server/compliance/aiAct/annexIii.js numbers them.
 */

import { daysAgo } from './common';
import { rowOf, type DemoRun } from './automationsRuns';
import { SANNE } from './automationsPeople';

type Obj = Record<string, unknown>;
type Tri = 'yes' | 'no' | 'unknown';
interface Evidence { code: string; params: Obj; text: string }
interface Finding { id: string; answer: Tri; confidence: string; by: string; evidence: Evidence[]; domains?: string[]; practices?: string[] }
interface Question { id: string; confidence: string; suggested: Tri | null; evidence: Evidence[]; domains?: Obj[]; suggestedDomains?: string[]; practices?: string[] }

export interface AiActRecord {
    status: string; source: string | null; outcome: string | null;
    attestedAt: string | null; attestedBy: string | null; expiresAt: string | null;
    findings: Finding[]; questions: Question[];
}

const ev = (code: string, text: string, params: Obj = {}): Evidence => ({ code, params, text });
const bee = (id: string, answer: Tri, evidence: Evidence[]): Finding => ({
    id, answer, confidence: 'certain', by: 'bee', evidence,
    ...(id === 'sensitiveUse' ? { domains: [] } : {}), ...(id === 'prohibitedUse' ? { practices: [] } : {}),
});
const usesAi = (labels: Array<[string, string, string]>) => bee('usesAi', 'yes', [ev('ai_act.uses_ai.steps',
    `Bee found ${labels.length === 1 ? 'an AI step' : `${labels.length} AI steps`}: ${labels.map(l => `"${l[1]}"`).join(', ')}.`,
    { count: labels.length, steps: labels.map(([stepId, label, type]) => ({ stepId, label, type })) })]);
const INTERNAL = bee('externalOutput', 'no', [ev('ai_act.external.none', 'The output stays inside your own organisation.')]);
const NOT_SENSITIVE = bee('sensitiveUse', 'no', [ev('ai_act.sensitive.none_found', 'Bee read the name, description and AI instructions and found no decisions about people in a high-risk area.')]);
const NOT_PROHIBITED = bee('prohibitedUse', 'no', [ev('ai_act.prohibited.none_found', 'Bee found none of the practices the AI Act forbids.')]);

const AREAS: Array<[string, number, string]> = [
    ['biometrics', 1, 'Annex III(1)'], ['critical_infrastructure', 2, 'Annex III(2)'], ['education', 3, 'Annex III(3)'],
    ['employment', 4, 'Annex III(4)'], ['essential_services', 5, 'Annex III(5)(a)'], ['credit', 5, 'Annex III(5)(b)'],
    ['insurance', 5, 'Annex III(5)(c)'], ['law_enforcement', 6, 'Annex III(6)'], ['migration', 7, 'Annex III(7)'], ['justice', 8, 'Annex III(8)'],
];
/** All ten areas, the hinted ones first. */
const areas = (hinted: string[]) => [...AREAS].sort((a, b) => Number(hinted.includes(b[0])) - Number(hinted.includes(a[0])))
    .map(([id, point, article]) => ({ id, point, article, labelKey: `compliance.annex_q_${id}`, hint: hinted.includes(id) }));

const valid = (source: string, outcome: string, days: number, by: string, findings: Finding[]): AiActRecord => ({
    status: 'valid', source, outcome, attestedAt: daysAgo(days), attestedBy: by, expiresAt: daysAgo(days - 365), findings, questions: [],
});

export function seedAiAct(): Record<string, AiActRecord> {
    return {
        auto_demo_spend_report: valid('auto', 'minimal', 12, 'demo-user', [
            usesAi([['extract_lines', 'Extract billing line items', 'ai_step'], ['write_summary', 'Write the summary', 'summarize']]),
            INTERNAL, NOT_SENSITIVE, NOT_PROHIBITED,
        ]),
        auto_demo_intake: {
            status: 'missing', source: null, outcome: null, attestedAt: null, attestedBy: null, expiresAt: null,
            findings: [usesAi([['classify', 'Classify the document', 'ai_step']]), INTERNAL, NOT_PROHIBITED],
            questions: [{
                id: 'sensitiveUse', confidence: 'unknown', suggested: null,
                evidence: [
                    ev('ai_act.sensitive.hints', 'The name, description or prompts mention one of these areas. Check whether the automation helps decide about people there.', { domains: ['essential_services', 'credit'] }),
                    ev('ai_act.model.unsure', 'Bee could not tell for sure from the name, description and AI instructions.'),
                ],
                domains: areas(['essential_services', 'credit']), suggestedDomains: [],
            }],
        },
        auto_demo_digest: valid('auto', 'minimal', 30, 'usr_demo_mjansen', [
            usesAi([['gather', 'Gather open actions', 'ai_step']]), INTERNAL, NOT_SENSITIVE, NOT_PROHIBITED,
        ]),
        auto_demo_supplier: valid('manual', 'transparency', 40, SANNE.id, [
            usesAi([['draft_welcome', 'Draft the welcome email', 'ai_step']]),
            { id: 'externalOutput', answer: 'yes', confidence: 'certain', by: 'person', evidence: [ev('ai_act.external.email', '"Email the supplier" sends an e-mail that can reach people outside the organisation.', { label: 'Email the supplier' })] },
            NOT_SENSITIVE, NOT_PROHIBITED,
        ]),
        auto_demo_vat: valid('auto', 'not_applicable', 20, 'demo-user', [bee('usesAi', 'no', [ev('ai_act.uses_ai.none', 'Bee found no AI steps.')])]),
    };
}

interface AiState {
    aiAct: Record<string, AiActRecord>;
    automations: Array<{ id: string; version: number; description?: string | null; definition?: unknown }>;
    runs: DemoRun[];
}

/** An automation made in the demo: Bee checks it on the spot and answers everything. */
function aiActOf(state: AiState, id: string): AiActRecord {
    if (!state.aiAct[id]) {
        const a = state.automations.find(x => x.id === id);
        const ai = ((a?.definition as { steps?: Obj[] } | undefined)?.steps || []).filter(s => s.type === 'ai_step');
        state.aiAct[id] = ai.length
            ? valid('auto', 'minimal', 0, 'demo-user', [usesAi(ai.map(s => [String(s.id), String(s.label || s.id), 'ai_step'])), INTERNAL, NOT_SENSITIVE, NOT_PROHIBITED])
            : valid('auto', 'not_applicable', 0, 'demo-user', [bee('usesAi', 'no', [ev('ai_act.uses_ai.none', 'Bee found no AI steps.')])]);
    }
    return state.aiAct[id];
}

const publicState = (r: AiActRecord) => ({
    required: true, status: r.status, expiresAt: r.expiresAt, outcome: r.outcome, attestedAt: r.attestedAt, attestedBy: r.attestedBy, source: r.source,
});

function answersOf(r: AiActRecord) {
    const of = (id: string) => r.findings.find(f => f.id === id)?.answer ?? 'unknown';
    const sensitive = r.findings.find(f => f.id === 'sensitiveUse');
    return r.findings.length ? { usesAi: of('usesAi'), externalOutput: of('externalOutput'), sensitiveUse: of('sensitiveUse'), domains: sensitive?.domains || [] } : null;
}

const describe = (r: AiActRecord) => ({
    ...publicState(r), answers: answersOf(r), openDuties: r.outcome === 'transparency' ? ['art50_1_disclosure'] : [], canEdit: true,
});
const describeCheck = (r: AiActRecord, recorded = false) => ({ ...describe(r), recorded, applicable: true, findings: r.findings, questions: r.questions });

const TRI = new Set(['yes', 'no', 'unknown']);

/** One person's answer, in place of what Bee found or asked. */
function takeAnswer(r: AiActRecord, id: string, value: Tri, domains: string[]): void {
    const prior = r.findings.find(f => f.id === id) || r.questions.find(q => q.id === id);
    const finding: Finding = { id, answer: value, confidence: 'certain', by: 'person', evidence: prior?.evidence || [], ...(id === 'sensitiveUse' ? { domains } : {}) };
    r.findings = [...r.findings.filter(f => f.id !== id), finding];
    r.questions = r.questions.filter(q => q.id !== id);
}

const says = (r: AiActRecord, id: string, answer: Tri) => r.findings.some(f => f.id === id && f.answer === answer);

function outcomeOf(r: AiActRecord): string {
    if (says(r, 'usesAi', 'no')) return 'not_applicable';
    if (says(r, 'sensitiveUse', 'yes')) return 'high_risk';
    return says(r, 'externalOutput', 'yes') ? 'transparency' : 'minimal';
}

/** Merge a person's answers into the check; record it once nothing is left open. */
function answer(r: AiActRecord, body: Obj, manual: boolean): boolean {
    for (const id of ['usesAi', 'externalOutput', 'sensitiveUse', 'prohibitedUse']) {
        const value = body[id];
        if (typeof value !== 'string' || !TRI.has(value)) continue;
        const domains = id === 'sensitiveUse' && value === 'yes' && Array.isArray(body.domains) ? body.domains.map(String) : [];
        takeAnswer(r, id, value as Tri, domains);
    }
    if (r.questions.length) return false;
    Object.assign(r, {
        status: 'valid', source: manual ? 'manual' : 'mixed', attestedAt: new Date().toISOString(), attestedBy: 'demo-user',
        expiresAt: daysAgo(-365), outcome: outcomeOf(r),
    });
    return true;
}

/** What the full editor ("Change answers") opens on: Bee's suggestions and the last answers. */
function suggestionOf(r: AiActRecord) {
    const empty: Finding = { id: '', answer: 'unknown', confidence: 'unknown', by: 'open', evidence: [] };
    const found = (id: string) => r.findings.find(f => f.id === id) || empty;
    const open = r.questions.find(q => q.id === 'sensitiveUse');
    const hinted = (open?.domains || []).filter(d => d.hint).map(d => String(d.id));
    const usesAiAnswer = found('usesAi').answer;
    return {
        required: true, status: r.status,
        questions: [
            { id: 'usesAi', suggested: usesAiAnswer, reasons: found('usesAi').evidence },
            { id: 'externalOutput', suggested: found('externalOutput').answer, reasons: found('externalOutput').evidence },
            { id: 'sensitiveUse', suggested: null, applicable: usesAiAnswer !== 'no', domains: areas(hinted), reasons: open ? open.evidence : found('sensitiveUse').evidence },
        ],
        suggestedOutcome: outcomeOf(r),
        previous: r.status === 'valid' ? answersOf(r) : null,
    };
}

// A step with a setting still empty: only the draft has one.
const INCOMPLETE: Record<string, Obj> = {
    auto_demo_vat: { ok: false, issues: 1, firstIssue: { code: 'step.missing_input', path: 'steps.0.to', message: '"Email the accountant" needs a recipient.' } },
};

function readinessOf(state: AiState, id: string) {
    const a = state.automations.find(x => x.id === id);
    if (!a) return null;
    const steps = ((a.definition as { steps?: unknown[] } | undefined)?.steps || []).length;
    const stepsComplete = INCOMPLETE[id] || (steps
        ? { ok: true, issues: 0, firstIssue: null }
        : { ok: false, issues: 1, firstIssue: { code: 'shape.no_steps', path: 'steps', message: 'Add at least one step.' } });
    const test = state.runs
        .filter(r => r.automationId === id && r.isTest && r.durationMs != null)
        .sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
    const row = test ? rowOf(test) : null;
    const r = aiActOf(state, id);
    return {
        version: a.version,
        stepsComplete,
        lastTest: row ? { ok: row.status === 'success', at: row.finishedAt, runId: row.id, status: row.status, version: row.version } : null,
        aiAct: publicState(r),
        description: { ok: typeof a.description === 'string' && !!a.description.trim() },
        canActivate: stepsComplete.ok === true && r.status === 'valid',
    };
}

const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
type Ctx = { state: AiState; params: Record<string, string>; body: Obj | null };

export const AI_ACT_ROUTES = {
    'GET /api/automation/:id/readiness': ({ state, params }: Ctx) => readinessOf(state, params.id) || notFound(),
    'GET /api/automation/:id/ai-act': ({ state, params }: Ctx) => describe(aiActOf(state, params.id)),
    'GET /api/automation/:id/ai-act/check': ({ state, params }: Ctx) => describeCheck(aiActOf(state, params.id)),
    'PUT /api/automation/:id/ai-act/answers': ({ state, params, body }: Ctx) => {
        const r = aiActOf(state, params.id);
        return describeCheck(r, answer(r, body || {}, false));
    },
    'PUT /api/automation/:id/ai-act': ({ state, params, body }: Ctx) => {
        const r = aiActOf(state, params.id);
        r.questions = [];
        answer(r, { ...(body || {}), prohibitedUse: 'no' }, true);
        return describe(r);
    },
    // The full editor ("Change answers") opens on Bee's suggestions and the last answers.
    'GET /api/automation/:id/ai-act/suggestion': ({ state, params }: Ctx) => suggestionOf(aiActOf(state, params.id)),
};
