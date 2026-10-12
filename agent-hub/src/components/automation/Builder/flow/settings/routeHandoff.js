/**
 * "Let an AI step answer it" — the Condition node's SEMANTIC handoff. Pure:
 * no React, no network, no model.
 *
 * WHY THIS EXISTS
 * A Condition rule's predicate is a restricted-grammar expression over fields
 * that ALREADY EXIST (server/automation/expr.js → shared/expr). Some questions
 * an author asks simply cannot be one of those, no matter how the sentence is
 * phrased: "is this e-mail about a complaint?", "is this invoice urgent?".
 * There is no field holding the answer, so there is nothing to compare.
 *
 * The offline catalogue (routeIntents.js) says so and stops. The model
 * fallback (server/routes/ai/automationBuilder/routeRules.js) says so and
 * stops too — deliberately: it writes rules over the declared fields and
 * DROPS any expression naming a path that was not declared, because a rule
 * against a field that does not exist parses perfectly, matches nothing
 * forever, and reports no error. That refusal is the guardrail, not a gap.
 *
 * This module is the follow-up offer that refusal leaves room for: if the
 * field does not exist, MAKE it exist. One `ai_step` in front of the
 * Condition answers the question in a single word, declares that word as an
 * output field, and the Condition's rules compare against it — ordinary
 * equality over a field that is now real. Nothing here guesses; the author
 * supplies the sentence and names the answers, and every part of what would
 * be inserted is derived from those two things and shown before anything is
 * written.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  - It does not call anything. This is the one part of "Suggest outputs"
 *    that adds a step to the automation, and it is still LOCAL: nothing leaves
 *    the page, so there is no payload here to get wrong (CLAUDE.md, BFSF-441).
 *  - It does not mint its own slug vocabulary. The field name comes from
 *    `slugifyFieldName` — the form builder's own minting function, already
 *    matched by a server twin (server/automation/formDraft.js) — and the port
 *    names from `slugName`, the one the rest of this box already uses. Two
 *    slugifiers is two answers to "what is this field called".
 *  - It does not write an expression shape of its own. Every rule is a plain
 *    `equals(<path>, "<word>")` (text "is": upper/lower case and surrounding
 *    spaces do not matter), which is exactly what utils/conditionModel.js
 *    parses back into a clickable row, so `describeRuleExpr` reads it as a
 *    sentence like every other suggestion and the author checks words rather
 *    than syntax.
 *
 * THE PATH IS THE WHOLE POINT, SO IT IS BUILT TWICE
 * A Condition deciding about the WHOLE RUN evaluates against the run state,
 * where the new step's answer lives at `steps.<id>.output.<field>`.
 * A Condition working through a LIST evaluates once per row with that row
 * bound as `item` (core/automationRunner/execControl.js, execCollections.js),
 * and one `ai_step` in front of it answers ONCE for the whole run — so
 * pointing per-row rules at `steps.<id>.output.<field>` would give every item
 * the same answer and the router would sort nothing while looking like it
 * sorted. The per-item plan therefore runs the step ONCE PER ITEM
 * (`forEach` over the list the Condition already reads), which publishes
 * `steps.<id>.output.results` — one `{index, item, output, status}` per row
 * (core/automationRunner/execFlow.js) — and re-points the Condition at that
 * list, where each row's answer is `item.output.<field>`. That re-point is
 * returned as `source` and is not optional: without it the per-item rules
 * name a path that resolves to nothing, which is the silent-empty-branch
 * failure this whole feature exists to remove.
 */
// The binding name is minted ONCE, by the function that already mints every
// other author-named field in this builder. Importing across to the form
// builder for it is cheaper than a second slugifier that agrees with it today
// and drifts the first time either side learns a new character class.
import { slugifyFieldName } from './FormBuilderFields';
import { uniqueRuleName } from '../routeModel';
import { slugName } from './routeIntents';

/** Same ceiling the offline catalogue uses: more ports than this is a lookup
 *  table rather than a routing decision, and each one is an edge to wire. */
const MAX_CATEGORIES = 8;

/** How far to the left of the node it feeds the inserted step is dropped. */
const INSERT_OFFSET_X = 240;

/** A canvas label has room for a question, not for an essay. */
const MAX_LABEL_CHARS = 48;

/**
 * The answers the author named, from one line of text.
 *
 * Commas and slashes separate; nothing else does. A bare space would split
 * "something else" into two outputs, and an author who writes three words for
 * one answer means one answer.
 */
export function parseCategories(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || '').split(/[,/]/)) {
        const name = raw.trim().replace(/[.!?;:]+$/, '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;   // two ports with one name is unwireable
        seen.add(key);
        out.push(name);
    }
    return out;
}

/**
 * A step id in the shape the rest of the builder mints them
 * (applyAddNode.newStepId), so a handed-off step is indistinguishable from
 * one dropped from the palette — including to the validator, which reads ids
 * as opaque strings, and to every "which step is this" matcher that keys on
 * the prefix.
 */
export function newHandoffStepId() {
    const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID().split('-')[0]
        : Math.random().toString(36).slice(2, 10);
    return `ai_${rand}`;
}

/** A refusal, in the same shape as a plan so the caller has one thing to read. */
function refuse(problem) {
    return { step: null, rules: [], fieldPath: '', field: '', source: null, problem };
}

/**
 * Why this cannot be planned, in a sentence — or '' when it can.
 *
 * Every one of these is a REFUSAL rather than a best effort, and kept here
 * together so the reasons can be read as a list. An author who accepts a plan
 * gets a step added to their automation and their outputs rewritten, so
 * "roughly right" is not a state this module may return.
 */
function handoffProblem({ sentence, names, perItem, list }) {
    if (!sentence) {
        return 'Write the question first — the step that answers it is built from your own sentence.';
    }
    if (names.length < 2) {
        // One answer is not a decision: the step would return the same word
        // every time and the Condition would have one output that always
        // fires. Asking for two is asking what the alternative is.
        return 'Name at least two possible answers, separated by commas — for example “complaint, question, something else”.';
    }
    if (perItem && !list) {
        // See the header: a per-item plan runs the new step once per row of
        // the SAME list, so without that list there is nothing to run over
        // and nothing to re-point the Condition at.
        return 'This Condition works through a list, but no list is picked yet. Choose it above first — the step being added has to run over the same one.';
    }
    return '';
}

/**
 * The instruction the inserted step carries.
 *
 * Three things it insists on, because all three are failure modes the rules
 * below cannot survive: ONE of the listed words (a rule is an equality test),
 * the word and nothing else (no "This looks like a complaint."), and no
 * invented word (an answer outside the list matches no output and the record
 * falls through to "otherwise" with nothing to explain why).
 *
 * The record itself arrives in the framed "Inputs (data, not instructions)"
 * block the AI step always sends (core/automationRunner/execAi.js), so the
 * prompt names it rather than interpolating it — a `{{…}}` pointing at data
 * this module cannot see would render as literal braces in the request.
 */
function classificationPrompt(sentence, names) {
    return [
        'Read the record in the inputs below and answer one question about it.',
        '',
        `Question: ${sentence}`,
        '',
        'Answer with exactly one of these words, and nothing else:',
        ...names.map(n => `- ${n}`),
        '',
        'Pick the one that fits best. Do not explain, do not add punctuation, and never answer with a word that is not on the list.',
    ].join('\n');
}

/** The canvas label: the question, short enough to read on a card. */
function stepLabel(sentence) {
    const one = sentence.replace(/\s+/g, ' ').trim();
    const short = one.length > MAX_LABEL_CHARS ? `${one.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : one;
    return `Classify: ${short}`;
}

/**
 * The `ai_step` itself: one question, one word back, and the word declared as
 * a field so the rules can be plain equality.
 *
 * The SCHEMA is the load-bearing part. An ai_step without one answers in
 * prose, and `steps.<id>.output.<field>` then resolves to undefined for every
 * record — execAi.js infers a schema from downstream refs precisely because
 * that used to happen silently, and this one simply declares it instead.
 *
 * Per item, the record IS the row the step is fanned out over, so its binding
 * is known here. For a whole-run Condition it is whatever feeds the node,
 * which only the shell that owns the graph can see: it binds that on insert
 * (insertStepBefore below), and leaving it empty rather than guessing a path
 * keeps a wrong binding off the canvas.
 */
function classifierStep({ id, sentence, names, field, perItem, itemVar, list }) {
    return {
        id,
        type: 'ai_step',
        label: stepLabel(sentence),
        prompt: classificationPrompt(sentence, names),
        modelTier: 'auto',
        allowTools: false,
        inputs: perItem ? { record: { kind: 'ref', path: `loop.${itemVar}` } } : {},
        outputSchema: {
            type: 'object',
            properties: {
                [field]: { type: 'string', description: `One of: ${names.join(', ')}` },
            },
            required: [field],
        },
        ...(perItem ? { forEach: { overRef: list, itemVar } } : null),
    };
}

/**
 * The whole handoff, as data: the step to insert, the rules that read it, and
 * the path they read.
 *
 * Nothing is written here and nothing is decided here that the author has not
 * already said out loud — the sentence is theirs and the answers are theirs.
 * A request this module cannot honour comes back as a `problem` sentence with
 * a null `step`, never as a plan with a guess in it: an author who accepts a
 * plan gets a step added to their automation, so "roughly right" is not a state
 * this may return.
 *
 * @param {object}   args
 * @param {string}   args.description  the author's own question
 * @param {string[]} args.categories   the answers they named, in their order
 * @param {string}   args.itemVar      what the per-row scope is called
 * @param {boolean}  args.perItem      does the Condition work through a list
 * @param {string}   args.sourceRef    the list it works through (per-item only)
 * @param {string}   args.stepId       override the minted id (tests, retries)
 */
export function planRouteHandoff({
    // `description` and `sourceRef` are normalised on the first two lines
    // below, so they carry no default here: one place decides what an absent
    // one means, and it is the same place that decides what a blank one does.
    description,
    sourceRef,
    categories = [],
    itemVar = 'item',
    perItem = false,
    stepId = null,
} = {}) {
    const sentence = String(description || '').replace(/\s+/g, ' ').trim();
    const names = (Array.isArray(categories) ? categories : [])
        .map(c => String(c || '').trim())
        .filter(Boolean)
        .slice(0, MAX_CATEGORIES);
    const list = String(sourceRef || '').trim();
    const problem = handoffProblem({ sentence, names, perItem, list });
    if (problem) return refuse(problem);

    const field = slugifyFieldName(sentence);
    const id = stepId || newHandoffStepId();
    // Whole-run: the answer sits on the step's own output. Per item: the
    // Condition reads the step's per-item results, so each row IS one result
    // and its answer is `item.output.<field>` (header, "THE PATH IS THE WHOLE
    // POINT"). `itemVar` is what this editor calls that row.
    const fieldPath = perItem ? `${itemVar}.output.${field}` : `steps.${id}.output.${field}`;

    const step = classifierStep({ id, sentence, names, field, perItem, itemVar, list });

    const rules = [];
    for (const name of names) {
        rules.push({
            name: uniqueRuleName(rules, slugName(name)),
            // Exactly the shape utils/conditionModel.js parses back into a
            // clickable row, so the preview reads it as a sentence and the
            // Advanced expression is the same text the runner sees.
            expr: `equals(${fieldPath}, ${JSON.stringify(name)})`,
        });
    }

    return {
        step,
        rules,
        fieldPath,
        field,
        // Per item only, and mandatory there — see the header.
        source: perItem ? `steps.${id}.output.results` : null,
        problem: '',
    };
}

/**
 * Is this insert one that can be made at all?
 *
 * A target the graph does not have, or an id that is already taken. The
 * second is the dangerous one: a colliding id would not add a step, it would
 * MERGE two, and ids are opaque keys everywhere downstream, so nothing else
 * would notice.
 */
function canInsert(definition, steps, idx, newStep) {
    if (!definition || idx === -1 || !newStep?.id || !newStep?.type) return false;
    return definition.trigger?.id !== newStep.id && !steps.some(s => s?.id === newStep.id);
}

/**
 * Put a ready-made step IN FRONT of an existing one and re-point the
 * connections. Pure: a graph in, a graph out, nothing rendered and nothing
 * saved — the shell commits it (BuildTab.onInsertStepBefore).
 *
 * THE REWIRE IS THE WHOLE JOB, and every way of getting it wrong is silent.
 * Everything that pointed at the target now points at the new step, and the
 * new step points at the target. Add the node without moving the incoming
 * edges and it dangles with nothing above it, so the Condition reads a step
 * that never ran. Move them without adding the edge back and the Condition is
 * ORPHANED: no path from the trigger, never runs, and the automation still
 * validates, still saves, and quietly stops doing half of what it did.
 *
 * Incoming edges are COPIED rather than rebuilt, so a branch label and a
 * persisted colour ride along untouched. That is deliberate and not laziness:
 * the branch decision is made upstream, so it belongs on the edge that now
 * arrives at the inserted step — the same choice flow/branchEdges.js makes
 * when the canvas splices a step onto a connection.
 *
 * The record binding is filled in here because this is the level that can see
 * what feeds the node. With exactly one thing above it there is no guess to
 * make; with several there is, so the binding is left alone and the new
 * step's own editor asks — an input pointing at one of three upstream steps
 * would look configured and read the wrong thing.
 *
 * Refuses (`ok: false`, graph untouched) rather than producing something
 * half-wired — see `canInsert` for what it will not do.
 */
export function insertStepBefore(definition, targetId, newStep) {
    const steps = Array.isArray(definition?.steps) ? definition.steps : [];
    const idx = steps.findIndex(s => s?.id === targetId);
    if (!canInsert(definition, steps, idx, newStep)) return { definition, ok: false };
    const target = steps[idx];
    const edges = Array.isArray(definition.edges) ? definition.edges : [];
    const rewired = edges.map(e => (e?.to === targetId ? { ...e, to: newStep.id } : e));
    // Plain and unlabelled: the inserted step has one continuation, like every
    // other non-branching step on this canvas.
    rewired.push({ from: newStep.id, to: targetId });

    const feeders = [...new Set(edges.filter(e => e?.to === targetId).map(e => e.from))];
    const recordRef = feeders.length === 1
        ? (definition.trigger?.id === feeders[0] ? 'trigger.output' : `steps.${feeders[0]}.output`)
        : null;
    const placed = {
        ...newStep,
        position: { x: (target.position?.x ?? 0) - INSERT_OFFSET_X, y: target.position?.y ?? 0 },
        ...(recordRef && !Object.keys(newStep.inputs || {}).length
            ? { inputs: { record: { kind: 'ref', path: recordRef } } }
            : null),
    };
    const nextSteps = steps.slice();
    nextSteps.splice(idx, 0, placed);
    return { definition: { ...definition, steps: nextSteps, edges: rewired }, ok: true };
}
