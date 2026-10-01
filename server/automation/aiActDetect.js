/**
 * What Bee can work out about the AI Act on its own, per question, with how
 * sure it is (Studio → Automations handoff 5, "the check should be automatic").
 *
 * Every question the assessment needs is answered here as
 *
 *     { answer: 'yes'|'no'|'unknown', confidence: 'certain'|'likely'|'unknown',
 *       evidence: [{ code, params }], sig, lean?, domains?, practices? }
 *
 *   usesAi          read off the steps: certain either way, except a reusable
 *                   Step Bee could not look inside ('likely' no).
 *   externalOutput  (Art. 50) certain 'no' when no step sends or publishes
 *                   outward; certain 'yes' when AI output provably flows into
 *                   a step with a fixed outside recipient or a public page;
 *                   'likely' when recipients are templated or the flow is
 *                   indirect.
 *   sensitiveUse    (Annex III) and
 *   prohibitedUse   (Art. 5) from the fast-model verdict (aiActClassify.js):
 *                   only a confident "no" is certain. A "yes" is a legal
 *                   finding and is always put to a person ('likely'), a
 *                   medium or low verdict or no model at all is 'unknown'
 *                   (`lean` keeps what the model leaned to, for display).
 *
 * `sig` is the question's fingerprint: what Bee found, without step labels.
 * A person's answer is kept while the fingerprint stays the same
 * (aiActAuto.js), so renaming a step does not ask the question again but
 * adding an outside recipient does.
 *
 * Evidence never carries a recipient address or model prose: codes, step ids
 * and labels, and ids from fixed vocabularies (BFSF-441).
 *
 * Pure: the model verdict and the reusable Steps' definitions are handed in.
 */

'use strict';

const crypto = require('node:crypto');
const graph = require('./automationGraph');
const annexIii = require('../compliance/aiAct/annexIii');
const { ART5_PRACTICES } = require('../compliance/aiAct/assess');
const { stepIdsRead } = require('../shared/mapping/index.mjs');

const QUESTION_IDS = Object.freeze(['usesAi', 'externalOutput', 'sensitiveUse', 'prohibitedUse']);
const CONFIDENCES = Object.freeze(['certain', 'likely', 'unknown']);

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function labelOf(step) {
    const l = step && (step.label ?? step.name ?? step.title);
    return typeof l === 'string' && l.trim() ? l.trim().slice(0, 120) : (step && step.id ? String(step.id) : '');
}
function stepRef(step) { return { stepId: step.id ?? null, label: labelOf(step), type: step.type || null }; }
function ev(code, params) { return { code, params: params || {} }; }

// ── Uses AI ─────────────────────────────────────────────────────────────────

/**
 * Integration actions that are themselves a model: generated images, video,
 * speech, music, transcripts and AI-written decks.
 */
const AI_TOOLS = new Set([
    'generate_image', 'generate_video', 'elevenlabs_tts', 'elevenlabs_music', 'elevenlabs_sfx',
    'transcribe_audio', 'gamma_create_presentation', 'gamma_create_from_template', 'gamma_revise_as_new',
]);
const CONTAINERS = new Set(['loop', 'parallel']);
const MAX_BLOCK_DEPTH = 3;

/** The step without the children a loop or parallel carries. */
function ownPart(step) {
    const rest = { ...step };
    // Only a container's children are left out: an http_request's `body` is its own.
    if (step.type === 'loop') delete rest.body;
    if (step.type === 'parallel') delete rest.branches;
    return rest;
}

/** The step's own JSON, without the children a loop or parallel carries. */
function ownText(step) {
    if (!isObject(step)) return '';
    try { return JSON.stringify(ownPart(step)); } catch { return ''; }
}

/**
 * The steps a step itself reads through picks and composes, which name
 * their step as data (`{root:'steps', id:'ai_1'}`) and so never as the
 * `steps.<id>` text refersTo looks for.
 */
function ownStepReads(step) {
    return new Set(isObject(step) ? stepIdsRead(ownPart(step)) : []);
}

/**
 * What kind of model call a step makes, or null. The register's own list
 * (automationGraph.AI_STEP_TYPES) plus the steps that call a model on the
 * side: an AI-mode parse_json, a knowledge_write that merges near duplicates,
 * an AI-backed integration action and an "is about" rule (the topic
 * classifier). `summarize` is arithmetic (automationGraph.js).
 */
function aiKind(step) {
    if (!isObject(step)) return null;
    if (graph.isAiStep(step)) return step.type === 'ai_step' && step.agentId ? 'agent' : step.type;
    if (step.type === 'parse_json' && step.mode === 'ai') return 'parse_json';
    if (step.type === 'knowledge_write' && step.nearDuplicateStrategy === 'merge') return 'knowledge_write';
    if (step.type === 'integration_action' && AI_TOOLS.has(step.tool)) return 'ai_tool';
    if (!CONTAINERS.has(step.type) && ownText(step).includes('isAbout(')) return 'topic_rule';
    return null;
}

/**
 * The steps that hand work to a model. A reusable Step (call_block) is looked
 * into when `blocks[blockId]` is its definition; one Bee cannot look into is
 * listed in `unresolvedBlocks`. AI found inside a Step is reported as the
 * call_block step itself, type 'block'.
 *
 * @param {object} definition
 * @param {{ blocks?: Record<string, object|null>|null }} [opts]
 */
function detectAiUse(definition, { blocks = null } = {}) {
    const steps = [];
    const unresolved = [];
    const seenBlocks = new Set();
    const push = (list, ref) => { if (!list.some(x => x.stepId === ref.stepId && x.label === ref.label)) list.push(ref); };
    const visit = (def, depth, via) => {
        for (const { step } of graph.listSteps(isObject(def) ? def : {})) {
            const kind = aiKind(step);
            if (kind) {
                const ref = via ? { ...via, type: 'block' } : { ...stepRef(step), type: kind };
                if (!via && kind === 'ai_tool') ref.tool = step.tool;
                push(steps, ref);
                continue;
            }
            if (step.type !== 'call_block') continue;
            const outer = via || stepRef(step);
            const id = typeof step.blockId === 'string' ? step.blockId : '';
            const inner = id && blocks ? blocks[id] : undefined;
            if (!isObject(inner)) { push(unresolved, outer); continue; }
            if (seenBlocks.has(id) || depth >= MAX_BLOCK_DEPTH) continue;
            seenBlocks.add(id);
            visit(inner, depth + 1, outer);
        }
    };
    visit(definition, 0, null);
    return { detected: steps.length > 0, steps, unresolvedBlocks: unresolved };
}

// ── Where the output goes ───────────────────────────────────────────────────

/** Tools that mail a person; their recipients decide inside or outside. */
const MAIL_TOOLS = Object.freeze({
    gmail_compose: ['to', 'cc', 'bcc'],
    outlook_compose: ['to', 'cc', 'bcc'],
    nextcloud_mail_send: ['to', 'cc', 'bcc'],
});
/** Tools whose calendar invitations are mailed to their attendees. */
const INVITE_TOOLS = new Set([
    'calendar_create_event', 'calendar_update_event',
    'ms_calendar_create_event', 'ms_calendar_update_event',
    'nextcloud_calendar_create_event', 'nextcloud_calendar_update_event',
]);
/** webpage_* tools that only read; every other webpage_* tool changes a public page. */
const WEBPAGE_READS = new Set(['webpage_file_read', 'webpage_db_query', 'webpage_db_schema']);
/** Tools that hand data to another system (no person in sight, no telling who reads it). */
const SYSTEM_TOOLS = new Set(['n8n_workflow_execute']);

const EMAIL_RE = /^[^\s@{}]+@([^\s@{}]+\.[^\s@{}]+)$/;

/**
 * Who a recipient field reaches: 'none' (empty), 'internal' (every recipient a
 * literal address in `internalDomains`), 'fixed_external' (literal addresses,
 * at least one outside) or 'dynamic' (a template or anything that is not an
 * address: nobody can tell who it will be).
 */
function recipientClass(value, internalDomains) {
    const values = [];
    const collect = (v) => {
        if (v == null) return;
        if (Array.isArray(v)) { v.forEach(collect); return; }
        if (isObject(v)) { collect(v.email ?? v.address ?? v.value ?? null); return; }
        for (const part of String(v).split(/[,;]/)) { if (part.trim()) values.push(part.trim()); }
    };
    collect(value);
    if (!values.length) return 'none';
    const domains = (internalDomains || []).map(d => String(d).toLowerCase());
    let outside = false;
    for (const v of values) {
        const m = EMAIL_RE.exec(v.replace(/^.*<([^>]+)>\s*$/, '$1'));
        if (!m) return 'dynamic';
        if (!domains.includes(m[1].toLowerCase())) outside = true;
    }
    return outside ? 'fixed_external' : 'internal';
}

/** The older three-way reading: 'internal', 'none' or 'external'. */
function recipientsReach(value, internalDomains) {
    const c = recipientClass(value, internalDomains);
    return c === 'none' || c === 'internal' ? c : 'external';
}

/** Several recipient fields together; no recipient at all is decided elsewhere, so unclear. */
function fieldsClass(inputs, fields, internalDomains) {
    const classes = fields.map(f => recipientClass(inputs[f], internalDomains));
    if (classes.includes('dynamic')) return 'dynamic';
    if (classes.includes('fixed_external')) return 'fixed_external';
    if (classes.includes('internal')) return 'internal';
    return 'dynamic';
}

/**
 * The steps that put something in front of people outside the organisation,
 * in walk order: `{ step, ref, kind, reach }` with reach 'public',
 * 'fixed_external', 'dynamic' or 'system'. What stays inside is left out: an
 * in-app notification, a Talk message, a file in the own Nextcloud, a draft,
 * an e-mail to a colleague's literal address, a form (members of the owning
 * organisation only, automation/formAudience.js). A webhook caller gets 202
 * and no output (routes/automation/events.js), so it is not here either.
 */
function outwardSteps(definition, { internalDomains = [] } = {}) {
    const out = [];
    for (const { step } of graph.listSteps(isObject(definition) ? definition : {})) {
        const ref = stepRef(step);
        if (step.type === 'http_request') { out.push({ step, ref, kind: 'http', reach: 'system' }); continue; }
        if (step.type !== 'integration_action' || typeof step.tool !== 'string') continue;
        const tool = step.tool;
        const inputs = isObject(step.inputs) ? step.inputs : (isObject(step.params) ? step.params : {});
        const add = (kind, reach) => { if (reach !== 'internal' && reach !== 'none') out.push({ step, ref: { ...ref, tool }, kind, reach }); };
        if (MAIL_TOOLS[tool]) add('email', fieldsClass(inputs, MAIL_TOOLS[tool], internalDomains));
        else if (tool === 'nextcloud_share_by_email') add('share_by_email', fieldsClass(inputs, ['shareWith'], internalDomains));
        else if (tool === 'signrequest_send_document') add('signature_request', fieldsClass(inputs, ['signers'], internalDomains));
        else if (tool === 'linkedin_create_post') add('social_post', 'public');
        else if (tool.startsWith('webpage_') && !WEBPAGE_READS.has(tool)) add('webpage', 'public');
        else if (SYSTEM_TOOLS.has(tool)) add('http', 'system');
        else if (INVITE_TOOLS.has(tool)) add('calendar_invite', recipientClass(inputs.attendees, internalDomains));
    }
    return out;
}

function refersTo(text, stepId) {
    if (!text || !stepId) return false;
    const esc = String(stepId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- the step id is escaped and the pattern has no repeat at all: linear
    return new RegExp(`steps\\.${esc}(?![\\w-])|steps\\[['"]${esc}['"]\\]`).test(text);
}

/**
 * The ids of the steps whose inputs carry model output: the AI steps
 * themselves, every step that reads one of them (`steps.<id>` in a template
 * or a ref, or a pick of it), transitively, and the children of a tainted loop that read its
 * item. A flowlet with AI in it taints the call_layer step that runs it.
 */
function aiTaint(definition, aiStepIds) {
    const all = graph.listSteps(isObject(definition) ? definition : {});
    const tainted = new Set(aiStepIds.filter(Boolean));
    const layers = isObject(definition) && isObject(definition.layers) ? definition.layers : {};
    for (const { step } of all) {
        if (step.type === 'call_layer' && step.id && isObject(layers[step.layerKey])
            && graph.listSteps(layers[step.layerKey]).some(x => aiKind(x.step))) tainted.add(step.id);
    }
    const texts = new Map(all.map(x => [x, ownText(x.step)]));
    const picked = new Map(all.map(x => [x, ownStepReads(x.step)]));
    let changed = true;
    while (changed) {
        changed = false;
        for (const item of all) {
            const id = item.step.id;
            if (!id || tainted.has(id)) continue;
            const text = texts.get(item);
            const reads = [...tainted].some(t => refersTo(text, t) || picked.get(item).has(t))
                || (item.parentId && tainted.has(item.parentId) && /\bitem\b/.test(text));
            if (reads) { tainted.add(id); changed = true; }
        }
    }
    return tainted;
}

function outwardEvidence(o, carriesAi) {
    const params = { ...o.ref, reach: o.reach, carriesAi };
    const kindCode = o.kind === 'email' && o.reach === 'fixed_external' ? 'ai_act.external.email_fixed' : `ai_act.external.${o.kind}`;
    return [ev(kindCode, params), ev(carriesAi ? 'ai_act.external.ai_flows' : 'ai_act.external.no_ai', { stepId: o.ref.stepId, label: o.ref.label })];
}

/** Art. 50: does any of it reach people outside? See the header for the ladder. */
function externalQuestion(definition, aiSteps, { internalDomains = [] } = {}) {
    const outward = outwardSteps(definition, { internalDomains });
    if (!outward.length) return { answer: 'no', confidence: 'certain', evidence: [ev('ai_act.external.none')] };
    const tainted = aiTaint(definition, aiSteps.map(s => s.stepId));
    const withAi = outward.filter(o => o.step.id && tainted.has(o.step.id));
    const sure = withAi.filter(o => o.reach === 'fixed_external' || o.reach === 'public');
    if (sure.length) return { answer: 'yes', confidence: 'certain', evidence: sure.flatMap(o => outwardEvidence(o, true)) };
    if (withAi.length) return { answer: 'yes', confidence: 'likely', evidence: withAi.flatMap(o => outwardEvidence(o, true)) };
    return { answer: 'no', confidence: 'likely', evidence: outward.flatMap(o => outwardEvidence(o, false)) };
}

// ── The model's two questions ───────────────────────────────────────────────

const UNAVAILABLE = ev('ai_act.model.unavailable');
const UNSURE = ev('ai_act.model.unsure');

function tri(v) { return v === 'yes' || v === 'no' ? v : null; }

/** Annex III from the verdict; a keyword hint turns a confident "no" into a question. */
function sensitiveQuestion(verdict, hints) {
    const hintEv = hints.length ? [ev('ai_act.sensitive.hints', { domains: hints })] : [];
    if (!verdict || !verdict.available || !verdict.highRisk) {
        return { answer: 'unknown', confidence: 'unknown', lean: null, domains: [], evidence: [UNAVAILABLE, ...hintEv] };
    }
    const { answer, confidence } = verdict.highRisk;
    const domains = (verdict.highRisk.domains || []).filter(d => annexIii.ANNEX_III_IDS.includes(d));
    const a = tri(answer);
    if (a && confidence === 'high') {
        if (a === 'no') {
            return { answer: 'no', confidence: hints.length ? 'likely' : 'certain', domains: [], evidence: [ev('ai_act.sensitive.none_found'), ...hintEv] };
        }
        if (domains.length) return { answer: 'yes', confidence: 'likely', domains, evidence: [ev('ai_act.sensitive.found', { domains })] };
    }
    return { answer: 'unknown', confidence: 'unknown', lean: a, domains: a === 'yes' ? domains : [], evidence: [UNSURE, ...hintEv] };
}

/** Art. 5 from the verdict. */
function prohibitedQuestion(verdict) {
    if (!verdict || !verdict.available || !verdict.prohibited) {
        return { answer: 'unknown', confidence: 'unknown', lean: null, practices: [], evidence: [UNAVAILABLE] };
    }
    const { answer, confidence } = verdict.prohibited;
    const practices = (verdict.prohibited.practices || []).filter(p => ART5_PRACTICES.includes(p));
    const a = tri(answer);
    if (a === 'no' && confidence === 'high') return { answer: 'no', confidence: 'certain', practices: [], evidence: [ev('ai_act.prohibited.none_found')] };
    if (a === 'yes' && confidence === 'high') return { answer: 'yes', confidence: 'likely', practices, evidence: [ev('ai_act.prohibited.found', { practices })] };
    return { answer: 'unknown', confidence: 'unknown', lean: a, practices: a === 'yes' ? practices : [], evidence: [UNSURE] };
}

// ── Putting it together ─────────────────────────────────────────────────────

/** The question's fingerprint: what Bee found, without step labels. */
function signatureOf(q) {
    const shape = (q.evidence || []).map(e => {
        const p = e.params || {};
        return [e.code, p.stepId ?? null, p.reach ?? null, p.carriesAi ?? null, p.domains ?? null, p.practices ?? null,
            Array.isArray(p.steps) ? p.steps.map(s => `${s.stepId}:${s.type}`) : null];
    });
    return crypto.createHash('sha256').update(JSON.stringify([q.answer, q.confidence, q.lean ?? null, shape])).digest('hex').slice(0, 16);
}

/** The text the Annex III keyword hints read: title, description and the AI steps' instructions. */
function hintText({ definition, title = '', description = '' }) {
    const prompts = graph.listSteps(isObject(definition) ? definition : {})
        .filter(x => aiKind(x.step))
        .map(x => ['prompt', 'systemPrompt', 'instructions'].map(f => graph.templateText(x.step[f])).filter(Boolean).join('\n'));
    return [title, description, ...prompts].filter(Boolean).join('\n');
}

/**
 * Every question, answered as far as Bee can. `verdict` is the fast model's
 * answer (aiActClassify.js) or null when it was not asked; the two model
 * questions are then 'unknown'.
 *
 * @param {{ definition: object, title?: string, description?: string, internalDomains?: string[],
 *           blocks?: Record<string, object|null>|null, verdict?: object|null }} input
 * @returns {{ applicable: boolean|null, ai: object, questions: Record<string, object> }}
 *   applicable: true (AI found), false (certainly none), null (Bee could not tell)
 */
function detectQuestions({ definition, title = '', description = '', internalDomains = [], blocks = null, verdict = null }) {
    const ai = detectAiUse(definition, { blocks });
    let usesAi;
    if (ai.detected) {
        usesAi = { answer: 'yes', confidence: 'certain', evidence: [ev('ai_act.uses_ai.steps', { count: ai.steps.length, steps: ai.steps })] };
    } else if (ai.unresolvedBlocks.length) {
        usesAi = { answer: 'no', confidence: 'likely', evidence: ai.unresolvedBlocks.map(b => ev('ai_act.uses_ai.block_unknown', b)) };
    } else {
        usesAi = { answer: 'no', confidence: 'certain', evidence: [ev('ai_act.uses_ai.none')] };
    }
    const questions = {
        usesAi,
        externalOutput: externalQuestion(definition, ai.steps, { internalDomains }),
        sensitiveUse: sensitiveQuestion(verdict, annexIii.hintsIn(hintText({ definition, title, description }))),
        prohibitedUse: prohibitedQuestion(verdict),
    };
    for (const q of Object.values(questions)) q.sig = signatureOf(q);
    const applicable = ai.detected ? true : (usesAi.confidence === 'certain' ? false : null);
    return { applicable, ai, questions };
}

module.exports = {
    QUESTION_IDS,
    CONFIDENCES,
    AI_TOOLS,
    MAIL_TOOLS,
    INVITE_TOOLS,
    WEBPAGE_READS,
    labelOf,
    stepRef,
    aiKind,
    detectAiUse,
    recipientClass,
    recipientsReach,
    outwardSteps,
    aiTaint,
    externalQuestion,
    sensitiveQuestion,
    prohibitedQuestion,
    signatureOf,
    hintText,
    detectQuestions,
};
