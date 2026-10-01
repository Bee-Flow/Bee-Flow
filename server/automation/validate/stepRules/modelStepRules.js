/**
 * The two steps that hand the work to a MODEL: `ai_step` (its prompt, the
 * output schema later steps bind against, the agent it may borrow, that
 * agent's skills and permissions, and the prompt-placeholder lint) and
 * `data_extraction` (the text it reads and the fields it pulls out of it).
 *
 * They share the question that drives both: which fields of this step's output
 * does anything downstream actually read (`ctx.fieldsReadFromStep`). A step
 * that declares none of them answers free-form text, and every one of those
 * references resolves to nothing.
 */

const {
    isObject, hasText, collectRefPaths, rootOf, secondSegment,
} = require('../helpers');
const {
    AI_STEP_AGENT_PERMISSION_KEYS, MAX_AI_STEP_SKILL_IDS,
    DATA_EXTRACTION_FIELD_TYPES, DATA_EXTRACTION_FIELD_NAME_RE,
    DATA_EXTRACTION_MAX_FIELDS, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS,
} = require('../constants');
const { RUNTIME_ROOTS, isPick, isCompose, MAPPING_VERSION } = require('../../../shared/mapping/index.mjs');

function checkAiStep(ctx, step, at) {
    const { pushE, pushW, trigger, refIds, availableAgents, fieldsReadFromStep } = ctx;
    if (step.type === 'ai_step') {
        if (!step.prompt || !(typeof step.prompt === 'string' || hasText(step.prompt))) pushE({ code: 'ai_step.prompt_missing', severity: 'error', path: at + '.prompt', message: `Step ${step.id}: ai_step requires \`prompt\`.`, hint: 'Provide a non-empty prompt string.' });
        // An ai_step with NO outputSchema returns free-form TEXT. Every
        // `…output.<field>` ref into it is then empty, and a dry run cannot
        // show it: the write step downstream is synthesised, never called.
        // A build did exactly this — read four invoices, extracted nothing
        // bindable, and finalised green (2026-09-12). If anything reads a
        // FIELD off this step, the schema is not optional.
        const declaredFields = isObject(step.outputSchema)
            ? Object.keys(step.outputSchema.properties || step.outputSchema)
            : [];
        // Handoff 5: without a schema of its own, a step with skills answers
        // in its LEADING skill's output contract (execAi via aiStepSkills).
        // Whether that skill declares the fields read here is a database
        // question this pass cannot answer, so it warns instead of blocking.
        const hasStepSkills = Array.isArray(step.skillIds) && step.skillIds.some((id) => typeof id === 'string' && id);
        if (!declaredFields.length) {
            const { all: wanted, viaLoop } = fieldsReadFromStep(step.id);
            const example = (fields) => `outputSchema: {"type":"object","properties":{${fields.slice(0, 3).map(f => `"${f}":{"type":"string"}`).join(',')}}}. Numbers as {"type":"number"}.`;
            if (viaLoop.length && hasStepSkills) {
                pushW({
                    code: 'ai_step.output_schema_from_skill',
                    severity: 'warning',
                    path: at + '.outputSchema',
                    message: `Step ${step.id}: later steps read ${wanted.map(f => `\`${f}\``).join(', ')} from this step, which has no outputSchema of its own. It answers in the output fields of its leading skill; any of these fields that skill does not declare stays empty.`,
                    hint: `Check the leading skill's output fields, or give the step its own schema, e.g. ${example(wanted)}`,
                });
            } else if (viaLoop.length) {
                // The fan-out shape is the one the runner's safety net
                // does NOT cover: execAi.js infers a schema from direct
                // `steps.<id>.output.<f>` refs only, so a
                // `loop.<v>.output.<f>` read really does resolve to
                // nothing. Completeness-listed: warn at draft, block
                // activation (see completenessCodes.js).
                pushE({
                    code: 'ai_step.output_schema_missing',
                    severity: 'error',
                    path: at + '.outputSchema',
                    message: `Step ${step.id}: later steps read ${wanted.map(f => `\`${f}\``).join(', ')} from this step, but it declares no outputSchema — without one it answers free-form text and every one of those references resolves to nothing.`,
                    hint: `Give it those fields, e.g. ${example(wanted)}`,
                });
            } else if (wanted.length) {
                // Direct refs only: the runner infers { <fields>: string }
                // from exactly these refs and wraps a prose answer under
                // the first field (execAi.js collectAiStepOutputFields),
                // so the routine runs — this was an ERROR that 400'd every
                // save of a working routine (a label edit PUTs the whole
                // definition) and refused to re-activate it.
                pushW({
                    code: 'ai_step.output_schema_inferred',
                    severity: 'warning',
                    path: at + '.outputSchema',
                    message: `Step ${step.id}: later steps read ${wanted.map(f => `\`${f}\``).join(', ')} from this step and it declares no outputSchema — the runner infers {${wanted.map(f => `${f}: string`).join(', ')}} from those references and wraps a prose answer under \`${wanted[0]}\`.`,
                    hint: `An explicit schema gives tighter, typed output: ${example(wanted)}`,
                });
            }
        }
        // allowTools:true with an EMPTY explicit allowlist now grants NO
        // tools at run time (C14) — surface the incoherent pair so the
        // user sees why their "tool-using" step runs bare. Warning at
        // every stage; never blocks.
        if (step.allowTools === true && Array.isArray(step.tools) && step.tools.length === 0) {
            pushW({ code: 'ai_step.tools_allowlist_empty', severity: 'warning', path: at + '.tools', message: `Step ${step.id}: allowTools is on but the tool allowlist is empty — this step runs with NO tools.`, hint: 'Pick tools in the step\'s Tools section, or turn "Allow tools" off.' });
        }
        // Shape only (C29 — BFSF-410): whether an id actually resolves to a
        // knowledge base this user/org may read is a DB question, checked at
        // run time by execAiStep (which drops — never silently searches — an
        // id that doesn't belong to the runner). This validator stays
        // pure/DB-free, same stance the approval/assignee checks above take.
        if (step.knowledgeBaseIds !== undefined && step.knowledgeBaseIds !== null) {
            if (!Array.isArray(step.knowledgeBaseIds) || step.knowledgeBaseIds.some((id) => typeof id !== 'string')) {
                pushE({ code: 'ai_step.knowledge_base_ids_invalid', severity: 'error', path: at + '.knowledgeBaseIds', message: `Step ${step.id}: knowledgeBaseIds must be an array of knowledge-base id strings.`, hint: 'Pick knowledge bases from the step\'s Knowledge bases picker, or remove the field.' });
            }
        }
        // ── R2 — the agent (and the skills) this step hands the work to ──
        //
        // `agentId` turns an ai_step into an AGENT step: the agent's
        // published role, knowledge and tools do the work instead of the
        // step's own prompt-and-nothing-else. Three things are checked
        // here and one deliberately is not.
        //
        // WHAT IS CHECKED HERE. Shape, always; and identity — does this
        // agent exist, is it in the routine owner's organisation, is it
        // published — whenever the caller injected a catalog. The catalog
        // is a Set of agent ids the ROUTINE OWNER may actually use, built
        // by whoever has the database in hand (routes/automation/crud.js
        // on activate). Same construction as `availableTools`: without one
        // this validator stays the pure, DB-free pass it is for every
        // other rule in this file.
        //
        // ONE ANSWER FOR THREE FAILURES, ON PURPOSE. An id from another
        // organisation is NOT reported differently from an id that does
        // not exist. If it were, anyone who can author a routine could ask
        // this validator "is agt_x a real agent somewhere?" and read the
        // answer off the error code — a routine editor turned into an
        // existence oracle for every other workspace on the install. So
        // deleted, foreign, not-shared-with-you and never-published all
        // produce the SAME code, the same severity, the same path and the
        // same message; the hint names all four possibilities because the
        // author has to be able to fix it, and naming all four tells them
        // nothing about which one it was.
        //
        // WHAT IS NOT CHECKED HERE, AND WHAT HAPPENS INSTEAD. This rule
        // runs when the routine is SAVED and when it is ACTIVATED. The run
        // happens later — days later, on a schedule, with nobody watching
        // — and by then the agent may have been deleted, unpublished,
        // moved to another organisation, or had its sharing narrowed. No
        // validation can see that, so a save-time check is a courtesy, not
        // a gate. The gate is at run time: execAiStep re-asks the same
        // question of the world as it is (resolveStepAgent in
        // core/automationRunner/aiStepAgent.js) and FAILS the step when
        // the answer is no. It does not fall back to running the step's own
        // prompt without the agent — that would be a routine quietly
        // doing different work than it says it does, with a green run
        // behind it. A failed step is visible, has an error branch, and
        // says which agent it wanted.
        if (step.agentId !== undefined && step.agentId !== null && typeof step.agentId !== 'string') {
            // Never half-typed: the field comes from a picker, so a number
            // or an object here means the definition is wrong rather than
            // unfinished. Blocks at every stage.
            pushE({ code: 'ai_step.agent_id_invalid', severity: 'error', path: at + '.agentId', message: `Step ${step.id}: agentId must be the id of an agent, as a string.`, hint: 'Pick an agent in the step, or remove the field to let the step answer on its own prompt.' });
        } else if (typeof step.agentId === 'string' && step.agentId.trim() && availableAgents instanceof Set
            && !availableAgents.has(step.agentId.trim())) {
            pushE({
                code: 'ai_step.agent_unavailable', severity: 'error', path: at + '.agentId',
                message: `Step ${step.id}: there is no agent "${step.agentId}" this routine can use.`,
                hint: 'Pick an agent in the step. The same answer is given whether the agent was deleted, was never published, belongs to another workspace, or is not shared with this routine\'s owner — deliberately, so a routine cannot be used to find out which agents exist elsewhere.',
            });
        }
        // The skills, IN ORDER: the first is the leading one, which is why
        // a stored list that is too long is a warning about WHICH skills
        // are lost rather than a silent truncation at run time.
        if (step.skillIds !== undefined && step.skillIds !== null) {
            if (!Array.isArray(step.skillIds) || step.skillIds.some((id) => typeof id !== 'string')) {
                pushE({ code: 'ai_step.skill_ids_invalid', severity: 'error', path: at + '.skillIds', message: `Step ${step.id}: skillIds must be an array of skill id strings.`, hint: 'Pick skills in the step, or remove the field.' });
            } else {
                const ids = step.skillIds.filter((id) => id);
                const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
                if (dupes.length) {
                    pushW({ code: 'ai_step.skill_ids_ignored', severity: 'warning', path: at + '.skillIds', message: `Step ${step.id}: ${new Set(dupes).size === 1 ? 'skill' : 'skills'} ${[...new Set(dupes)].map(d => `"${d}"`).join(', ')} ${new Set(dupes).size === 1 ? 'is' : 'are'} listed more than once — the repeat is ignored.`, hint: 'Remove the duplicate; the first entry is the leading skill and decides the order.' });
                }
                const unique = [...new Set(ids)];
                if (unique.length > MAX_AI_STEP_SKILL_IDS) {
                    pushW({ code: 'ai_step.skill_ids_ignored', severity: 'warning', path: at + '.skillIds', message: `Step ${step.id}: ${unique.length} skills are attached but only the first ${MAX_AI_STEP_SKILL_IDS} are used — ${unique.slice(MAX_AI_STEP_SKILL_IDS).map(d => `"${d}"`).join(', ')} never reach the model.`, hint: `Keep at most ${MAX_AI_STEP_SKILL_IDS}, most important first.` });
                }
            }
        }
        // ── disabledAgentSkillIds (handoff 5) ──────────────────
        // The agent's own skills this step does not use. A list of ids, and
        // only meaningful on a step with an agent.
        if (step.disabledAgentSkillIds !== undefined && step.disabledAgentSkillIds !== null) {
            if (!Array.isArray(step.disabledAgentSkillIds) || step.disabledAgentSkillIds.some((id) => typeof id !== 'string')) {
                pushE({ code: 'ai_step.disabled_agent_skill_ids_invalid', severity: 'error', path: at + '.disabledAgentSkillIds', message: `Step ${step.id}: disabledAgentSkillIds must be a list of skill id strings.`, hint: 'Switch the agent\'s skills on or off in the step, or remove the field.' });
            } else if (step.disabledAgentSkillIds.length && !(typeof step.agentId === 'string' && step.agentId.trim())) {
                pushW({ code: 'ai_step.disabled_agent_skill_ids_orphan', severity: 'warning', path: at + '.disabledAgentSkillIds', message: `Step ${step.id}: this step switches agent skills off but names no agent, so nothing reads it.`, hint: 'Pick an agent for the step, or remove disabledAgentSkillIds.' });
            }
        }
        // ── agentPermissions: ABSENT MEANS NONE ─────────────────
        //
        // Written out as a warning rather than assumed, because the one
        // way this layer has gone wrong twice is a missing key growing
        // into "everything". The grants map in
        // core/agentRuntime/toolPolicy.js does read a missing app entry as
        // "every action of this app", and that is right THERE: those
        // agents had that toolbelt before the picker existed, so reading
        // absence broadly gives nobody anything new. An ai_step bound to
        // an agent has no such yesterday — the field is new, the surface
        // is new — so the exception has nothing to stand on and absence is
        // three plain noes.
        //
        // A shape nobody can read is refused rather than coerced, for the
        // reason `actions: 'gmail_search'` is refused over there: a
        // coerced `"false"` is truthy, and a truthy value nobody wrote is
        // the widest possible answer to the least readable input. It is
        // completeness-listed all the same, because only a raw PUT or an
        // import can produce one and such a routine has to stay openable
        // and fixable — it just cannot go live.
        const perms = step.agentPermissions;
        const hasAgent = typeof step.agentId === 'string' && !!step.agentId.trim();
        if (perms !== undefined && perms !== null) {
            if (!isObject(perms)) {
                pushE({ code: 'ai_step.agent_permissions_invalid', severity: 'error', path: at + '.agentPermissions', message: `Step ${step.id}: agentPermissions must be an object of ${AI_STEP_AGENT_PERMISSION_KEYS.join('/')} booleans.`, hint: 'Use the step\'s permission toggles, or remove the field — leaving it out means the agent gets none of them.' });
            } else {
                for (const key of AI_STEP_AGENT_PERMISSION_KEYS) {
                    if (perms[key] !== undefined && typeof perms[key] !== 'boolean') {
                        pushE({ code: 'ai_step.agent_permissions_invalid', severity: 'error', path: at + `.agentPermissions.${key}`, message: `Step ${step.id}: agentPermissions.${key} must be true or false, not ${JSON.stringify(perms[key])}.`, hint: 'A value nothing can read is not a yes — it is treated as off. Set it to true or false.' });
                    }
                }
                const unknown = Object.keys(perms).filter(k => !AI_STEP_AGENT_PERMISSION_KEYS.includes(k));
                if (unknown.length) {
                    pushW({ code: 'ai_step.agent_permissions_unknown', severity: 'warning', path: at + '.agentPermissions', message: `Step ${step.id}: ${unknown.map(k => `"${k}"`).join(', ')} is not a permission this step grants — it is stored and does nothing.`, hint: `The permissions are ${AI_STEP_AGENT_PERMISSION_KEYS.join(', ')}. Remove the rest so the step does not read as more configured than it is.` });
                }
                // A step that applies skills without an agent reads the
                // switches too (skill knowledge, a skill that runs a routine).
                if (!hasAgent && !hasStepSkills) {
                    pushW({ code: 'ai_step.agent_permissions_orphan', severity: 'warning', path: at + '.agentPermissions', message: `Step ${step.id}: this step sets agent permissions but names no agent, so nothing reads them.`, hint: 'Pick an agent for the step, or remove agentPermissions.' });
                }
            }
        } else if (hasAgent) {
            pushW({ code: 'ai_step.agent_permissions_missing', severity: 'warning', path: at + '.agentPermissions', message: `Step ${step.id}: no agent permissions are set, so the agent answers from its role alone — no knowledge bases, no tools, and it cannot start other routines.`, hint: 'That is the deliberate default. Turn on only what this step needs in the step\'s permissions.' });
        }
        // An input named after a runtime root. The prompt scope used to let it
        // REPLACE that root, so {{trigger.output.…}} reached the model as
        // literal braces; the runner now keeps the roots (execAi aiPromptScope)
        // and the input reaches the model only in the framed Inputs block, so
        // a {{<name>}} in the prompt reads the root, not the input. A warning,
        // never a block: a stored step with such a name still runs.
        for (const name of Object.keys(isObject(step.inputs) ? step.inputs : {})) {
            if (!RUNTIME_ROOTS.includes(name)) continue;
            pushW({
                code: 'ai_step.input_shadows_root', severity: 'warning', path: `${at}.inputs.${name}`,
                message: `Step ${step.id}: the input "${name}" has the name of a data root, so {{${name}}} in the prompt reads the root, not this input.`,
                hint: `Rename the input (for example "${name}Data") and use that name in the prompt.`,
            });
        }
        // Prompt placeholder lint (C28): the runner interpolates the
        // prompt with leaveUnresolved:true — a {{steps.ghost.output.x}}
        // typo means the model literally receives that brace text. The
        // step's own input NAMES are valid roots here (the runner spreads
        // resolvedInputs into the prompt scope). Warnings only: a prompt
        // can never crash a run and must never block a save.
        {
            const promptRefs = [];
            collectRefPaths({ kind: 'template', value: step.prompt || '' }, promptRefs);
            const ownInputs = new Set(Object.keys(isObject(step.inputs) ? step.inputs : {}));
            for (const r of promptRefs) {
                if (r.kind !== 'ref' || !r.path) continue;
                const root = rootOf(r.path);
                if (!root) continue;
                if (root === 'trigger' || root === 'vars' || root === 'secrets' || root === 'loop') continue;
                if (ownInputs.has(root)) continue; // paraphrased own input — resolves at run time
                if (root === 'steps') {
                    const upstreamId = secondSegment(r.path);
                    if (upstreamId && !refIds.has(upstreamId) && upstreamId !== step.id) {
                        pushW({ code: 'ref.prompt_unknown_step', severity: 'warning', path: at + '.prompt', message: `Step ${step.id}: prompt references non-existent step "${upstreamId}" — the model will receive the literal {{…}} text.`, hint: `Fix the id or remove the placeholder. Available: ${Array.from(refIds).filter(x => x !== trigger.id).join(', ') || '(none)'}.` });
                    }
                    continue;
                }
                pushW({ code: 'ref.prompt_unknown_root', severity: 'warning', path: at + '.prompt', message: `Step ${step.id}: prompt placeholder "{{${r.path}}}" has no matching input or data root — the model receives it verbatim.`, hint: 'Use trigger/steps/vars/loop paths, one of this step\'s own input names, or plain text.' });
            }
        }
    }
}

function checkDataExtraction(ctx, step, at) {
    const { pushE, pushW, fieldsReadFromStep } = ctx;
    if (step.type === 'data_extraction') {
        // `source` is the text the model reads: a binding, never absent.
        // Missing — absent, blank, or the empty scaffold the palette drops
        // — is COMPLETENESS: the node lands before it is wired. A bare
        // STRING is tolerated by the runner (a `{{…}}` template or a
        // ref-looking path is resolved; anything else is read literally),
        // so it only warns; any other non-binding value is integrity —
        // the runner would serialise it and extract from the words.
        //
        // A v2 pick or compose is a binding too (sites.mjs lists `source` as
        // a compose-capable text site; execDataExtraction resolves it). One
        // that says `v: 1` but does not validate is mappingRules' error
        // (mapping.invalid), so it is not reported twice here; one without
        // `v` is plain data to the runner, and stays source_invalid.
        const src = step.source;
        const isMapping = isPick(src) || isCompose(src);
        const isBinding = isMapping || (isObject(src) && typeof src.kind === 'string' && ['ref', 'template', 'literal', 'expr'].includes(src.kind));
        const brokenMapping = !isMapping && isObject(src) && (src.kind === 'pick' || src.kind === 'compose') && src.v === MAPPING_VERSION;
        const bindingBlank = isBinding && (
            (src.kind === 'ref' && !(typeof src.path === 'string' && src.path.trim()))
            || (src.kind === 'compose' && !hasText(src))
            || (!isMapping && src.kind !== 'ref' && !(typeof src.value === 'string' ? src.value.trim() : src.value !== undefined && src.value !== null))
        );
        const emptyScaffold = (isObject(src) && !isBinding && Object.keys(src).length === 0) || (typeof src === 'string' && !src.trim());
        if (src === undefined || src === null || bindingBlank || emptyScaffold) {
            pushE({ code: 'data_extraction.source_missing', severity: 'error', path: at + '.source', message: `Step ${step.id}: there is no text to read yet.`, hint: 'Bind `source` to the text an earlier step produced, e.g. {kind:"ref", path:"steps.read.output.content"} — or loop.<item>.output.content inside a fan-out.' });
        } else if (typeof src === 'string') {
            pushW({ code: 'data_extraction.source_bare_string', severity: 'warning', path: at + '.source', message: `Step ${step.id}: source is a bare string; it is read as a ${/\{\{[^}]+\}\}/.test(src) ? 'template' : (/^\s*(trigger|steps|vars|loop)\./.test(src) ? 'reference path' : 'LITERAL text, not a reference')}.`, hint: 'Prefer a binding: {kind:"ref", path:"steps.<id>.output.<field>"}.' });
        } else if (!isBinding && !brokenMapping) {
            pushE({ code: 'data_extraction.source_invalid', severity: 'error', path: at + '.source', message: `Step ${step.id}: source must be a binding ({kind:"ref", path:"…"}), not a bare value.`, hint: 'Point it at an upstream value: {kind:"ref", path:"steps.<id>.output.<field>"}.' });
        } else if (src.kind === 'ref' && /\.(path|fileId|file_id|size|modified|contentType|mimeType|href|url)\s*$/.test(src.path)) {
            // The builder saw a read step fail, dropped it, and pointed
            // the extraction at loop.f.path — the listing's file path —
            // and this validator passed it (2026-09-12). A path is a
            // location, not text: warn, so activation shows it.
            pushW({ code: 'data_extraction.source_is_location', severity: 'warning', path: at + '.source', message: `Step ${step.id}: source "${src.path.trim()}" is a file's location, not its text — the extraction model would read the words of a path.`, hint: 'Read the file first (e.g. nextcloud_read_file with forEach over the listing) and bind source to that step\'s content: loop.<item>.output.content.' });
        }
        // `fields` is the output shape — the names become `steps.<id>.
        // output.<name>` keys and later bindings, so they are held to a
        // plain-identifier pattern, kept unique, and typed from the enum.
        // An empty list is completeness (the palette seeds one blank row);
        // a bad name or type is integrity and blocks at every stage.
        const rows = Array.isArray(step.fields) ? step.fields : [];
        const namedRows = rows.filter(f => isObject(f) && typeof f.name === 'string' && f.name.trim());
        if (!Array.isArray(step.fields) || namedRows.length === 0) {
            pushE({ code: 'data_extraction.fields_missing', severity: 'error', path: at + '.fields', message: `Step ${step.id}: no fields to extract yet.`, hint: 'Add at least one field: a lowercase name (becomes the output key), a type (string, number, boolean, date) and what to look for.' });
        } else {
            if (rows.length > DATA_EXTRACTION_MAX_FIELDS) {
                pushE({ code: 'data_extraction.fields_too_many', severity: 'error', path: at + '.fields', message: `Step ${step.id}: ${rows.length} fields is more than the limit of ${DATA_EXTRACTION_MAX_FIELDS}.`, hint: 'Split the extraction over two steps, or drop the fields nothing downstream reads.' });
            }
            const seenNames = new Set();
            rows.forEach((f, i) => {
                if (!isObject(f)) {
                    pushE({ code: 'data_extraction.field_name_invalid', severity: 'error', path: `${at}.fields[${i}]`, message: `Step ${step.id}: field ${i + 1} is not a field object.`, hint: 'Each field is {name, type, description, required}.' });
                    return;
                }
                const name = typeof f.name === 'string' ? f.name.trim() : '';
                if (!name) {
                    // A blank row beside filled ones is the palette's seed row
                    // left over — still mid-typing, so completeness.
                    pushE({ code: 'data_extraction.fields_missing', severity: 'error', path: `${at}.fields[${i}].name`, message: `Step ${step.id}: field ${i + 1} has no name yet.`, hint: 'Name it (lowercase letters, digits and underscores) or remove the row.' });
                } else if (!DATA_EXTRACTION_FIELD_NAME_RE.test(name)) {
                    pushE({ code: 'data_extraction.field_name_invalid', severity: 'error', path: `${at}.fields[${i}].name`, message: `Step ${step.id}: "${name}" is not a valid field name.`, hint: 'Lowercase letters, digits and underscores, starting with a letter, at most 40 characters — e.g. invoice_date. It becomes the output key steps.<id>.output.<name>.' });
                } else if (seenNames.has(name)) {
                    pushE({ code: 'data_extraction.fields_duplicate', severity: 'error', path: `${at}.fields[${i}].name`, message: `Step ${step.id}: the field "${name}" is declared twice.`, hint: 'Every field name must be unique within the step — it is an output key.' });
                } else {
                    seenNames.add(name);
                }
                // Absent, null or blank reads as `string` everywhere (the
                // palette's seed row, an older import); only a VALUE that
                // is not a type is refused.
                if (f.type !== undefined && f.type !== null && f.type !== '' && !DATA_EXTRACTION_FIELD_TYPES.has(f.type)) {
                    pushE({ code: 'data_extraction.field_type_invalid', severity: 'error', path: `${at}.fields[${i}].type`, message: `Step ${step.id}: "${f.type}" is not a field type.`, hint: `Use one of: ${[...DATA_EXTRACTION_FIELD_TYPES].join(', ')}. A date is written as YYYY-MM-DD.` });
                }
            });
            // A downstream step reading a field this step never declares
            // gets null forever. Warn — the author may still be adding it.
            if (seenNames.size) {
                const undeclared = fieldsReadFromStep(step.id).all.filter(f => !seenNames.has(f));
                if (undeclared.length) {
                    pushW({ code: 'data_extraction.field_not_declared', severity: 'warning', path: at + '.fields', message: `Step ${step.id}: later steps read ${undeclared.map(f => `\`${f}\``).join(', ')} from this step, but it does not extract ${undeclared.length > 1 ? 'those fields' : 'that field'}.`, hint: 'Add the field here, or point the downstream binding at one of the declared fields.' });
                }
            }
        }
        if (step.instructions !== undefined && step.instructions !== null) {
            if (typeof step.instructions !== 'string') {
                pushE({ code: 'data_extraction.instructions_too_long', severity: 'error', path: at + '.instructions', message: `Step ${step.id}: instructions must be text.`, hint: 'A short note for the model, e.g. "Amounts are in euros."' });
            } else if (step.instructions.length > DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS) {
                pushE({ code: 'data_extraction.instructions_too_long', severity: 'error', path: at + '.instructions', message: `Step ${step.id}: instructions are ${step.instructions.length} characters; the limit is ${DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS}.`, hint: 'Keep it to the few things the model would otherwise get wrong — units, language, which of two similar dates.' });
            }
        }
    }
}

module.exports = { checkAiStep, checkDataExtraction };
