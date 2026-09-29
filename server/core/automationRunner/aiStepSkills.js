/**
 * Skills inside an AI step (Studio → Automations, handoff 5, round 3).
 *
 * `execAi.js` loads the step's skills ONCE and hands the rows to these pure
 * helpers, which answer four questions about them:
 *
 *   1. Which skill LEADS. The step's own skills come first (in the author's
 *      order), then the agent's skills minus the ones the step switched off
 *      (`disabledAgentSkillIds`). The leading skill is the first of those that
 *      the routine owner can actually read: the one whose instructions come
 *      first, and whose output fields the step hands on.
 *   2. What the step hands on (its OUTPUT CONTRACT). A step with its own
 *      `outputSchema` keeps it. Without one, the leading skill's
 *      `output_schema` is the contract, widened by any field a later step
 *      reads that the skill does not declare (as text), so a downstream ref
 *      never resolves to nothing. A skill with no schema (null) leaves the
 *      step on the fields inferred from downstream refs, as before.
 *   3. What the active skills GRANT beyond their text: knowledge bases, apps
 *      and routines (`skillInjection.skillGrantsOf`). Each grant only counts
 *      under the step's switch that is about it: knowledge under
 *      `useKnowledge`, apps under `useTools`, routines under
 *      `startAutomations`. A switch that is off keeps its promise whatever a
 *      skill says. Same static/dynamic partition as the prompt and as chat: a
 *      dynamic skill grants nothing until it is loaded, and a routine step has
 *      no second turn in which to load it.
 *   4. How an agent (or a skill written for chat) is told it is a STEP: it
 *      never asks anything back and never waits for a confirmation, because
 *      nobody reads its answer before the next step runs.
 *
 * Nothing here does I/O, so every branch is tested without a database.
 */

'use strict';

/** Longest `disabledAgentSkillIds` list worth storing; agents carry far fewer. */
const MAX_DISABLED_AGENT_SKILL_IDS = 50;

function _ids(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        if (typeof raw !== 'string') continue;
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/** The agent skills this step switched off, clean and capped. */
function sanitizeDisabledAgentSkillIds(v) {
    return _ids(v).slice(0, MAX_DISABLED_AGENT_SKILL_IDS);
}

/**
 * The skill rows in RUN order: the order of `orderedIds` (the capped merged
 * list the injection uses), keeping only rows the store returned. A skill the
 * routine owner cannot read is simply not there, exactly as in the prompt.
 */
function orderSkills(skills, orderedIds) {
    const byId = new Map();
    for (const s of Array.isArray(skills) ? skills : []) {
        if (s && typeof s.id === 'string' && !byId.has(s.id)) byId.set(s.id, s);
    }
    const out = [];
    for (const id of Array.isArray(orderedIds) ? orderedIds : []) {
        const s = byId.get(id);
        if (s) out.push(s);
    }
    return out;
}

function _plainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A skill's output contract as a JSON-schema object, or null when it declares no fields. */
function skillOutputSchema(skill) {
    const schema = skill && skill.outputSchema;
    if (!_plainObject(schema) || !_plainObject(schema.properties)) return null;
    const keys = Object.keys(schema.properties).filter((k) => _plainObject(schema.properties[k]));
    if (!keys.length) return null;
    const properties = {};
    for (const k of keys) properties[k] = schema.properties[k];
    const out = { type: 'object', properties };
    if (Array.isArray(schema.required)) {
        const req = schema.required.filter((k) => typeof k === 'string' && properties[k]);
        if (req.length) out.required = req;
    }
    return out;
}

/**
 * The schema this step answers in, and where it came from.
 *
 * @param {object} args
 * @param {*}        args.stepSchema     `step.outputSchema` (wins when set)
 * @param {object|null} args.skillSchema the leading skill's schema (skillOutputSchema)
 * @param {string[]} args.inferredFields fields later steps read off this step
 * @returns {{ schema: object|null, source: 'step'|'skill'|'inferred'|null, declared: boolean }}
 *   `declared` is true when the author (or the skill) promised the shape, so a
 *   prose answer is a failure rather than something to wrap.
 */
function effectiveOutputSchema({ stepSchema = null, skillSchema = null, inferredFields = [] } = {}) {
    if (stepSchema) return { schema: stepSchema, source: 'step', declared: true };
    const inferred = Array.isArray(inferredFields) ? inferredFields.filter((f) => typeof f === 'string' && f) : [];
    if (skillSchema && _plainObject(skillSchema.properties)) {
        const properties = { ...skillSchema.properties };
        for (const f of inferred) if (!properties[f]) properties[f] = { type: 'string' };
        const schema = { type: 'object', properties };
        if (Array.isArray(skillSchema.required) && skillSchema.required.length) schema.required = [...skillSchema.required];
        return { schema, source: 'skill', declared: true };
    }
    if (inferred.length) {
        return { schema: Object.fromEntries(inferred.map((f) => [f, 'string'])), source: 'inferred', declared: false };
    }
    return { schema: null, source: null, declared: false };
}

/**
 * The fields of a JSON-schema object as the step editor lists them:
 * `[{ key, type, title }]` with type one of string, number, boolean,
 * datetime, array, object. A date or date-time string reads as `datetime`.
 */
function outputFieldsOf(schema) {
    if (!_plainObject(schema) || !_plainObject(schema.properties)) return [];
    const out = [];
    for (const [key, def] of Object.entries(schema.properties)) {
        const d = _plainObject(def) ? def : {};
        let type = typeof d.type === 'string' ? d.type : 'string';
        if (type === 'integer') type = 'number';
        if (type === 'string' && (d.format === 'date' || d.format === 'date-time')) type = 'datetime';
        if (!['string', 'number', 'boolean', 'datetime', 'array', 'object'].includes(type)) type = 'string';
        out.push({ key, type, title: typeof d.title === 'string' && d.title ? d.title : null });
    }
    return out;
}

/**
 * What the ACTIVE skills of this step grant, merged and deduped.
 *
 * `helpers` are skillInjection's own readers (skillGrantsOf, isDynamicSkill,
 * sanitizeEnabledIntegrations), injected so this stays one rule with chat.
 *
 * @returns {{ kbIds: string[], apps: string[], automationIds: string[] }}
 */
function skillGrantsForStep(skills, helpers) {
    const out = { kbIds: [], apps: [], automationIds: [] };
    if (!helpers || typeof helpers.skillGrantsOf !== 'function') return out;
    const kb = new Set();
    const apps = new Set();
    const autos = new Set();
    for (const s of Array.isArray(skills) ? skills : []) {
        let dynamic = true;
        try { dynamic = typeof helpers.isDynamicSkill === 'function' ? helpers.isDynamicSkill(s) : !!(s.dynamicActivation || s.automationId); } catch (_) { dynamic = true; }
        if (dynamic) continue;
        let g = null;
        try { g = helpers.skillGrantsOf(s); } catch (_) { g = null; }
        if (g) {
            for (const id of g.kbIds || []) kb.add(id);
            for (const id of g.automationIds || []) autos.add(id);
        }
        let skillApps = [];
        try {
            skillApps = typeof helpers.sanitizeEnabledIntegrations === 'function'
                ? helpers.sanitizeEnabledIntegrations(s.enabledIntegrations)
                : _ids(s.enabledIntegrations);
        } catch (_) { skillApps = []; }
        for (const a of skillApps) apps.add(a);
    }
    out.kbIds = [...kb];
    out.apps = [...apps];
    out.automationIds = [...autos];
    return out;
}

/**
 * The grants that survive the step's switches. A switch that is off drops
 * its whole grant; nothing here widens a switch.
 *
 * @param {{kbIds:string[],apps:string[],automationIds:string[]}} grants
 * @param {{startAutomations:boolean,useKnowledge:boolean,useTools:boolean}} permissions
 */
function grantsUnderPermissions(grants, permissions) {
    const g = grants || {};
    const p = permissions || {};
    return {
        kbIds: p.useKnowledge === true ? [...(g.kbIds || [])] : [],
        apps: p.useTools === true ? [...(g.apps || [])] : [],
        automationIds: p.startAutomations === true ? [...(g.automationIds || [])] : [],
    };
}

/**
 * An agent config whose routine grants also hold the routines a skill grants.
 *
 * Only for an agent whose owner CURATED its routines (the `automations` key is
 * present): an uncurated agent is already offered every routine the routine
 * owner may call, so there is nothing to add. The ids stay inside the routine
 * owner's own set either way, because the catalog is built for them. A
 * shallow copy: the runtime projection of the agent is shared.
 */
function configWithSkillAutomations(config, automationIds) {
    const ids = _ids(automationIds);
    if (!ids.length || !_plainObject(config) || !_plainObject(config.tools)) return config;
    if (!Object.prototype.hasOwnProperty.call(config.tools, 'automations')) return config;
    const current = _plainObject(config.tools.automations) ? config.tools.automations : null;
    // An unreadable section is a decision nobody can read; widening it would
    // turn that into "these routines, at least", which is not ours to say.
    if (!current) return config;
    const automations = { ...current };
    for (const id of ids) if (!Object.prototype.hasOwnProperty.call(automations, id)) automations[id] = {};
    return { ...config, tools: { ...config.tools, automations } };
}

/** A field whose name says it holds the doubts: the design calls it "Points of attention". */
const ATTENTION_FIELD_RE = /attention|aandacht|caveat|concern|doubt|uncertain|twijfel|remark|opmerking/i;

function attentionFieldOf(schema) {
    if (!_plainObject(schema)) return null;
    const props = _plainObject(schema.properties) ? schema.properties : schema;
    for (const key of Object.keys(props)) if (ATTENTION_FIELD_RE.test(key)) return key;
    return null;
}

/**
 * The sentence that makes an agent (or a skill written for chat) behave as a
 * step: nobody answers a question here, nobody confirms anything, and a doubt
 * goes into the output instead of into a question.
 */
function unattendedStepFraming(schema) {
    const field = attentionFieldOf(schema);
    const where = field
        ? `write what you were unsure about in the "${field}" field of your answer`
        : 'say what you were unsure about in your answer';
    return '\n\nYou are one step in an automation, not a conversation. Nobody reads your answer before the next step runs, '
        + 'so never ask the user anything back and never wait for a confirmation: there is nobody to answer. '
        + `When something is unclear, make the most reasonable choice, carry on, and ${where}.`;
}

const EMPTY_GRANTS = Object.freeze({ kbIds: [], apps: [], automationIds: [] });

/**
 * Load the step's skills once and derive everything above from them.
 *
 * The one function here that does I/O, through `deps` (skillInjection's
 * loadSkillsForIds and its grant readers). Best effort in the same way as the
 * injection: a failed read leaves the step without skills rather than failing
 * it, and says so in the log. No organisation, no skills: the same tenant
 * rule `buildSkillInjection` applies.
 *
 * @returns {Promise<{ loaded: boolean, skills: Object[], orderedIds: string[],
 *   leading: Object|null, leadingSchema: Object|null,
 *   grants: {kbIds:string[],apps:string[],automationIds:string[]} }>}
 */
async function loadStepSkillContext({ step, ctx, binding = null, deps = {} }) {
    const empty = { loaded: false, skills: [], orderedIds: [], leading: null, leadingSchema: null, grants: { ...EMPTY_GRANTS } };
    let ids;
    try {
        const agentMod = deps.aiStepAgent || require('./aiStepAgent');
        ids = agentMod.skillIdsForStep(step, binding);
    } catch (_) { return empty; }
    if (!ids.attachedSkillIds.length && !ids.sessionSkillIds.length) return empty;
    if (!ctx || !ctx.orgId) return empty;
    let injection;
    try { injection = deps.skillInjection || require('../tools/skillInjection'); } catch (_) { return empty; }
    if (!injection || typeof injection.loadSkillsForIds !== 'function') return empty;
    let loaded;
    try {
        loaded = await injection.loadSkillsForIds({ ...ids, orgId: ctx.orgId, userId: ctx.userId });
    } catch (e) {
        const log = deps.log || require('../../telemetry/log');
        log.warn(`[AutomationRunner] ai_step ${step && step.id}: skills could not be read (${e && e.message}), continuing without them`);
        return empty;
    }
    const skills = orderSkills(loaded && loaded.skills, loaded && loaded.mergedIds);
    const leading = skills[0] || null;
    return {
        loaded: true,
        skills,
        orderedIds: (loaded && loaded.mergedIds) || [],
        leading,
        leadingSchema: skillOutputSchema(leading),
        grants: skillGrantsForStep(skills, injection),
    };
}

module.exports = {
    MAX_DISABLED_AGENT_SKILL_IDS,
    loadStepSkillContext,
    sanitizeDisabledAgentSkillIds,
    orderSkills,
    skillOutputSchema,
    effectiveOutputSchema,
    outputFieldsOf,
    skillGrantsForStep,
    grantsUnderPermissions,
    configWithSkillAutomations,
    attentionFieldOf,
    unattendedStepFraming,
};
