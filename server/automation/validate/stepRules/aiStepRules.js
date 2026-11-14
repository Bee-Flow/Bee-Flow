// @typecheck strict
/**
 * The `ai_step` rules: its prompt, the output schema later steps bind against,
 * the agent it may borrow, that agent's skills and permissions, and the
 * prompt-placeholder lint. One check per part, run in order from AI_STEP_CHECKS
 * (the order of the findings is part of what the builder model reads).
 *
 * The question that drives the schema check: which fields of this step's
 * output does anything downstream actually read (`ctx.fieldsReadFromStep`). A
 * step that declares none of them answers free-form text, and every one of
 * those references resolves to nothing.
 */

const { isObject, collectRefPaths, rootOf, secondSegment } = require('../helpers');
const { AI_STEP_AGENT_PERMISSION_KEYS, MAX_AI_STEP_SKILL_IDS } = require('../constants');
const { schemaShape, explicitSchemaHint, flatSchemaHint } = require('./outputSchemaHints');

/**
 * @typedef {{ code: string, severity: string, path: string, message: string, hint?: string }} Finding
 * @typedef {{
 *   pushE: (f: Finding) => void,
 *   pushW: (f: Finding) => void,
 *   trigger: { id?: string },
 *   refIds: Set<string>,
 *   availableAgents?: Set<string> | null,
 *   fieldsReadFromStep: (id: string) => { all: string[], viaLoop: string[] },
 *   inferredOutputOf: (id: string) => { fields: string[], schema: any, textField?: string },
 * }} AiStepCtx
 * @typedef {Record<string, any>} AnyStep
 * @typedef {(ctx: AiStepCtx, step: AnyStep, at: string) => void} AiStepCheck
 */

/** @param {string[]} fields */
const quotedList = (fields) => fields.map(f => `\`${f}\``).join(', ');

/** @param {unknown} v @returns {boolean} */
const isSet = (v) => v !== undefined && v !== null;

/** A step with skills of its own (it answers in its leading skill's contract). @param {AnyStep} step */
const hasStepSkills = (step) => Array.isArray(step.skillIds) && step.skillIds.some((/** @type {unknown} */ id) => typeof id === 'string' && id);

/** @param {AnyStep} step */
const hasAgent = (step) => typeof step.agentId === 'string' && !!step.agentId.trim();

/** @param {unknown} list @returns {boolean} */
const isStringList = (list) => Array.isArray(list) && !list.some((id) => typeof id !== 'string');

/** @type {AiStepCheck} */
function checkPrompt({ pushE }, step, at) {
    if (!step.prompt || typeof step.prompt !== 'string') pushE({ code: 'ai_step.prompt_missing', severity: 'error', path: at + '.prompt', message: `Step ${step.id}: ai_step requires \`prompt\`.`, hint: 'Provide a non-empty prompt string.' });
}

/**
 * An ai_step with NO outputSchema returns free-form TEXT. Every
 * `…output.<field>` ref into it is then empty, and a dry run cannot show it:
 * the write step downstream is synthesised, never called. A build did exactly
 * this — read four invoices, extracted nothing bindable, and finalised green.
 * If anything reads a FIELD off this step, the schema is not optional.
 * @type {AiStepCheck}
 */
function checkOutputSchema(ctx, step, at) {
    const declaredFields = isObject(step.outputSchema)
        ? Object.keys(step.outputSchema.properties || step.outputSchema)
        : [];
    if (declaredFields.length) return;
    // What the runner will ask for: execAi infers the schema from how later
    // steps read this step (aiOutputInference.js) — direct reads, the
    // fan-out's `loop.<e>.output.<f>`, nested records, lists, bracket keys.
    // The finding shows that schema, so the author sees what the model will
    // be asked for instead of a flat `{x: string}` guess.
    const inferred = ctx.inferredOutputOf(step.id);
    if (inferred.fields.length) inferredSchemaFinding(ctx, step, at, inferred);
    unservedReadsFinding(ctx, step, at, inferred.fields);
}

/**
 * The warning for reads the runner serves from the schema it infers.
 * @param {AiStepCtx} ctx
 * @param {AnyStep} step
 * @param {string} at
 * @param {{ fields: string[], schema: any, textField?: string }} inferred
 */
function inferredSchemaFinding({ pushW }, step, at, inferred) {
    const fields = inferred.fields;
    const shown = inferred.schema ? schemaShape(inferred.schema) : '';
    const explicit = inferred.schema ? explicitSchemaHint(inferred.schema) : '';
    // Without a schema of its own, a step with skills answers in its LEADING
    // skill's output contract (execAi via aiStepSkills). Whether that skill
    // declares the fields read here is a database question this pass cannot
    // answer, so it warns instead of blocking.
    if (hasStepSkills(step)) {
        pushW({
            code: 'ai_step.output_schema_from_skill',
            severity: 'warning',
            path: at + '.outputSchema',
            message: `Step ${step.id}: later steps read ${quotedList(fields)} from this step, which has no outputSchema of its own. It answers in the output fields of its leading skill; a field the skill does not declare is added as the runner infers it from those reads: ${shown}.`,
            hint: `Check the leading skill's output fields, or give the step its own schema: ${explicit}`,
        });
        return;
    }
    // The runner serves these reads, so the automation runs — an ERROR here
    // would 400 every save of a working automation (a label edit PUTs the
    // whole definition) and refuse to re-activate it. A warning, because an
    // inferred schema is a guess at types: an explicit one is tighter.
    pushW({
        code: 'ai_step.output_schema_inferred',
        severity: 'warning',
        path: at + '.outputSchema',
        message: `Step ${step.id}: later steps read ${quotedList(fields)} from this step and it declares no outputSchema — the runner infers ${shown} from those references${inferred.textField ? ` and wraps a prose answer under \`${inferred.textField}\`` : ''}.`,
        hint: `An explicit schema gives tighter, typed output: ${explicit}`,
    });
}

/**
 * Reads the runner cannot serve from any schema it infers. Completeness-listed:
 * warn at draft, block activation (see completenessCodes.js). The usual one: a
 * field read straight off a PER-ITEM step, whose output is the list of answers
 * — reported even next to reads that ARE inferred, since no schema fixes it.
 * @param {AiStepCtx} ctx
 * @param {AnyStep} step
 * @param {string} at
 * @param {string[]} inferredFields
 */
function unservedReadsFinding({ pushE, fieldsReadFromStep }, step, at, inferredFields) {
    const { all: wanted, viaLoop } = fieldsReadFromStep(step.id);
    const perItem = isObject(step.forEach) && typeof step.forEach.overRef === 'string' && !!step.forEach.overRef;
    const unserved = perItem ? wanted.filter(f => !viaLoop.includes(f)) : (inferredFields.length ? [] : wanted);
    if (!unserved.length) return;
    const f0 = unserved[0];
    pushE({
        code: 'ai_step.output_schema_missing',
        severity: 'error',
        path: at + '.outputSchema',
        message: perItem
            ? `Step ${step.id}: later steps read ${quotedList(unserved)} straight off this step, but it runs once per item — its output is the list of answers, so those references resolve to nothing.`
            : `Step ${step.id}: later steps read ${quotedList(unserved)} from this step, but it declares no outputSchema — without one it answers free-form text and every one of those references resolves to nothing.`,
        hint: perItem
            ? `Read every answer's ${f0} as steps.${step.id}.output.results[*].output.${f0}, or run the next step once per answer over steps.${step.id}.output.results and read loop.<item>.output.${f0}.`
            : `Give it those fields, e.g. ${flatSchemaHint(unserved)}`,
    });
}

/**
 * allowTools:true with an EMPTY explicit allowlist grants NO tools at run time
 * — surface the incoherent pair so the user sees why their "tool-using" step
 * runs bare. Warning at every stage; never blocks.
 * @type {AiStepCheck}
 */
function checkToolsAllowlist({ pushW }, step, at) {
    if (step.allowTools === true && Array.isArray(step.tools) && step.tools.length === 0) {
        pushW({ code: 'ai_step.tools_allowlist_empty', severity: 'warning', path: at + '.tools', message: `Step ${step.id}: allowTools is on but the tool allowlist is empty — this step runs with NO tools.`, hint: 'Pick tools in the step\'s Tools section, or turn "Allow tools" off.' });
    }
}

/**
 * Shape only: whether an id actually resolves to a knowledge base this
 * user/org may read is a DB question, checked at run time by execAiStep (which
 * drops — never silently searches — an id that doesn't belong to the runner).
 * This validator stays pure/DB-free, same stance the approval/assignee checks
 * take.
 * @type {AiStepCheck}
 */
function checkKnowledgeBaseIds({ pushE }, step, at) {
    if (isSet(step.knowledgeBaseIds) && !isStringList(step.knowledgeBaseIds)) {
        pushE({ code: 'ai_step.knowledge_base_ids_invalid', severity: 'error', path: at + '.knowledgeBaseIds', message: `Step ${step.id}: knowledgeBaseIds must be an array of knowledge-base id strings.`, hint: 'Pick knowledge bases from the step\'s Knowledge bases picker, or remove the field.' });
    }
}

// ── The agent (and the skills) this step hands the work to ──
//
// `agentId` turns an ai_step into an AGENT step: the agent's published role,
// knowledge and tools do the work instead of the step's own
// prompt-and-nothing-else. Three things are checked here and one deliberately
// is not.
//
// WHAT IS CHECKED HERE. Shape, always; and identity — does this agent exist,
// is it in the automation owner's organisation, is it published — whenever the
// caller injected a catalog. The catalog is a Set of agent ids the AUTOMATION
// OWNER may actually use, built by whoever has the database in hand
// (routes/automation/crud.js on activate). Same construction as
// `availableTools`: without one this validator stays the pure, DB-free pass it
// is for every other rule.
//
// ONE ANSWER FOR THREE FAILURES, ON PURPOSE. An id from another organisation
// is NOT reported differently from an id that does not exist. If it were,
// anyone who can author an automation could ask this validator "is agt_x a
// real agent somewhere?" and read the answer off the error code — an
// automation editor turned into an existence oracle for every other workspace
// on the install. So deleted, foreign, not-shared-with-you and never-published
// all produce the SAME code, the same severity, the same path and the same
// message; the hint names all four possibilities because the author has to be
// able to fix it, and naming all four tells them nothing about which one it
// was.
//
// WHAT IS NOT CHECKED HERE, AND WHAT HAPPENS INSTEAD. This rule runs when the
// automation is SAVED and when it is ACTIVATED. The run happens later — days
// later, on a schedule, with nobody watching — and by then the agent may have
// been deleted, unpublished, moved to another organisation, or had its sharing
// narrowed. No validation can see that, so a save-time check is a courtesy,
// not a gate. The gate is at run time: execAiStep re-asks the same question of
// the world as it is (resolveStepAgent in core/automationRunner/aiStepAgent.js)
// and FAILS the step when the answer is no. It does not fall back to running
// the step's own prompt without the agent — that would be an automation
// quietly doing different work than it says it does, with a green run behind
// it. A failed step is visible, has an error branch, and says which agent it
// wanted.

/** @type {AiStepCheck} */
function checkAgentId({ pushE, availableAgents }, step, at) {
    if (isSet(step.agentId) && typeof step.agentId !== 'string') {
        // Never half-typed: the field comes from a picker, so a number or an
        // object here means the definition is wrong rather than unfinished.
        // Blocks at every stage.
        pushE({ code: 'ai_step.agent_id_invalid', severity: 'error', path: at + '.agentId', message: `Step ${step.id}: agentId must be the id of an agent, as a string.`, hint: 'Pick an agent in the step, or remove the field to let the step answer on its own prompt.' });
    } else if (hasAgent(step) && availableAgents instanceof Set && !availableAgents.has(step.agentId.trim())) {
        pushE({
            code: 'ai_step.agent_unavailable', severity: 'error', path: at + '.agentId',
            message: `Step ${step.id}: there is no agent "${step.agentId}" this automation can use.`,
            hint: 'Pick an agent in the step. The same answer is given whether the agent was deleted, was never published, belongs to another workspace, or is not shared with this automation\'s owner — deliberately, so an automation cannot be used to find out which agents exist elsewhere.',
        });
    }
}

/**
 * The skills, IN ORDER: the first is the leading one, which is why a stored
 * list that is too long is a warning about WHICH skills are lost rather than a
 * silent truncation at run time.
 * @type {AiStepCheck}
 */
function checkSkillIds({ pushE, pushW }, step, at) {
    if (!isSet(step.skillIds)) return;
    if (!isStringList(step.skillIds)) {
        pushE({ code: 'ai_step.skill_ids_invalid', severity: 'error', path: at + '.skillIds', message: `Step ${step.id}: skillIds must be an array of skill id strings.`, hint: 'Pick skills in the step, or remove the field.' });
        return;
    }
    const ids = step.skillIds.filter((/** @type {string} */ id) => id);
    const dupes = [...new Set(ids.filter((/** @type {string} */ id, /** @type {number} */ i) => ids.indexOf(id) !== i))];
    if (dupes.length) {
        const one = dupes.length === 1;
        pushW({ code: 'ai_step.skill_ids_ignored', severity: 'warning', path: at + '.skillIds', message: `Step ${step.id}: ${one ? 'skill' : 'skills'} ${dupes.map(d => `"${d}"`).join(', ')} ${one ? 'is' : 'are'} listed more than once — the repeat is ignored.`, hint: 'Remove the duplicate; the first entry is the leading skill and decides the order.' });
    }
    const unique = [...new Set(ids)];
    if (unique.length > MAX_AI_STEP_SKILL_IDS) {
        pushW({ code: 'ai_step.skill_ids_ignored', severity: 'warning', path: at + '.skillIds', message: `Step ${step.id}: ${unique.length} skills are attached but only the first ${MAX_AI_STEP_SKILL_IDS} are used — ${unique.slice(MAX_AI_STEP_SKILL_IDS).map(d => `"${d}"`).join(', ')} never reach the model.`, hint: `Keep at most ${MAX_AI_STEP_SKILL_IDS}, most important first.` });
    }
}

/**
 * The agent's own skills this step does not use. A list of ids, and only
 * meaningful on a step with an agent.
 * @type {AiStepCheck}
 */
function checkDisabledAgentSkills({ pushE, pushW }, step, at) {
    const list = step.disabledAgentSkillIds;
    if (!isSet(list)) return;
    if (!isStringList(list)) {
        pushE({ code: 'ai_step.disabled_agent_skill_ids_invalid', severity: 'error', path: at + '.disabledAgentSkillIds', message: `Step ${step.id}: disabledAgentSkillIds must be a list of skill id strings.`, hint: 'Switch the agent\'s skills on or off in the step, or remove the field.' });
    } else if (list.length && !hasAgent(step)) {
        pushW({ code: 'ai_step.disabled_agent_skill_ids_orphan', severity: 'warning', path: at + '.disabledAgentSkillIds', message: `Step ${step.id}: this step switches agent skills off but names no agent, so nothing reads it.`, hint: 'Pick an agent for the step, or remove disabledAgentSkillIds.' });
    }
}

/**
 * agentPermissions: ABSENT MEANS NONE.
 *
 * Written out as a warning rather than assumed, because the one way this layer
 * has gone wrong twice is a missing key growing into "everything". The grants
 * map in core/agentRuntime/toolPolicy.js does read a missing app entry as
 * "every action of this app", and that is right THERE: those agents had that
 * toolbelt before the picker existed, so reading absence broadly gives nobody
 * anything new. An ai_step bound to an agent has no such yesterday — the field
 * is new, the surface is new — so the exception has nothing to stand on and
 * absence is three plain noes.
 *
 * A shape nobody can read is refused rather than coerced, for the reason
 * `actions: 'gmail_search'` is refused over there: a coerced `"false"` is
 * truthy, and a truthy value nobody wrote is the widest possible answer to the
 * least readable input. It is completeness-listed all the same, because only a
 * raw PUT or an import can produce one and such an automation has to stay
 * openable and fixable — it just cannot go live.
 * @type {AiStepCheck}
 */
function checkAgentPermissions(ctx, step, at) {
    const { pushE, pushW } = ctx;
    const perms = step.agentPermissions;
    if (!isSet(perms)) {
        if (hasAgent(step)) {
            pushW({ code: 'ai_step.agent_permissions_missing', severity: 'warning', path: at + '.agentPermissions', message: `Step ${step.id}: no agent permissions are set, so the agent answers from its role alone — no knowledge bases, no tools, and it cannot start other automations.`, hint: 'That is the deliberate default. Turn on only what this step needs in the step\'s permissions.' });
        }
        return;
    }
    if (!isObject(perms)) {
        pushE({ code: 'ai_step.agent_permissions_invalid', severity: 'error', path: at + '.agentPermissions', message: `Step ${step.id}: agentPermissions must be an object of ${AI_STEP_AGENT_PERMISSION_KEYS.join('/')} booleans.`, hint: 'Use the step\'s permission toggles, or remove the field — leaving it out means the agent gets none of them.' });
        return;
    }
    checkPermissionValues(ctx, step, at, perms);
}

/**
 * Each permission a boolean, no invented ones, and someone to read them.
 * @param {AiStepCtx} ctx
 * @param {AnyStep} step
 * @param {string} at
 * @param {Record<string, unknown>} perms
 */
function checkPermissionValues({ pushE, pushW }, step, at, perms) {
    for (const key of AI_STEP_AGENT_PERMISSION_KEYS) {
        if (perms[key] !== undefined && typeof perms[key] !== 'boolean') {
            pushE({ code: 'ai_step.agent_permissions_invalid', severity: 'error', path: at + `.agentPermissions.${key}`, message: `Step ${step.id}: agentPermissions.${key} must be true or false, not ${JSON.stringify(perms[key])}.`, hint: 'A value nothing can read is not a yes — it is treated as off. Set it to true or false.' });
        }
    }
    const unknown = Object.keys(perms).filter(k => !AI_STEP_AGENT_PERMISSION_KEYS.includes(k));
    if (unknown.length) {
        pushW({ code: 'ai_step.agent_permissions_unknown', severity: 'warning', path: at + '.agentPermissions', message: `Step ${step.id}: ${unknown.map(k => `"${k}"`).join(', ')} is not a permission this step grants — it is stored and does nothing.`, hint: `The permissions are ${AI_STEP_AGENT_PERMISSION_KEYS.join(', ')}. Remove the rest so the step does not read as more configured than it is.` });
    }
    // A step that applies skills without an agent reads the switches too
    // (skill knowledge, a skill that runs an automation).
    if (!hasAgent(step) && !hasStepSkills(step)) {
        pushW({ code: 'ai_step.agent_permissions_orphan', severity: 'warning', path: at + '.agentPermissions', message: `Step ${step.id}: this step sets agent permissions but names no agent, so nothing reads them.`, hint: 'Pick an agent for the step, or remove agentPermissions.' });
    }
}

/** Placeholder roots that always resolve in a prompt. */
const PROMPT_ROOTS = new Set(['trigger', 'vars', 'secrets', 'loop']);

/**
 * Prompt placeholder lint: the runner interpolates the prompt with
 * leaveUnresolved:true — a {{steps.ghost.output.x}} typo means the model
 * literally receives that brace text. The step's own input NAMES are valid
 * roots here (the runner spreads resolvedInputs into the prompt scope).
 * Warnings only: a prompt can never crash a run and must never block a save.
 * @type {AiStepCheck}
 */
function checkPromptPlaceholders({ pushW, refIds, trigger }, step, at) {
    /** @type {Array<{ kind: string, path?: string }>} */
    const promptRefs = [];
    collectRefPaths({ kind: 'template', value: step.prompt || '' }, promptRefs);
    const ownInputs = new Set(Object.keys(isObject(step.inputs) ? step.inputs : {}));
    for (const r of promptRefs) {
        if (r.kind !== 'ref' || !r.path) continue;
        const root = rootOf(r.path);
        if (!root || PROMPT_ROOTS.has(root)) continue;
        if (ownInputs.has(root)) continue; // paraphrased own input — resolves at run time
        if (root !== 'steps') {
            pushW({ code: 'ref.prompt_unknown_root', severity: 'warning', path: at + '.prompt', message: `Step ${step.id}: prompt placeholder "{{${r.path}}}" has no matching input or data root — the model receives it verbatim.`, hint: 'Use trigger/steps/vars/loop paths, one of this step\'s own input names, or plain text.' });
            continue;
        }
        const upstreamId = secondSegment(r.path);
        if (upstreamId && !refIds.has(upstreamId) && upstreamId !== step.id) {
            pushW({ code: 'ref.prompt_unknown_step', severity: 'warning', path: at + '.prompt', message: `Step ${step.id}: prompt references non-existent step "${upstreamId}" — the model will receive the literal {{…}} text.`, hint: `Fix the id or remove the placeholder. Available: ${Array.from(refIds).filter(x => x !== trigger.id).join(', ') || '(none)'}.` });
        }
    }
}

/** Every ai_step check, in the order its findings are reported. @type {AiStepCheck[]} */
const AI_STEP_CHECKS = [
    checkPrompt, checkOutputSchema, checkToolsAllowlist, checkKnowledgeBaseIds,
    checkAgentId, checkSkillIds, checkDisabledAgentSkills, checkAgentPermissions,
    checkPromptPlaceholders,
];

/**
 * @param {AiStepCtx} ctx
 * @param {AnyStep} step
 * @param {string} at
 */
function checkAiStep(ctx, step, at) {
    if (step.type !== 'ai_step') return;
    for (const check of AI_STEP_CHECKS) check(ctx, step, at);
}

module.exports = { checkAiStep };
