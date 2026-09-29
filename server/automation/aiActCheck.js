/**
 * The AI Act check of ONE automation (Studio → Automations handoff 5, settings
 * page): the three-question wizard, what Bee suggests for each question, and
 * the gate that stops Activate / "Make vN live" without a valid check.
 *
 * SINCE THE CHECK IS AUTOMATIC (automation/aiActAuto.js) the wizard below is
 * the full editor a person opens to override Bee ("Change answers"). Bee
 * answers every question it can by itself (aiActDetect.js, with the fast model
 * for Art. 5 and Annex III), records the check when nothing is left open, and
 * asks only the rest; the gate's refusal then carries those questions
 * (`gateRefusal`, `details.questions`). The register vocabulary, the status
 * ladder and the mapping in this file are shared by both paths.
 *
 * THE THREE QUESTIONS, mapped onto the register's own vocabulary
 * (compliance/aiAct/assess.js, `{ art5, art50, annex_iii }`):
 *
 *   1 usesAi          "Does this automation use AI?"
 *                     -> signals.contains_ai. The platform's detection stands:
 *                     a "no" never narrows a routine that has an AI step, a
 *                     "yes" widens one where Bee saw none (a model called from a
 *                     code step, a building block). Same rule assess.js applies
 *                     to Art. 50: the admin may widen, never narrow.
 *   2 externalOutput  "Do people outside the organisation see anything of it?"
 *                     -> art50.interacts (the Art. 50(1) transparency duty).
 *   3 sensitiveUse    "Does it help decide about people in one of these areas?"
 *                     with all TEN Annex III domains listed -> annex_iii.domains.
 *                     All ten on screen is the point (compliance/aiAct/annexIii.js):
 *                     "none of these" is a declaration about ten domains the
 *                     person was shown, never about four. "yes" names at least
 *                     one domain; the others shown are answered "no".
 *
 * Art. 5 (prohibited practices) is not one of the three: it stays what the hub
 * last recorded, so the wizard never erases a finer answer given there.
 *
 * WHAT BEE SUGGESTS. Q1 and Q2 are read off the steps (best effort, with the
 * steps named as reasons). Q3 is never pre-answered: a pre-ticked legal
 * position is the product taking one (annexIii.js); the hinted domains are put
 * first and flagged, nothing more.
 *
 * VALIDITY. An attestation from this page expires after 12 months, also a
 * "not applicable" one, and a "not applicable" check stops counting the moment
 * the routine gains an AI step (status 'outdated'), so a check done on a
 * routine without AI cannot wave through one that has it.
 *
 * Everything in here is pure except `makeAiActState`, whose IO is injected.
 */

'use strict';

const graph = require('./automationGraph');
const detect = require('./aiActDetect');
const annexIii = require('../compliance/aiAct/annexIii');
const assess = require('../compliance/aiAct/assess');

const TRI = Object.freeze(['yes', 'no', 'unknown']);
const QUESTION_IDS = Object.freeze(['usesAi', 'externalOutput', 'sensitiveUse']);
const STATUSES = Object.freeze(['not_required', 'missing', 'valid', 'expired', 'outdated', 'prohibited']);
/** Statuses that stop Activate / publish with `ai_act_check_required`. */
const NEEDS_CHECK = new Set(['missing', 'expired', 'outdated']);

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function tri(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    const s = typeof v === 'string' ? v.toLowerCase() : '';
    return TRI.includes(s) ? s : 'unknown';
}
function reason(code, params, text) { return { code, params: params || {}, text }; }

// ── Q1: AI ──────────────────────────────────────────────────────────────────

/**
 * The steps that hand work to a model (automation/aiActDetect.js): the
 * register's own list (automationGraph.AI_STEP_TYPES: ai_step,
 * data_extraction, ai_tool), an AI-mode parse_json, a merging
 * knowledge_write, an AI-backed integration action and an "is about" rule.
 * `summarize` is arithmetic and is not in it. An ai_step that names an agent
 * is reported as type 'agent'.
 */
function detectAiUse(definition, opts) {
    return detect.detectAiUse(definition, opts);
}

// ── Q2: visible outside the organisation ────────────────────────────────────

const EXTERNAL_TEXT = {
    http: (l) => `"${l}" sends data to another system.`,
    email: (l) => `"${l}" sends an e-mail that can reach people outside the organisation.`,
    share_by_email: (l) => `"${l}" shares a file by e-mail.`,
    signature_request: (l) => `"${l}" sends a document to be signed.`,
    social_post: (l) => `"${l}" publishes a post.`,
    webpage: (l) => `"${l}" changes a web page.`,
    calendar_invite: (l) => `"${l}" invites people to an event.`,
};

/**
 * Best effort: which steps put something in front of people outside the
 * organisation (aiActDetect.outwardSteps). Each finding is a reason
 * `{ code, params, text }`; `detected` is true when there is at least one.
 * What stays inside (an in-app notification, a Talk message, a file in the
 * own Nextcloud, an e-mail to a colleague's literal address) is not a finding.
 *
 * @param {object} definition
 * @param {{ internalDomains?: string[] }} [opts]  the organisation's mail domains
 */
function detectExternalOutput(definition, { internalDomains = [] } = {}) {
    const reasons = detect.outwardSteps(definition, { internalDomains })
        .map(o => reason(`ai_act.external.${o.kind}`, o.ref, EXTERNAL_TEXT[o.kind](o.ref.label)));
    return { detected: reasons.length > 0, reasons };
}

// ── The wizard ──────────────────────────────────────────────────────────────

/**
 * The stored answers read back as the three wizard answers, or null when there
 * is no assessment. Lets the wizard reopen on what was recorded.
 */
function wizardFromAssessment(row) {
    if (!row) return null;
    const a = assess.normalizeAnswers(row.answers);
    const s = isObject(row.signals) ? row.signals : {};
    const domains = a.annex_iii.domains;
    return {
        usesAi: s.contains_ai ? 'yes' : 'no',
        externalOutput: a.art50.interacts,
        sensitiveUse: a.annex_iii.answer,
        domains: annexIii.ANNEX_III_IDS.filter(id => domains[id] === 'yes'),
    };
}

/**
 * Prefilled answers for the three questions.
 *
 * @param {{ definition: object, signals?: object, latest?: object|null, internalDomains?: string[], title?: string, description?: string }} input
 */
function suggestWizard({ definition, signals = null, latest = null, internalDomains = [], title = '', description = '' }) {
    const ai = detectAiUse(definition);
    const containsAi = ai.detected || !!(signals && signals.contains_ai);
    const external = detectExternalOutput(definition, { internalDomains });

    const usesAi = {
        id: 'usesAi',
        suggested: containsAi ? 'yes' : 'no',
        reasons: ai.detected
            ? [reason('ai_act.uses_ai.steps', { count: ai.steps.length, steps: ai.steps },
                `Bee found ${ai.steps.length === 1 ? 'an AI step' : `${ai.steps.length} AI steps`}: ${ai.steps.map(s => `"${s.label}"`).join(', ')}.`)]
            : [reason('ai_act.uses_ai.none', {}, 'Bee found no AI steps.')],
    };
    const externalOutput = {
        id: 'externalOutput',
        suggested: external.detected ? 'yes' : 'no',
        reasons: external.detected
            ? external.reasons
            : [reason('ai_act.external.none', {}, 'The output stays inside your own organisation.')],
    };
    const hintText = [title, description,
        ...graph.listSteps(isObject(definition) ? definition : {})
            .filter(x => graph.isAiStep(x.step))
            .map(x => [x.step.prompt, x.step.systemPrompt, x.step.instructions].filter(v => typeof v === 'string').join('\n'))]
        .filter(Boolean).join('\n');
    const domains = annexIii.questionsFor(hintText).map(q => ({
        id: q.id, point: q.point, article: q.article, labelKey: q.label_key, hint: q.hint,
    }));
    const hinted = domains.filter(d => d.hint).map(d => d.id);
    const sensitiveUse = {
        id: 'sensitiveUse',
        // Never pre-answered: see the header.
        suggested: null,
        applicable: containsAi,
        domains,
        reasons: !containsAi
            ? [reason('ai_act.sensitive.not_applicable', {}, 'Without AI this question does not change the outcome.')]
            : hinted.length
                ? [reason('ai_act.sensitive.hints', { domains: hinted }, 'The name, description or prompts mention one of these areas. Check whether the automation helps decide about people there.')]
                : [reason('ai_act.sensitive.no_hints', {}, 'Nothing in the steps points at one of these areas, but only you can say.')],
    };

    const guess = { usesAi: usesAi.suggested, externalOutput: externalOutput.suggested, sensitiveUse: 'unknown' };
    const guessSignals = effectiveSignals(signals || { contains_ai: ai.detected }, guess);
    return {
        questions: [usesAi, externalOutput, sensitiveUse],
        // The outcome the suggestions lead to, with question 3 still open.
        suggestedOutcome: assess.outcome(guessSignals, answersFromWizard(guess, null)),
        previous: wizardFromAssessment(latest),
    };
}

/**
 * Validate the wizard body. Answers `{ ok: true, wizard }` or
 * `{ ok: false, code, message }` (the route turns it into a 400).
 */
function parseWizard(body) {
    const b = isObject(body) ? body : {};
    const allowed = new Set([...QUESTION_IDS, 'domains']);
    const unknownKey = Object.keys(b).find(k => !allowed.has(k));
    if (unknownKey) return { ok: false, code: 'ai_act.unknown_field', message: `Unknown field "${unknownKey}". Send usesAi, externalOutput, sensitiveUse and domains.` };
    for (const q of QUESTION_IDS) {
        if (!TRI.includes(b[q])) return { ok: false, code: 'ai_act.answer_invalid', message: `${q} is "yes", "no" or "unknown".` };
    }
    let domains = [];
    if (b.domains !== undefined && b.domains !== null) {
        if (!Array.isArray(b.domains) || b.domains.some(d => !annexIii.ANNEX_III_IDS.includes(d))) {
            return { ok: false, code: 'ai_act.domain_invalid', message: `domains lists ids from: ${annexIii.ANNEX_III_IDS.join(', ')}.` };
        }
        domains = [...new Set(b.domains)];
    }
    if (b.sensitiveUse === 'yes' && !domains.length) {
        return { ok: false, code: 'ai_act.domain_required', message: 'Pick the area the automation helps decide about.' };
    }
    return { ok: true, wizard: { usesAi: b.usesAi, externalOutput: b.externalOutput, sensitiveUse: b.sensitiveUse, domains: b.sensitiveUse === 'yes' ? domains : [] } };
}

const ANSWER_IDS = Object.freeze(['usesAi', 'externalOutput', 'sensitiveUse', 'prohibitedUse']);

/**
 * Validate a partial answer body (PUT /:id/ai-act/answers): only the
 * questions Bee could not answer, or any the person wants to change.
 * `{ usesAi?, externalOutput?, sensitiveUse?, domains?, prohibitedUse?, practices? }`.
 * Answers `{ ok: true, answers }` or `{ ok: false, code, message }`.
 */
function parseAnswers(body) {
    const b = isObject(body) ? body : {};
    const allowed = new Set([...ANSWER_IDS, 'domains', 'practices']);
    const unknownKey = Object.keys(b).find(k => !allowed.has(k));
    if (unknownKey) return { ok: false, code: 'ai_act.unknown_field', message: `Unknown field "${unknownKey}". Send ${ANSWER_IDS.join(', ')}, domains or practices.` };
    const answers = {};
    for (const q of ANSWER_IDS) {
        if (b[q] === undefined) continue;
        if (!TRI.includes(b[q])) return { ok: false, code: 'ai_act.answer_invalid', message: `${q} is "yes", "no" or "unknown".` };
        answers[q] = b[q];
    }
    if (!Object.keys(answers).length) return { ok: false, code: 'ai_act.answers_empty', message: 'Answer at least one question.' };
    const listOf = (v, vocabulary, code, what) => {
        if (v === undefined || v === null) return { ok: true, list: [] };
        if (!Array.isArray(v) || v.some(x => !vocabulary.includes(x))) return { ok: false, code, message: `${what} lists ids from: ${vocabulary.join(', ')}.` };
        return { ok: true, list: [...new Set(v)] };
    };
    const domains = listOf(b.domains, annexIii.ANNEX_III_IDS, 'ai_act.domain_invalid', 'domains');
    if (!domains.ok) return domains;
    const practices = listOf(b.practices, assess.ART5_PRACTICES, 'ai_act.practice_invalid', 'practices');
    if (!practices.ok) return practices;
    if (answers.sensitiveUse === 'yes') {
        if (!domains.list.length) return { ok: false, code: 'ai_act.domain_required', message: 'Pick the area the automation helps decide about.' };
        answers.domains = domains.list;
    }
    if (answers.prohibitedUse === 'yes' && practices.list.length) answers.practices = practices.list;
    return { ok: true, answers };
}

/**
 * The register answers for a wizard answer, laid over the previous answers
 * (Art. 5 and the finer Art. 50 answers from the hub survive).
 */
function answersFromWizard(wizard, previousAnswers) {
    const prev = assess.normalizeAnswers(previousAnswers || {});
    const w = isObject(wizard) ? wizard : {};
    const sensitive = tri(w.sensitiveUse);
    const chosen = new Set(Array.isArray(w.domains) ? w.domains : []);
    const domains = {};
    for (const id of annexIii.ANNEX_III_IDS) {
        domains[id] = sensitive === 'no' ? 'no'
            : sensitive === 'yes' ? (chosen.has(id) ? 'yes' : 'no')
                : 'unknown';
    }
    return assess.normalizeAnswers({
        art5: prev.art5,
        art50: { ...prev.art50, interacts: tri(w.externalOutput) },
        annex_iii: { answer: sensitive, category: sensitive === 'yes' ? [...chosen][0] || null : null, domains },
    });
}

/** The platform's signals, widened (never narrowed) by the "uses AI" answer. */
function effectiveSignals(signals, wizard) {
    const s = isObject(signals) ? { ...signals } : {};
    if (tri(wizard && wizard.usesAi) === 'yes') s.contains_ai = true;
    s.contains_ai = !!s.contains_ai;
    return s;
}

// ── Status and gate ─────────────────────────────────────────────────────────

/**
 * The status of the newest assessment row for an automation.
 * `containsAi` is whether the definition about to run has an AI step.
 */
function assessmentStatus(row, { containsAi = false, now = Date.now() } = {}) {
    if (!row || !row.attested_at) return 'missing';
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) return 'expired';
    if (row.outcome === 'prohibited') return 'prohibited';
    if (row.outcome === 'not_applicable' && containsAi) return 'outdated';
    return 'valid';
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

/**
 * Builds `aiActState(automation, definition)`:
 *   { required, status, expiresAt, outcome, attestedAt, attestedBy, orgId, row }
 *
 * @param {{
 *   isRequired: (automation: object, orgId: string|null) => Promise<boolean>,
 *   getLatest: (orgId: string, kind: 'automation', id: string) => Promise<object|null>,
 *   organisationOf: (automation: object) => Promise<string|null>,
 *   enabled?: () => Promise<boolean>,
 *   now?: () => number,
 * }} deps
 *
 * `enabled` is the install-wide precondition (the compliance module is on),
 * asked first so an install without it pays no organisation or licence read.
 */
function makeAiActState(deps) {
    const notRequired = (orgId) => ({ required: false, status: 'not_required', expiresAt: null, outcome: null, attestedAt: null, attestedBy: null, source: null, orgId, row: null });
    return async function aiActState(automation, definition) {
        if (deps.enabled && !(await deps.enabled())) return notRequired(null);
        const orgId = await deps.organisationOf(automation);
        const required = orgId ? !!(await deps.isRequired(automation, orgId)) : false;
        if (!required) return notRequired(orgId);
        const row = await deps.getLatest(orgId, 'automation', String(automation.id));
        const containsAi = detectAiUse(definition ?? automation.definition).detected;
        const status = assessmentStatus(row, { containsAi, now: deps.now ? deps.now() : Date.now() });
        return {
            required: true,
            status,
            expiresAt: iso(row?.expires_at),
            outcome: row?.outcome || null,
            attestedAt: iso(row?.attested_at),
            attestedBy: row?.attested_by || null,
            // 'auto' (Bee alone), 'mixed' (Bee and a person), 'manual' (the
            // full editor); null for a hub attestation or an older row.
            source: row?.source || null,
            orgId,
            row: row || null,
        };
    };
}

/** The public part of a state (what the API sends). */
function publicState(state) {
    const { required, status, expiresAt, outcome, attestedAt, attestedBy } = state;
    return { required, status, expiresAt, outcome, attestedAt, attestedBy, source: state.source ?? null };
}

/**
 * The refusal for a state, or null when the routine may go live.
 * `{ status: 409, code, message, details: { aiAct, questions? } }`.
 *
 * `state.pendingQuestions` (automation/aiActAuto.js) are the questions Bee
 * could not answer itself; they travel with the refusal so the builder can
 * ask exactly those and go live again.
 */
function gateRefusal(state) {
    if (!state || !state.required) return null;
    const questions = Array.isArray(state.pendingQuestions) ? state.pendingQuestions : [];
    if (NEEDS_CHECK.has(state.status)) {
        const why = questions.length
            ? `Bee checked this automation for the AI Act and needs ${questions.length === 1 ? 'one answer' : `${questions.length} answers`} from you.`
            : state.status === 'expired' ? 'The AI Act check of this automation has expired.'
                : state.status === 'outdated' ? 'The AI Act check said this automation uses no AI, but it has an AI step now.'
                    : 'This automation has no AI Act check yet.';
        return {
            status: 409,
            code: 'ai_act_check_required',
            message: questions.length ? `${why} Answer, then try again.` : `${why} Do the check in Settings, then activate again.`,
            details: { aiAct: publicState(state), ...(questions.length ? { questions } : {}) },
        };
    }
    if (state.status === 'prohibited') {
        return {
            status: 409,
            code: 'ai_act_prohibited',
            message: 'The AI Act check found a prohibited practice. This automation cannot go live.',
            details: { aiAct: publicState(state) },
        };
    }
    return null;
}

/**
 * The default IO for makeAiActState, required lazily: the licence
 * (`compliance_hub_gdpr` in the routine's organisation, module active), the
 * register, and the routine's organisation (automation/access.js).
 */
function defaultAiActState() {
    return makeAiActState({
        organisationOf: async (a) => {
            const { makeAutomationAccess } = require('./access');
            return makeAutomationAccess().organisationOf(a);
        },
        enabled: async () => {
            try { return !!(await require('../modules').isModuleActive('compliance')); }
            catch { return false; }
        },
        isRequired: async (a, orgId) => {
            try {
                const { hasCapability } = require('../core/entitlements/entitlements');
                return await hasCapability('compliance_hub_gdpr', { userId: a.userId || null, orgId });
            } catch { return false; }
        },
        getLatest: (orgId, kind, id) => require('../stores/aiActAssessmentStore').getLatest(orgId, kind, id),
    });
}

module.exports = {
    TRI,
    QUESTION_IDS,
    STATUSES,
    detectAiUse,
    detectExternalOutput,
    recipientsReach: detect.recipientsReach,
    suggestWizard,
    parseWizard,
    parseAnswers,
    answersFromWizard,
    effectiveSignals,
    wizardFromAssessment,
    assessmentStatus,
    makeAiActState,
    publicState,
    gateRefusal,
    defaultAiActState,
};
