/**
 * The compliance findings a DEFINITION can justify on its own, said on the
 * step that causes them — on the canvas, while the author is still building.
 *
 * Until now every compliance finding about an automation lived in an admin report
 * produced by a six-hourly sweep. The person who creates the problem is the
 * person building the automation, and they never saw it. These two rules move the
 * subset that needs no database into the builder, where it is still cheap to
 * fix.
 *
 * PURE, AND THAT IS A HARD CONSTRAINT, NOT A PREFERENCE. `validateDefinition`
 * runs on every keystroke (the inspector PUTs the whole document on autosave),
 * so nothing here reads a store, calls a model, or touches the network, and
 * nothing here caches: a memo keyed on the graph object would go stale the
 * moment the builder mutates the draft in place, and a wrong-but-fast answer
 * about personal data is worse than no answer. Both rules are O(steps) over a
 * graph the shape ceilings already bound to MAX_STEPS.
 *
 * WHAT A DEFINITION CAN AND CANNOT SAY. The evidence is the NAMES the author
 * wrote: a reference path `steps.read.output.email`, a data_extraction field
 * called `customer_name`, a datatable condition on the `bsn` column. Those are
 * in the document. What is NOT in the document, and therefore has no rule
 * here:
 *
 *   - WHAT IS ACTUALLY IN A TABLE. The admin review's `ai_no_guard` needs
 *     `facts.table.personal` — columns the PII guard read the VALUES of. That
 *     is a store read plus a guard call per column. Out of scope here by
 *     construction; the name evidence above is the definition-only half of the
 *     same question.
 *   - RETENTION. "Writes personal data to a destination with no retention" was
 *     a candidate and it is not decidable here: a retention window is
 *     `retention_days` on the `datatables` row (stores/datatableStore), never a
 *     field of the step. A step that writes to a table with a 30-day window and
 *     one that writes to a table with none are the same six lines of JSON.
 *   - A FORM PAGE'S OWN FIELDS. `form_page.form` has its own declaration
 *     contract (automation/formTriggerContract.js) and is where a visitor's
 *     name and e-mail enter the automation, but nothing downstream is named by it
 *     until it is bound — and a binding IS caught, by its path.
 *
 * VOCABULARY, IMPORTED RATHER THAN RESTATED — the lesson of the snake_case
 * drift that made a column of nothing but telephone numbers read as clean:
 *
 *   - WHICH NAMES READ AS PERSONAL — `core/privacy/personalColumns.kindFromName`,
 *     the one detector the compliance review, the playbook designer and the
 *     ROPA all ask. It is CORE, so a feature may require it (ARCHITECTURE.md),
 *     and it is pure: frozen patterns plus `piiCategories`, no IO.
 *   - WHERE A STEP'S DATA GOES — `core/privacy/dataFlow.classifyStep`, which
 *     answers `role` ('exit' | 'shield' | 'model' | 'store' | 'step') and, for
 *     an exit, the DESTINATION as a word a person recognises. It is the
 *     product's one reading of "does personal data leave through this
 *     automation", built for the compliance review and the GDPR checks, and it
 *     already hangs on `sideEffectMap.effectOf` underneath — so a step type or
 *     a tool added there reaches the canvas with it. A private outbound list
 *     here would mean the builder and the compliance report could disagree
 *     about whether an automation sends anything, which is the split `dataFlow`
 *     was written to close.
 *   - WHICH STEPS HAND WORK TO A MODEL — `automation/automationGraph.AI_STEP_TYPES`,
 *     and NOT `dataFlow.MODEL_TYPES`, which is the one place the two readings
 *     disagree. `automationGraph`'s list is `ai_step | data_extraction |
 *     ai_tool` and says in as many words that `summarize` is not one of them;
 *     the runtime agrees (`execSummarize` is sum/count/avg over a collection —
 *     arithmetic, no model), and `execDocument.js`'s Art. 50(2) marking pass
 *     reads it that way too. `dataFlow.MODEL_TYPES` carries `summarize`
 *     forward from the hand-rolled list the playbook review used to keep, so
 *     using it here would put "this step hands data to a model" on a step that
 *     counts rows. Worth fixing there; not from inside the validator.
 *
 * WARNINGS, NEVER ERRORS, at every stage. A half-built automation has to stay
 * saveable: the canvas holds a node the stored definition does not the moment a
 * save 400s, and the next action fails with `runPartial: step … not found in
 * definition`. Neither code is a completeness code either, so neither gates
 * activation — these say "look at this", not "you are not finished".
 */

const { isObject } = require('../helpers');
const { AI_STEP_TYPES } = require('../../automationGraph');
const { kindFromName } = require('../../../core/privacy/personalColumns');
const { classifyStep, SHIELD_TYPES: FLOW_SHIELD_TYPES } = require('../../../core/privacy/dataFlow');

/** A model reads the data here. See the header on why not `dataFlow.MODEL_TYPES`. */
const AI_TYPES = new Set(AI_STEP_TYPES);

/**
 * The Privacy Shield steps that count as "the author has dealt with this" — a
 * NARROWING of `dataFlow.SHIELD_TYPES`, not a second list, so a fourth shape
 * added there is either taken or consciously rejected here.
 *
 * `untokenize` is the one shape dropped: a reveal puts the real values BACK,
 * so counting it would silence this warning on precisely the automation that
 * re-personalises its data before handing it to a model. The reverse case — a
 * reveal with nothing that ever hid — already has its own rule
 * (`untokenize.no_hide_step`, validate/definition.js).
 *
 * A PLAIN `guard` is kept even though it only scans: it branches on the
 * answer, so the author has a place to route personal data away from the
 * model, and whether they wired that branch is `guard.dead_branch`'s question,
 * not this rule's.
 */
const SHIELD_TYPES = new Set([...FLOW_SHIELD_TYPES].filter(t => t !== 'untokenize'));

/**
 * A reference path as the runner reads one: a root, then dotted segments.
 * Matches the `{kind:'ref', path}` form, the `{{…}}` inside a template, and
 * the bare-string fields (`sourceRef`, `overRef`, `arrayRef`,
 * `data_extraction.source`) alike, because it runs over the step's JSON rather
 * than over a per-type list of binding fields. That list already exists in
 * `referenceScoping.js` and a second copy of it here would be a second thing
 * to forget when a step type is added — and a compliance rule that silently
 * stops looking at a whole step type is worse than no rule.
 *
 * `secrets` is left out: it is a credential, not a person.
 */
const PATH_RE = /\b(trigger|steps|vars|loop)((?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)/g;

/**
 * Segments that address the SHAPE of an upstream answer rather than a field of
 * it. Used only to decide "is this the step's whole output?" — they are not
 * filtered out of the personal-name scan, because none of them reads as
 * personal to the detector and pre-filtering names is how a list like this
 * starts hiding a real one.
 */
const WHOLE_OUTPUT_SEGMENTS = new Set(['output', 'results', 'rows', 'items', 'data']);

/** Step fields that can never carry a binding — skipped so prose is not scanned twice. */
const NON_BINDING_KEYS = new Set(['id', 'type', 'position', 'label']);

/** How many field names a message lists before it says "and N more". */
const MAX_NAMED = 4;

/**
 * A field name as the detector wants to read it: words.
 *
 * `kindFromName`'s patterns are word-anchored (`\b(name|naam|…)\b`), which is
 * right for a datatable column ("Full name", `email`) and wrong for the two
 * spellings an automation's own fields actually use: in `customer_name` the
 * underscore is a word character and in `customerName` the camel hump is one,
 * so neither has the boundary `\bname\b` needs and BOTH came back clean. The
 * detector stays the only judge of what a name means; this only hands it the
 * name split into the words it was written from.
 */
function humanise(segment) {
    return String(segment)
        .replace(/[_\-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** The personal-data kind a field name claims, or null. */
function personalKindOf(segment) {
    if (typeof segment !== 'string' || !segment) return null;
    return kindFromName({ key: segment, name: humanise(segment) });
}

/**
 * The output field names a step DECLARES that read as personal.
 *
 * This is the half of the evidence a path alone cannot carry: bind
 * `{{steps.extract.output}}` into a mail body and the path names no field, but
 * the extraction step right there in the document says it pulls out
 * `customer_name` and `email`. The names are the author's own — nothing is
 * read from a table, a schema registry or a run.
 */
function declaredPersonalFields(step) {
    if (!isObject(step)) return [];
    const names = [];
    if (step.type === 'ai_step' && isObject(step.outputSchema)) {
        // Same reading `checkAiStep` uses: a JSON-schema object, or the bare
        // field map older definitions carry.
        const props = isObject(step.outputSchema.properties) ? step.outputSchema.properties : step.outputSchema;
        names.push(...Object.keys(props));
    }
    if ((step.type === 'data_extraction' || step.type === 'parse_json') && Array.isArray(step.fields)) {
        for (const f of step.fields) if (isObject(f) && typeof f.name === 'string') names.push(f.name);
    }
    if (step.type === 'datatable') {
        // A read does not list the columns it returns, so the columns the step
        // NAMES are the evidence: a condition on `bsn` or a sort on `email` is
        // the definition itself saying that table has that column, and a row
        // read from it carries it. The write ops name their columns outright
        // in `values`.
        for (const w of (Array.isArray(step.where) ? step.where : [])) {
            if (isObject(w) && typeof w.field === 'string') names.push(w.field);
        }
        for (const s of (Array.isArray(step.sort) ? step.sort : [])) {
            if (isObject(s) && typeof s.field === 'string') names.push(s.field);
        }
        if (isObject(step.values)) names.push(...Object.keys(step.values));
        if (typeof step.matchColumn === 'string') names.push(step.matchColumn);
    }
    return names.filter(n => personalKindOf(n));
}

/**
 * Every personal-looking field this step reads, with the step field it was
 * found in — so the record's `path` lands on a control the inspector can open
 * (flow/sectionForIssue.js routes on the segment after the step id).
 *
 * Two shapes count, and the second is the one that matters:
 *   `steps.read.output.email`   — the path names the field
 *   `{{steps.extract.output}}`  — the path names the STEP, and that step
 *                                 declares personal fields of its own
 *
 * A path that names a field of the upstream step (`…output.total`) is NOT
 * widened to that step's other fields: binding one harmless column of a step
 * that also extracts an e-mail address sends the column, not the address.
 */
function personalReadsOf(step, stepsById) {
    const found = new Map();      // field name → { field, where }
    for (const key of Object.keys(step)) {
        if (NON_BINDING_KEYS.has(key)) continue;
        let text;
        try { text = JSON.stringify(step[key]); } catch (_) { continue; }
        if (!text) continue;
        PATH_RE.lastIndex = 0;
        let m;
        while ((m = PATH_RE.exec(text)) !== null) {
            const root = m[1];
            const segments = m[2].slice(1).split('.');
            // For `steps` and `loop` the first segment is the step id / the
            // loop's item variable, never a field. A loop called `customer`
            // would otherwise read as personal data on its own.
            const fields = (root === 'steps' || root === 'loop') ? segments.slice(1) : segments;
            let named = false;
            for (const seg of fields) {
                if (!personalKindOf(seg)) continue;
                named = true;
                if (!found.has(seg)) found.set(seg, { field: seg, where: key });
            }
            if (named || root !== 'steps') continue;
            // The whole answer of an upstream step: ask what that step says it
            // produces.
            if (fields.some(seg => !WHOLE_OUTPUT_SEGMENTS.has(seg))) continue;
            const upstream = stepsById instanceof Map ? stepsById.get(segments[0]) : null;
            for (const name of declaredPersonalFields(upstream)) {
                if (!found.has(name)) found.set(name, { field: name, where: key });
            }
        }
    }
    // A step's own declaration is a read too: `data_extraction` with a field
    // called `email` is the author telling a model to pull an e-mail address
    // out of the text, whatever the source binding happens to be called.
    if (AI_TYPES.has(step.type)) {
        for (const name of declaredPersonalFields(step)) {
            if (!found.has(name)) found.set(name, { field: name, where: step.type === 'ai_step' ? 'outputSchema' : 'fields' });
        }
    }
    return [...found.values()];
}

/**
 * WHERE this step's data goes, or null when it stays inside.
 *
 * The role comes from the shared classifier; the DESTINATION is what decides
 * whether this rule speaks. `dataFlow.isExit` fails closed on an
 * `integration_action` whose tool is not picked yet — right for a report,
 * which must not claim nothing leaves — but here the step is in front of its
 * author and a tool is chosen seconds later, and "this step sends the
 * customer's name out of the workspace" about a step with no tool is an
 * invention. `destinationOf` returns null for exactly that case, so requiring a
 * destination keeps the shared classifier AND keeps the sentence true. It also
 * lets the message name where the data goes, which is Art. 30(1)(d)'s own
 * question.
 */
function exitDestination(step) {
    const { role, destination } = classifyStep(step);
    return role === 'exit' ? (destination || null) : null;
}

/**
 * Is there a Privacy Shield IN FRONT OF this step?
 *
 * In front of, not merely present. A shield placed after the model guards
 * nothing that came before it, and "any shield anywhere" is how an automation
 * could silence the review's own finding by moving the shield to the end
 * (`dataFlow`'s header names that bug). Position is read from the written
 * order of the steps, in pre-order through loop bodies and parallel branches —
 * the order a linear automation runs in, and the authoring order otherwise, which
 * is the most the definition honestly says. It is therefore read
 * CONSERVATIVELY: only a shield that is definitely earlier counts against the
 * warning, never one that is definitely later counted for it.
 */
function shieldPrecedes(graph, target) {
    let firstShield = null;
    let reachedTarget = false;
    // Everything after the target is irrelevant — a shield found there can only
    // be LATER, which never satisfies "in front of". Stopping there is what
    // keeps this off the hot path: without it the walk is the whole graph for
    // every model step, and an automation that is half model steps pays for it on
    // every keystroke.
    const walk = (steps) => {
        for (const s of (Array.isArray(steps) ? steps : [])) {
            if (reachedTarget) return;
            if (!isObject(s)) continue;
            if (s === target) { reachedTarget = true; return; }
            // A Step or a flowlet this automation only CALLS may carry the shield
            // inside it, and a step-level rule cannot look in. Count it as one
            // rather than tell an author their guard does not exist — the same
            // call `untokenize.no_hide_step`'s docblock makes.
            if (firstShield === null && (SHIELD_TYPES.has(s.type) || s.type === 'call_layer' || s.type === 'call_block')) firstShield = true;
            if (s.type === 'loop') walk(s.body);
            if (s.type === 'parallel' && Array.isArray(s.branches)) for (const b of s.branches) walk(b);
        }
    };
    walk(graph && graph.steps);
    // `reachedTarget` matters: a step that is not in this graph at all (a
    // layer's step checked against the root) has nothing in front of it here,
    // and reporting a shield that precedes a step it cannot precede would
    // silence the warning by accident.
    return reachedTarget && firstShield === true;
}

/** `email`, `name` and 2 more — the field list as a message says it. */
function listFields(reads) {
    const names = reads.map(r => r.field);
    const shown = names.slice(0, MAX_NAMED).map(n => `\`${n}\``).join(', ');
    return names.length > MAX_NAMED ? `${shown} and ${names.length - MAX_NAMED} more` : shown;
}

/**
 * The step field a record points at. The first one a personal read was found
 * in, so the inspector opens the section that actually holds it.
 */
function fieldPath(at, reads) {
    return `${at}.${reads[0].where}`;
}

function checkPersonalDataOutbound(ctx, step, at) {
    const { pushW, stepsById } = ctx;
    const destination = exitDestination(step);
    if (!destination) return;
    const reads = personalReadsOf(step, stepsById);
    if (!reads.length) return;
    pushW({
        code: `${step.type}.personal_data_outbound`,
        severity: 'warning',
        path: fieldPath(at, reads),
        message: `Step ${step.id}: this step sends ${listFields(reads)} out of the workspace, to ${destination}.`,
        hint: 'Fine when it goes to the person it is about — a mail to the customer is the one place their name and address ARE the channel. Anywhere else (a ticket, a chat post, a third-party API) send a reference instead: bind the record id, not the person. A Privacy Shield step in "Hide personal data" mode in front of this one swaps them for placeholders.',
    });
}

function checkPersonalDataUnguarded(ctx, step, at) {
    const { pushW, graph, stepsById } = ctx;
    if (!AI_TYPES.has(step.type)) return;
    const reads = personalReadsOf(step, stepsById);
    if (!reads.length) return;
    if (shieldPrecedes(graph, step)) return;
    pushW({
        code: `${step.type}.personal_data_unguarded`,
        severity: 'warning',
        path: fieldPath(at, reads),
        message: `Step ${step.id}: this step hands ${listFields(reads)} to a model with no Privacy Shield in front of it.`,
        hint: 'Put a Privacy Shield step in "Hide personal data" or "Check and hide" mode in front of this one — it swaps names, e-mail addresses and the like for placeholders before the model reads them, and "Show real values again" puts them back afterwards. Or drop the fields the model does not need.',
    });
}

/**
 * Both compliance rules, in the order their records read best.
 *
 * The `isObject` guard is not ceremony: a definition is DATA — an import or a
 * raw PUT can carry `steps: [null]` — and every rule here reads `step.type`
 * and `Object.keys(step)` unconditionally. The shape errors for that step are
 * already reported by the time this runs; throwing here would turn a reportable
 * definition into a 500.
 */
function checkComplianceFindings(ctx, step, at) {
    if (!isObject(step)) return;
    checkPersonalDataUnguarded(ctx, step, at);
    checkPersonalDataOutbound(ctx, step, at);
}

module.exports = {
    checkComplianceFindings,
    checkPersonalDataOutbound,
    checkPersonalDataUnguarded,
    personalKindOf,
    declaredPersonalFields,
    SHIELD_TYPES,
};
