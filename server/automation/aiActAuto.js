/**
 * The AI Act check that does itself (Studio → Automations handoff 5, owner:
 * "it should detect automatically, and only where it can't, ask").
 *
 *   check(automation, definition, opts)
 *     1. Not in an organisation with the compliance hub: nothing to do.
 *     2. A hub attestation (or a row from before this file) that is still
 *        valid stands as it is: a compliance officer's answer is not redone.
 *     3. Otherwise Bee answers every question it can (aiActDetect.js, with
 *        the fast model for Art. 5 and Annex III through aiActClassify.js)
 *        and merges that with what was recorded before:
 *          - a person's answer is kept while what Bee found for that question
 *            is the same (its fingerprint, `sig`), and until the row expires;
 *          - a certain detection answers the question ('bee');
 *          - anything else is a question for a person (`pending`).
 *     4. No questions left: the assessment is recorded (source 'auto' when Bee
 *        answered everything, 'mixed' when a person answered some, 'manual'
 *        from the full editor), unless the register already says exactly
 *        that and is valid. Nothing is written for a viewer (`record: false`).
 *
 *   gate: the same check inside activate and publish, before the gate
 *   (routes/automation/activate.js): the automation goes live when Bee could
 *   answer everything, else 409 `ai_act_check_required` with ONLY the open
 *   questions (aiActCheck.gateRefusal).
 *
 * The register row keeps its shape (signals, answers {art5, art50, annex_iii},
 * outcome, 12 months), so the hub reads an automatic check like any other.
 * What Bee found is stored beside it (`evidence`: per question the answer,
 * confidence, who answered, the fingerprint and the evidence codes, plus the
 * model verdict and its input hash, so a restart does not ask the model again).
 *
 * All IO is injected (`makeAiActAuto`); `defaultAiActAuto` wires the real one.
 */

'use strict';

const aiActCheck = require('./aiActCheck');
const detect = require('./aiActDetect');
const { classificationInput } = require('./aiActClassify');
const assess = require('../compliance/aiAct/assess');
const annexIii = require('../compliance/aiAct/annexIii');
const texts = require('./aiActTexts');

const BEE = 'bee';
const EVIDENCE_VERSION = 1;
const QUESTION_IDS = detect.QUESTION_IDS;

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** The per-question record of a row, or {} when there is none or it lapsed. */
function priorQuestions(row, now) {
    if (!row || !row.attested_at) return {};
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) return {};
    const ev = isObject(row.evidence) ? row.evidence : null;
    return ev && isObject(ev.questions) ? ev.questions : {};
}

/** A row this file (or the automation's own editor) wrote, as opposed to a hub or older one. */
function hasEvidence(row) { return !!row && isObject(row.evidence) && isObject(row.evidence.questions); }

/**
 * Bee's answers merged with the recorded ones. Pure.
 * @returns {{ final: Record<string, object>, pending: string[] }}
 */
function mergeAnswers(detection, row, { now = Date.now() } = {}) {
    const prev = priorQuestions(row, now);
    const final = {};
    const pending = [];
    for (const id of QUESTION_IDS) {
        const d = detection.questions[id];
        if (!d) continue;
        const p = prev[id];
        if (p && p.by === 'person' && p.sig === d.sig) {
            final[id] = { ...d, answer: p.answer, domains: p.domains || [], practices: p.practices || [], by: 'person' };
        } else if (d.confidence === 'certain') {
            final[id] = { ...d, by: BEE };
        } else {
            pending.push(id);
        }
    }
    return settleNoAi(final, pending);
}

/** Without AI the other questions do not change anything: drop them. */
function settleNoAi(final, pending) {
    if (final.usesAi && final.usesAi.answer === 'no') {
        for (const id of QUESTION_IDS) if (id !== 'usesAi') delete final[id];
        return { final, pending: [] };
    }
    return { final, pending };
}

/**
 * A person's answers laid over the merge. A "no" to "uses AI" where Bee is
 * certain there is AI does not narrow it (the register's rule: widen, never
 * narrow). Answers `{ final, pending }`.
 */
function applyPersonAnswers(detection, merged, answers) {
    const final = { ...merged.final };
    let pending = [...merged.pending];
    for (const id of QUESTION_IDS) {
        if (!answers || !(id in answers)) continue;
        const d = detection.questions[id];
        if (!d) continue;
        if (id === 'usesAi' && answers.usesAi === 'no' && d.answer === 'yes' && d.confidence === 'certain') {
            final.usesAi = { ...d, by: BEE };
        } else {
            final[id] = {
                ...d,
                answer: answers[id],
                domains: id === 'sensitiveUse' && answers[id] === 'yes' ? [...(answers.domains || [])] : [],
                practices: id === 'prohibitedUse' && answers[id] === 'yes' ? [...(answers.practices || d.practices || [])] : [],
                by: 'person',
            };
        }
        pending = pending.filter(q => q !== id);
    }
    // "Uses AI: yes" from a person brings the other questions back.
    if (final.usesAi && final.usesAi.answer === 'yes') {
        for (const id of QUESTION_IDS) if (!final[id] && !pending.includes(id) && detection.questions[id]) pending.push(id);
    }
    return settleNoAi(final, pending);
}

/** The register answers for the final answers, over the previous row's (Art. 50 details from the hub survive). */
function registerAnswers(final, previousAnswers) {
    const answers = aiActCheck.answersFromWizard({
        usesAi: final.usesAi ? final.usesAi.answer : 'unknown',
        externalOutput: final.externalOutput ? final.externalOutput.answer : 'unknown',
        sensitiveUse: final.sensitiveUse ? final.sensitiveUse.answer : 'unknown',
        domains: final.sensitiveUse ? final.sensitiveUse.domains || [] : [],
    }, previousAnswers);
    if (final.prohibitedUse) {
        answers.art5 = { answer: final.prohibitedUse.answer, practices: final.prohibitedUse.answer === 'yes' ? final.prohibitedUse.practices || [] : [] };
    }
    return assess.normalizeAnswers(answers);
}

/** True when the row already records exactly this. */
function sameAsRecorded(row, { signals, answers, outcome }) {
    if (!row) return false;
    return row.outcome === outcome
        && !!(row.signals && row.signals.contains_ai) === !!signals.contains_ai
        && JSON.stringify(assess.normalizeAnswers(row.answers)) === JSON.stringify(answers);
}

function stripEvidence(list) {
    return (Array.isArray(list) ? list : []).map(e => ({ code: e.code, params: e.params || {} }));
}

/** What is stored beside the register answers. Allow-listed: no model prose, no addresses. */
function evidenceRecord(detection, final) {
    const questions = {};
    for (const [id, q] of Object.entries(final)) {
        questions[id] = {
            answer: q.answer, confidence: q.confidence, by: q.by, sig: q.sig,
            evidence: stripEvidence(q.evidence),
            ...(q.domains && q.domains.length ? { domains: [...q.domains] } : {}),
            ...(q.practices && q.practices.length ? { practices: [...q.practices] } : {}),
        };
    }
    const v = detection.verdict;
    return {
        v: EVIDENCE_VERSION,
        questions,
        classification: v ? {
            hash: v.hash, available: !!v.available, modelId: v.modelId || null,
            prohibited: v.prohibited || null, highRisk: v.highRisk || null,
        } : null,
    };
}

/** One finding for the card: what was answered, how sure Bee was, and why. */
function publicFinding(id, q) {
    return {
        id, answer: q.answer, confidence: q.confidence, by: q.by,
        evidence: texts.withText(q.evidence),
        ...(id === 'sensitiveUse' ? { domains: q.domains || [] } : {}),
        ...(id === 'prohibitedUse' ? { practices: q.practices || [] } : {}),
    };
}

/** One open question: Bee's suggestion (preselected only when 'likely'), its evidence and, for Annex III, all ten areas. */
function publicQuestion(id, d, detection) {
    const suggested = d.confidence === 'likely' ? d.answer : (d.lean || null);
    const q = { id, confidence: d.confidence, suggested: suggested === 'yes' || suggested === 'no' ? suggested : null, evidence: texts.withText(d.evidence) };
    if (id === 'sensitiveUse') {
        q.domains = annexIii.questionsFor(detection.hintText || '').map(x => ({ id: x.id, point: x.point, article: x.article, hint: x.hint }));
        q.suggestedDomains = d.domains || [];
    }
    if (id === 'prohibitedUse') q.practices = d.practices || [];
    return q;
}

/**
 * @param {{
 *   aiActState: (automation: object, definition: object) => Promise<object>,   aiActCheck.makeAiActState
 *   attest: (input: object) => Promise<object>,                                compliance/aiAct/attest.attest
 *   classify: (input: { text, hash, orgId, userId }) => Promise<object>,       aiActClassify.makeClassifier
 *   signalsFor: (automation: object, orgId: string, definition: object) => Promise<object>,
 *   internalDomainsOf?: (automation: object) => Promise<string[]>,
 *   loadBlocks?: (definition: object) => Promise<Record<string, object|null>>,
 *   now?: () => number,
 * }} deps
 */
function makeAiActAuto(deps) {
    const now = () => (deps.now ? deps.now() : Date.now());

    async function detectFor(automation, definition, { orgId, row, wantAll }) {
        const blocks = deps.loadBlocks ? await deps.loadBlocks(definition).catch(() => null) : null;
        const ai = detect.detectAiUse(definition, { blocks });
        const title = automation.title || '';
        const description = automation.description || '';
        let verdict = null;
        if (ai.detected || ai.unresolvedBlocks.length || wantAll) {
            const extra = blocks ? Object.values(blocks).filter(isObject) : [];
            const input = classificationInput({ title, description, definition, definitions: extra });
            const stored = hasEvidence(row) ? row.evidence.classification : null;
            if (stored && stored.available && stored.hash === input.hash) verdict = { ...stored };
            else {
                try { verdict = await deps.classify({ text: input.text, hash: input.hash, orgId, userId: automation.userId || null }); }
                catch { verdict = null; }
                verdict = verdict ? { ...verdict, hash: input.hash } : { available: false, hash: input.hash };
            }
        }
        const internalDomains = deps.internalDomainsOf ? await deps.internalDomainsOf(automation).catch(() => []) : [];
        const detection = detect.detectQuestions({ definition, title, description, internalDomains, blocks, verdict });
        detection.verdict = verdict;
        detection.hintText = detect.hintText({ definition, title, description });
        return detection;
    }

    /**
     * @param {object} automation
     * @param {object} definition  the copy that is checked (the one about to run for the gate)
     * @param {{ record?: boolean, actorId?: string|null, answers?: object|null, manual?: boolean }} [opts]
     *   answers: a person's answers (PUT), laid over Bee's; manual: from the full editor
     */
    async function check(automation, definition, { record = true, actorId = null, answers = null, manual = false } = {}) {
        const def = isObject(definition) ? definition : (automation.definition || {});
        const state0 = await deps.aiActState(automation, def);
        const base = { state: state0, findings: [], pending: [], recorded: false, applicable: null };
        if (!state0.required) return base;
        const row = state0.row;
        // A compliance officer's attestation (or an older row) stands while it
        // is valid; so does a prohibited verdict, until a person changes it.
        if (!answers && ((!hasEvidence(row) && state0.status === 'valid') || state0.status === 'prohibited')) return base;

        const prev = priorQuestions(row, now());
        const wantAll = (answers && answers.usesAi === 'yes') || (prev.usesAi && prev.usesAi.by === 'person' && prev.usesAi.answer === 'yes');
        const detection = await detectFor(automation, def, { orgId: state0.orgId, row, wantAll });
        let { final, pending } = mergeAnswers(detection, row, { now: now() });
        if (answers) ({ final, pending } = applyPersonAnswers(detection, { final, pending }, answers));
        // The full editor asks three questions and always records, like it
        // did before Bee checked by itself: a question it does not ask keeps
        // what the register said ('open', so the next check asks it again).
        if (manual && pending.length) {
            const was = assess.normalizeAnswers(row ? row.answers : {});
            const recorded = { externalOutput: was.art50.interacts, sensitiveUse: was.annex_iii.answer, prohibitedUse: was.art5.answer };
            for (const id of pending) final[id] = { ...detection.questions[id], answer: recorded[id] || 'unknown', by: 'open' };
            pending = [];
        }
        const findings = Object.entries(final).map(([id, q]) => publicFinding(id, q));
        const questions = pending.map(id => publicQuestion(id, detection.questions[id], detection));
        const applicable = final.usesAi ? final.usesAi.answer === 'yes' : detection.applicable;

        if (pending.length) {
            const status = !row ? 'missing' : state0.status === 'expired' ? 'expired' : 'outdated';
            return { state: { ...state0, status }, findings, pending: questions, recorded: false, applicable };
        }

        const live = await deps.signalsFor(automation, state0.orgId, def);
        const signals = aiActCheck.effectiveSignals(live, { usesAi: final.usesAi ? final.usesAi.answer : 'no' });
        const registered = registerAnswers(final, row ? row.answers : null);
        const outcome = assess.outcome(signals, registered);
        const unchanged = state0.status === 'valid' && sameAsRecorded(row, { signals, answers: registered, outcome });
        if ((unchanged && !answers) || !record) return { state: state0, findings, pending: [], recorded: false, applicable };

        const people = Object.values(final).filter(q => q.by === 'person').length;
        const source = manual ? 'manual' : people === 0 ? 'auto' : 'mixed';
        const earlierPerson = row && row.attested_by && row.attested_by !== BEE ? row.attested_by : null;
        const attestedBy = source === 'auto' ? BEE : (actorId || earlierPerson || BEE);
        await deps.attest({
            orgId: state0.orgId,
            kind: 'automation',
            id: String(automation.id),
            signals,
            answers: registered,
            actorId: attestedBy,
            // Twelve months, "not applicable" included: the card promises a
            // yearly look, and an automatic check renews itself when it lapses.
            validMonths: 12,
            source,
            evidence: evidenceRecord(detection, final),
        });
        const state1 = await deps.aiActState(automation, def);
        return { state: state1, findings, pending: [], recorded: true, applicable };
    }

    /** The state the activation gate reads: the check, with its open questions (aiActCheck.gateRefusal). */
    async function gateState(automation, definition) {
        const r = await check(automation, definition, { record: true });
        return { ...r.state, pendingQuestions: r.pending };
    }

    return { check, gateState };
}

/**
 * The real IO, required lazily so requiring this file opens no connection:
 * the licence and register (aiActCheck.defaultAiActState), the shared
 * attestation writer, the fast-model classifier, the automation's signals and
 * the reusable Steps it calls.
 */
function defaultAiActAuto() {
    const stateFn = aiActCheck.defaultAiActState();
    const { defaultClassifier } = require('./aiActClassify');
    return makeAiActAuto({
        aiActState: stateFn,
        attest: (input) => require('../compliance/aiAct/attest').attest(input),
        classify: defaultClassifier(),
        signalsFor: defaultSignalsFor,
        internalDomainsOf: defaultInternalDomainsOf,
        loadBlocks: defaultLoadBlocks,
    });
}

/** The register's signals for the checked definition, with what only the database knows (live form pages, marking). */
async function defaultSignalsFor(automation, orgId, definition) {
    const signals = require('../compliance/aiAct/signals');
    let live = null;
    try { live = await signals.signalsForAutomation(orgId, automation.id); } catch { live = null; }
    return signals.signalsFromDefinition(definition, {
        title: automation.title, description: automation.description,
        liveFormPages: live?.surfaces?.live_form_pages || 0, markingEnabled: !!live?.marking_enabled,
    });
}

/** The mail domains that count as inside: the owner's. Best effort. */
async function defaultInternalDomainsOf(automation) {
    const owner = await require('../stores/userStore').getUser(automation.userId).catch(() => null);
    const email = typeof owner?.email === 'string' ? owner.email : '';
    const at = email.lastIndexOf('@');
    return at > 0 ? [email.slice(at + 1).toLowerCase()] : [];
}

/** The definitions of the reusable Steps a definition calls (one level; aiActDetect walks deeper with what it gets). */
function defaultLoadBlocks(definition) {
    return loadBlocksWith(require('../stores/automationStore'), definition);
}

/** Same, from any store with getAutomation(id). */
async function loadBlocksWith(store, definition) {
    const ids = new Set();
    for (const { step } of require('./automationGraph').listSteps(isObject(definition) ? definition : {})) {
        if (step.type === 'call_block' && typeof step.blockId === 'string') ids.add(step.blockId);
    }
    if (!ids.size) return null;
    const out = {};
    for (const id of ids) {
        const b = await store.getAutomation(id).catch(() => null);
        out[id] = b && isObject(b.definition) ? b.definition : null;
    }
    return out;
}

module.exports = {
    BEE,
    priorQuestions,
    mergeAnswers,
    applyPersonAnswers,
    registerAnswers,
    sameAsRecorded,
    evidenceRecord,
    makeAiActAuto,
    defaultAiActAuto,
    loadBlocksWith,
};
