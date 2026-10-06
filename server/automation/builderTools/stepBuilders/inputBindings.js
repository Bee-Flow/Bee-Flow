/**
 * Builder tools — the binding of a step's input VALUES: which required inputs
 * a call leaves unbound, what the draft can bind for itself (and say so),
 * the refusal that names the one binding to write when it cannot, and the
 * template-string form a text field stores instead of a binding object.
 */

const { isSideEffect } = require('../../sideEffectMap');
const { fieldsAtRef, topLevelFieldsOf, describeItem } = require('../outputFields');
const { iterableFieldsOf } = require('../../outputSchemas');
const { findStepAnywhere, lastStepId, allTriggerIds } = require('../draftGraph');
const { splitLast, pathKeys, appendKey } = require('../../expr');

// ── Tool schemas (injected to the LLM) ─────────────────

// ─── Binding format reminder for the AI ──────────────────────────
// Every input value MUST be one of these shapes (or a plain JSON literal,
// which is treated as { kind: 'literal', value: ... }):
//   { "kind": "literal",  "value": <any> }
//   { "kind": "ref",      "path":  "steps.s1.output.items[0].subject" }
//   { "kind": "template", "value": "Found {{steps.s1.output.count}} items" }
//   { "kind": "expr",     "value": "steps.s1.output.amount > 1000" }
// §WS5 — BINDING_HINT moved to ./builderTools/schemas.js (its only consumer).

/**
 * The tool's required inputs that this call leaves absent or set to an empty
 * literal — the same two states validate/stepRules.js's
 * integration_action.param_missing flags at activation. Empty when the route
 * attached no schema map (MCP surface, legacy callers): "we were not told"
 * is not "nothing is required", and refusing there would break a working
 * integration outright.
 */
function unboundRequiredInputs(tool, inputs, draftWrap) {
    const schema = draftWrap?._inputSchemasByTool?.[tool];
    const required = Array.isArray(schema?.required) ? schema.required : [];
    return required.filter((k) => {
        const b = inputs ? inputs[k] : undefined;
        if (b === undefined || b === null) return true;
        return !!(b && typeof b === 'object' && b.kind === 'literal'
            && (b.value === '' || b.value === undefined || b.value === null));
    });
}

// ── Required inputs the server can bind itself ──────────────────────
//
// Measured 2026-09-12/13 on the invoice brief: the fast local model sent a
// forEach'd nextcloud_read_file with no inputs at all, was told to bind
// `path` from the item, and resent the byte-identical batch — it can ADD a
// step it is told to add, it cannot EDIT one field of a batch it already
// sent (README rule 1). When the shape of the item is KNOWN and carries a
// field of the required input's name, the binding is not a guess: it is
// written here and said in _warnings. Two things are never bound and come
// back as candidates for the error to name instead: an input of a
// side-effect action (a delete that picked its own path is the wrong kind
// of helpful), and a top-level field of the previous step with the same
// name (nextcloud_list_files.output.path is the folder that was listed,
// not a file).

const LIST_TOOL_RX = /_(list|search)_/;
const MAX_NAMES_LISTED = 20;

function listNames(names) {
    if (!Array.isArray(names)) return '';
    return names.length > MAX_NAMES_LISTED
        ? `${names.slice(0, MAX_NAMES_LISTED).join(', ')}, …`
        : names.join(', ');
}

/** The output fields a step emits a LIST under — the refs a forEach can iterate. */
function listFieldsOfStep(step) {
    if (!step || typeof step !== 'object') return [];
    if (step.forEach && typeof step.forEach === 'object' && typeof step.forEach.overRef === 'string') return ['results'];
    if (step.type === 'integration_action') return typeof step.tool === 'string' ? iterableFieldsOf(step.tool) : [];
    if (['filter', 'limit', 'dedupe', 'set'].includes(step.type) && typeof step.arrayRef === 'string') return ['items'];
    return [];
}

/**
 * Where, under loop.<v>, a field `k` of the item described by `res` sits:
 * `k` on a plain item; `output.k` or `item.k` on a fan-out entry when
 * exactly one half has it. null when nowhere, 'ambiguous' when both halves
 * have it — only the model knows which one it meant.
 */
function itemPathFor(res, k) {
    if (!res || res.fields === null) return null;
    if (res.source === 'fanout') {
        const under = ['output', 'item'].filter(env => res.fields.includes(`${env}.${k}`));
        if (under.length === 2) return 'ambiguous';
        return under.length === 1 ? `${under[0]}.${k}` : null;
    }
    return res.fields.includes(k) ? k : null;
}

/** `steps.a_1.output.items` — the list a forEach item is an entry of. */
function itemOriginOf(res, forEach) {
    const up = res && res.upstream;
    if (up && up.type === 'trigger') return `trigger.output${res.arrayField ? `.${res.arrayField}` : ''}`;
    if (up && up.stepId) return `steps.${up.stepId}.output.${res.arrayField || 'items'}`;
    return forEach && typeof forEach.overRef === 'string' ? forEach.overRef : 'the list';
}

/**
 * Bind the `missing` required inputs of `tool` that the draft can answer
 * for. Returns the inputs (shallow-copied, `{kind:'ref', path}` added per
 * binding), what was bound, and what was found but deliberately NOT bound.
 *
 *   bound      — [{ key, path, from: 'forEach' | 'trigger' }]
 *   candidates — [{ key, path, why }] with why one of
 *                'side-effect'        the value is there, but this action changes data
 *                'ambiguous'          a fan-out entry has it under output AND item
 *                'upstream-same-name' the previous step's top-level output has the name
 *                'needs-forEach'      the previous step emits a list whose entries have it
 *                                     (carries overRef + itemVar to suggest)
 */
function autoBindRequiredInputs({ graph, tool, inputs, forEach, missing, afterStepId, draftWrap }) {
    const sideEffect = isSideEffect(tool);
    const out = { ...(inputs || {}) };
    const bound = [];
    const candidates = [];
    const offer = (key, path, why, extra = {}) => candidates.push({ key, path, why, ...extra });
    const bind = (key, path, from) => {
        if (sideEffect) { offer(key, path, 'side-effect', { from }); return; }
        out[key] = { kind: 'ref', path };
        bound.push({ key, path, from });
    };
    const done = () => ({ inputs: out, bound, candidates });

    if (forEach && typeof forEach.overRef === 'string') {
        const res = fieldsAtRef(graph, forEach.overRef, draftWrap);
        if (res.fields === null) return done();
        for (const k of missing) {
            const at = itemPathFor(res, k);
            if (at === 'ambiguous') offer(k, null, 'ambiguous', { paths: ['output', 'item'].map(env => `loop.${forEach.itemVar}.${env}.${k}`) });
            else if (at) bind(k, `loop.${forEach.itemVar}.${at}`, 'forEach');
        }
        return done();
    }

    // No forEach: the step reads whatever ran just before it.
    const anchorId = afterStepId || (graph && graph.trigger ? lastStepId(graph) : null);
    if (!anchorId) return done();
    if (allTriggerIds(graph).includes(anchorId)) {
        const res = fieldsAtRef(graph, 'trigger.output', draftWrap);
        if (res.fields === null) return done();
        for (const k of missing) if (res.fields.includes(k)) bind(k, `trigger.output.${k}`, 'trigger');
        return done();
    }
    const anchor = findStepAnywhere(graph, anchorId)?.step;
    if (!anchor) return done();
    const fanout = anchor.forEach && typeof anchor.forEach === 'object' && typeof anchor.forEach.overRef === 'string';
    // A fan-out step's top level is just `results`; its tool's own fields
    // sit one level down, under each entry's `output`.
    const top = (anchor.type === 'integration_action' && !fanout && typeof anchor.tool === 'string')
        ? (topLevelFieldsOf(anchor.tool, draftWrap).fields || [])
        : [];
    const lists = listFieldsOfStep(anchor);
    for (const k of missing) {
        if (top.includes(k)) offer(k, `steps.${anchor.id}.output.${k}`, 'upstream-same-name', { stepId: anchor.id, tool: anchor.tool });
        for (const arr of lists) {
            const overRef = `steps.${anchor.id}.output.${arr}`;
            const res = fieldsAtRef(graph, overRef, draftWrap);
            const at = itemPathFor(res, k);
            if (!at || at === 'ambiguous') continue;
            const itemVar = res.source === 'fanout' ? 'r' : 'f';
            offer(k, `loop.${itemVar}.${at}`, 'needs-forEach', { overRef, itemVar, fanout: res.source === 'fanout', stepId: anchor.id, tool: anchor.tool || null });
            break;
        }
    }
    return done();
}

/** The _warnings line for one binding autoBindRequiredInputs wrote. */
function boundInputNote(b, res, forEach) {
    if (b.from === 'trigger') {
        return `input "${b.key}" was not bound — bound to ${b.path} (the trigger payload has it). Write the binding yourself next time.`;
    }
    // `loop.<var>.output.<f>` / `loop.<var>.item.<f>`: which half of the
    // fan-out entry the binding reads, by the run's grammar.
    const keys = pathKeys(b.path) || [];
    const half = keys[0] === 'loop' && keys.length > 3 && (keys[2] === 'output' || keys[2] === 'item') ? keys[2] : undefined;
    const shape = res && res.source === 'fanout'
        ? `is {index, item, output, status}; ${half} has: ${listNames(half === 'item' ? res.itemFields : res.outputFields)}`
        : `has: ${listNames(res ? res.fields : null)}`;
    return `input "${b.key}" was not bound — bound to ${b.path} (the forEach item from ${itemOriginOf(res, forEach)} ${shape}). Write the binding yourself next time: ${b.key}:{kind:"ref", path:"${b.path}"}.`;
}

/**
 * The refusal for required inputs still unbound after the auto-bind pass,
 * most specific first: a side-effect candidate names the binding and why
 * it was not written; a known loop item that lacks the name says what it
 * has; an upstream same-name field is offered with its caveat; an upstream
 * list is offered with the forEach to add. Anything else is the plain
 * message the 2026-09-12 check has always given. A rejection that knows
 * the one exact edit carries it as _suggestedPatch (suggestedPatch.js) —
 * except on a side-effect action: the build loop applies that patch on an
 * identical resend, which would bind for a delete by the back door.
 */
function requiredInputError(tool, missing, forEach, candidates, graph, draftWrap) {
    const cand = (why) => (candidates || []).find(c => c.why === why && missing.includes(c.key));
    const patchable = !isSideEffect(tool);
    const noun = (k) => (FILE_LOCATION_FIELDS.has(k) ? 'file' : 'value');
    const res = forEach && typeof forEach.overRef === 'string' ? fieldsAtRef(graph, forEach.overRef, draftWrap) : null;

    // (1) The value is right there, and this action changes data.
    const se = cand('side-effect');
    if (se) {
        const where = se.from === 'trigger' ? 'The trigger payload' : `The forEach item (an entry of ${itemOriginOf(res, forEach)}${res?.upstream?.tool ? ` from ${res.upstream.tool}` : ''})`;
        return {
            error: `${tool}: required input "${se.key}" is not bound. ${where} has a field "${se.key}" — if that is the ${noun(se.key)} to act on, bind it explicitly: ${se.key}:{kind:"ref", path:"${se.path}"}. It is not filled in for you because this action changes data.`,
            _fixHint: 'Reject reason: a required input is missing on a side-effect action. Add the binding named above and resend the same step — the other bindings were fine.',
        };
    }

    // (2) The loop item is known and does not have the name (or has it twice).
    if (res && res.fields !== null) {
        const amb = cand('ambiguous');
        if (amb) {
            return {
                error: `${tool}: required input "${amb.key}" is not bound, and ${describeItem(res)} — "${amb.key}" exists both under output and under item. Bind the one you mean: ${amb.paths.map(p => `${amb.key}:{kind:"ref", path:"${p}"}`).join(' or ')}, and resend the step.`,
                _fixHint: 'Reject reason: a required input is missing and the loop item has that name in two places. Bind the one you mean and resend the same step — the other bindings were fine.',
            };
        }
        const many = missing.length > 1;
        const names = missing.map(k => `"${k}"`);
        const example = `loop.${forEach.itemVar}.${res.source === 'fanout' ? 'output.' : ''}<field>`;
        return {
            error: `${tool}: required input${many ? 's' : ''} ${names.join(', ')} ${many ? 'are' : 'is'} not bound, and ${describeItem(res)} — none of those is called ${names.join(' or ')}. Bind ${many ? 'them' : 'it'} from one of them (${missing[0]}:{kind:"ref", path:"${example}"}), from an upstream step (steps.<id>.output.<field>) or as a literal, and resend the step.`,
            _fixHint: 'Reject reason: a required input is missing and the loop item has no field by that name. Bind it explicitly and resend the same step — the other bindings were fine.',
        };
    }

    // (3) The previous step's top-level output has the name — usually the
    // scope that was listed, not one entry, so it is offered, never written.
    const up = cand('upstream-same-name');
    const fe = cand('needs-forEach');
    if (up) {
        const listing = typeof up.tool === 'string' && LIST_TOOL_RX.test(up.tool);
        const caveat = listing
            ? `but that is the ${/_search_/.test(up.tool) ? 'scope that was searched, not one result' : 'folder that was listed, not one file'} — bind it only if you really mean it`
            : 'bind it only if that is the value you mean';
        const feFor = fe && fe.key === up.key ? fe : null;
        const perEntry = feFor
            ? ` To run once per ${listing ? 'listed file' : 'entry'} add forEach:{overRef:"${feFor.overRef}", itemVar:"${feFor.itemVar}"} and bind ${up.key}:{kind:"ref", path:"${feFor.path}"}.`
            : '';
        return {
            error: `${tool}: required input "${up.key}" is not bound. The previous step ${up.stepId} (${up.tool}) outputs a top-level "${up.key}", ${caveat}: ${up.key}:{kind:"ref", path:"${up.path}"}.${perEntry}`,
            _fixHint: 'Reject reason: a required input is missing. Add the binding you mean (named above) and resend the same step — the other bindings were fine.',
            // Two ways to bind it is not one exact edit; only the plain case
            // carries a patch.
            ...(patchable && !feFor ? { _suggestedPatch: { ops: [{ op: 'set', path: appendKey('inputs', up.key), value: { kind: 'ref', path: up.path } }] } } : {}),
        };
    }

    // (4) The previous step emits a list whose entries have the name.
    if (fe) {
        return {
            error: `${tool}: required input "${fe.key}" is not bound. ${fe.overRef} is a list whose entries have "${fe.key}"${fe.fanout ? ' under output' : ''} — add forEach:{overRef:"${fe.overRef}", itemVar:"${fe.itemVar}"} to this step and bind ${fe.key}:{kind:"ref", path:"${fe.path}"}.`,
            _fixHint: 'Reject reason: a required input is missing and the previous step produces a list whose entries have it. Add the forEach and the binding named above and resend the same step — the other bindings were fine.',
            // The binding alone would be refused (loop.<var> without a forEach
            // — unboundLoopVarError), so the patch carries both edits.
            ...(patchable ? { _suggestedPatch: { ops: [
                { op: 'set', path: 'forEach', value: { overRef: fe.overRef, itemVar: fe.itemVar } },
                { op: 'set', path: appendKey('inputs', fe.key), value: { kind: 'ref', path: fe.path } },
            ] } } : {}),
        };
    }

    // (5) Nothing known about where the value could come from.
    const many = missing.length > 1;
    const first = missing[0];
    const from = forEach
        ? `Inside this forEach bind ${many ? 'them' : 'it'} from the item, e.g. ${first}: {kind:"ref", path:"loop.${forEach.itemVar}.${first}"}`
        : `Bind ${many ? 'them' : 'it'} to an upstream field ({kind:"ref", path:"steps.<id>.output.<field>"}) or a literal`;
    return {
        error: `${tool}: required input${many ? 's' : ''} ${missing.map(k => `"${k}"`).join(', ')} ${many ? 'are' : 'is'} not bound — the step would fail at run time. ${from}.`,
        _fixHint: 'Reject reason: a required input is missing. Add that binding and resend the same step — the other bindings were fine.',
    };
}

// A ref whose last segment is a file-entry field rather than text. `name`
// is deliberately absent: a filename is not text either, but a field called
// name exists on plenty of outputs that are.
const FILE_LOCATION_FIELDS = new Set(['path', 'fileId', 'file_id', 'size', 'modified', 'contentType', 'mimeType', 'href', 'url']);
function fileLocationField(source) {
    if (!source || source.kind !== 'ref' || typeof source.path !== 'string') return null;
    const p = source.path.trim();
    // The last KEY as the runner reads it: `files[0]["path"]` ends in `path`,
    // `["file.path"].text` ends in `text`.
    const last = splitLast(p)?.last;
    return typeof last === 'string' && FILE_LOCATION_FIELDS.has(last) ? p : null;
}

// The {{…}} template form of a binding — what the step fields that store TEXT
// (a fill_document value, a slide's chart data, knowledge_write's content)
// keep instead of a binding object. See applyAddKnowledgeWrite for why.
function bindingToTemplate(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    // An ARRAY has no template form. `String([1,2])` would produce "1,2",
    // which is not what anybody meant and reads as configured text.
    if (Array.isArray(v)) return '';
    if (typeof v !== 'object') return String(v);
    if (v.kind === 'ref' && typeof v.path === 'string') return `{{${v.path}}}`;
    if ((v.kind === 'template' || v.kind === 'literal') && typeof v.value === 'string') return v.value;
    if (v.kind === 'literal') return v.value === undefined || v.value === null ? '' : String(v.value);
    return '';
}

module.exports = {
    unboundRequiredInputs,
    autoBindRequiredInputs,
    boundInputNote,
    requiredInputError,
    listNames,
    LIST_TOOL_RX,
    fileLocationField,
    bindingToTemplate,
};
