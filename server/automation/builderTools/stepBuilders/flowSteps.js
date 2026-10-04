/**
 * Builder tools — the steps that decide where a run goes next or hold it
 * there: condition and switch, the two privacy branchers (guard, tokenize),
 * the loop with its body-step sanitizer, and wait / form_page / stop_error.
 */

const {
    newId, appendAfter, branchEdgeFor, layerAwareAnchor, spliceSuccessors, isKnownNodeId,
} = require('../draftGraph');
const { TEMP_ID_RX, rewriteTempRefs } = require('../tempRefs');
const { validateAndFixBindings } = require('../bindings');

function applyAddCondition(draft, args) {
    const step = { id: newId('cond'), type: 'condition', expr: args.expr, label: args.label || 'Condition' };
    const lastId = layerAwareAnchor(draft, args.afterStepId, step.id);
    draft.steps.push(step);
    // Route the incoming edge through branchEdgeFor so chaining a condition
    // directly after another condition/switch still labels the branch.
    const incoming = branchEdgeFor(draft, lastId, step.id, { branch: args.branch, caseName: args.caseName });
    if (args.splice === true) spliceSuccessors(draft, lastId, step, incoming);
    draft.edges.push(incoming);
    if (args.thenStepId) draft.edges.push({ from: step.id, to: args.thenStepId, label: 'then' });
    if (args.elseStepId) draft.edges.push({ from: step.id, to: args.elseStepId, label: 'else' });
    return { added: step };
}

/**
 * Guard — scan a value for personal data and branch on the answer. Wires
 * exactly like a condition (then = personal data, else = clean), so an author
 * asking the builder for "warn me if there's personal data in it" gets a
 * working two-branch graph rather than a step with nowhere to go.
 */
function applyAddGuard(draft, args) {
    const step = {
        id: newId('guard'),
        type: 'guard',
        sourceRef: typeof args.sourceRef === 'string' ? args.sourceRef : '',
        label: args.label || 'Find personal data',
    };
    if (Array.isArray(args.categories) && args.categories.length) step.categories = args.categories;
    if (typeof args.confidence === 'number') step.confidence = args.confidence;
    if (args.stopOnFound || args.maskOnFound) {
        step.onFound = { ...(args.stopOnFound ? { stop: true } : {}), ...(args.maskOnFound ? { mask: true } : {}) };
    }
    const lastId = layerAwareAnchor(draft, args.afterStepId, step.id);
    draft.steps.push(step);
    const incoming = branchEdgeFor(draft, lastId, step.id, { branch: args.branch, caseName: args.caseName });
    if (args.splice === true) spliceSuccessors(draft, lastId, step, incoming);
    draft.edges.push(incoming);
    if (args.thenStepId) draft.edges.push({ from: step.id, to: args.thenStepId, label: 'then' });
    if (args.elseStepId) draft.edges.push({ from: step.id, to: args.elseStepId, label: 'else' });
    return { added: step };
}

/**
 * Tokenize — reversible placeholders. A plain step, not a brancher: it has one
 * outcome, and the real values come back on their own.
 */
function applyAddTokenize(draft, args) {
    const step = {
        id: newId('tok'),
        type: 'tokenize',
        sourceRef: typeof args.sourceRef === 'string' ? args.sourceRef : '',
        label: args.label || 'Hide personal data',
    };
    if (Array.isArray(args.categories) && args.categories.length) step.categories = args.categories;
    if (typeof args.confidence === 'number') step.confidence = args.confidence;
    const lastId = layerAwareAnchor(draft, args.afterStepId, step.id);
    draft.steps.push(step);
    const incoming = branchEdgeFor(draft, lastId, step.id, { branch: args.branch, caseName: args.caseName });
    if (args.splice === true) spliceSuccessors(draft, lastId, step, incoming);
    draft.edges.push(incoming);
    return { added: step };
}

function applyAddLoop(draft, args) {
    // Sanitize child body steps: every child must have an id, type, and any
    // type-specific required fields. Missing ids would crash the runner with
    // a null step_id DB constraint.
    const rawBody = Array.isArray(args.body) ? args.body : [];
    const childErrors = [];
    // Handles declared so far in this body: id → id (a body step's id IS its
    // handle, so `steps.$read` and `steps.read` both reach a step with id
    // "read"). Same resolver as builder_add_steps — see tempRefs.js.
    const handles = Object.create(null);
    const body = rawBody.map((child, idx) => {
        if (!child || typeof child !== 'object') return null;
        let fixed = { ...child };
        // A loop body step is a FLAT step object. builder_add_steps top-level
        // entries are {type, spec} — the opposite — and a model that has
        // internalised that rule applies it here too. This used to be accepted
        // silently: `spec` is a field no step type has, so the child was stored
        // inert and the failure surfaced a round later as
        // `integration_action.tool_missing` on an `lb_…` id the model had never
        // been shown. Reject it here, where the cause is still visible.
        if (fixed.spec && typeof fixed.spec === 'object' && !Array.isArray(fixed.spec)) {
            const inner = Object.keys(fixed.spec).slice(0, 4).join(', ');
            childErrors.push(`body[${idx}]: loop body steps are FLAT step objects, not {type, spec}. Write {type:"${fixed.type || 'ai_step'}", ${inner || 'tool/prompt'}: …} directly — the {type, spec} wrapper is only for builder_add_steps TOP-LEVEL entries.`);
            return null;
        }
        // A `tempId` (the batch tool's word for it) becomes the id, so a model
        // that learned the idiom there is not punished for applying it here.
        if ((!fixed.id || typeof fixed.id !== 'string') && typeof fixed.tempId === 'string' && TEMP_ID_RX.test(fixed.tempId)) fixed.id = fixed.tempId;
        delete fixed.tempId;
        if (!fixed.id || typeof fixed.id !== 'string') fixed.id = newId('lb');
        else if (isKnownNodeId(draft, fixed.id) || handles[fixed.id]) {
            childErrors.push(`body[${idx}]: id "${fixed.id}" is already used by another step — pick another handle.`);
            return null;
        }
        // Resolve `steps.$handle` against EARLIER body steps now, where the
        // cause is visible. Before this the ref was stored verbatim and failed
        // a round later as ref.unknown_step on an auto-minted lb_… id the model
        // had never seen — a repair round per loop, in every measured build.
        let missing = null;
        fixed = rewriteTempRefs(fixed, handles, (t) => { missing = missing || t; });
        if (missing) {
            const later = rawBody.slice(idx + 1).some(c => c && typeof c === 'object' && (c.id === missing || c.tempId === missing));
            childErrors.push(later
                ? `body[${idx}] (${fixed.id}): "steps.$${missing}" refers to body step "${missing}", which comes LATER in the body — a step can only read what ran before it; reorder the body.`
                : `body[${idx}] (${fixed.id}): "steps.$${missing}" refers to a body step handle "${missing}" that no EARLIER body step declares. Give that step "id":"${missing}" (a body step's id is its handle), or reference the id it already has.`);
            return null;
        }
        handles[fixed.id] = fixed.id;
        // Never guess the type. Defaulting to 'ai_step' kept a child's `tool`
        // field and then had the validator demand a `prompt` — telling the
        // model to add a prompt to a step it deliberately built as an action.
        if (!fixed.type || typeof fixed.type !== 'string') {
            const guess = fixed.tool ? 'integration_action' : (fixed.prompt ? 'ai_step' : null);
            childErrors.push(`body[${idx}] (${fixed.id}): missing "type".${guess ? ` It has a "${fixed.tool ? 'tool' : 'prompt'}" field — you probably meant type:"${guess}".` : ''} Every loop body step must declare its type.`);
            return null;
        }
        if (fixed.inputs) {
            const v = validateAndFixBindings(fixed.inputs, draft);
            if (v.error) childErrors.push(`body[${idx}] (${fixed.id}): ${v.error}`);
            fixed.inputs = v.inputs;
        }
        return fixed;
    }).filter(Boolean);
    if (childErrors.length) return { error: childErrors.join(' ') };

    const step = {
        id: newId('loop'),
        type: 'loop',
        overRef: args.overRef,
        itemVar: args.itemVar,
        body,
        maxIterations: args.maxIterations || 100,
        label: args.label || `Loop over ${args.overRef}`,
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

/**
 * The one shape a switch case may have — used by the add path AND by
 * stepEditing's patch normaliser, so a patched switch stays byte-identical to
 * a freshly added one.
 *
 * A case carries EITHER its own rule (`expr`) or a value to compare against
 * the step-level expr (`value`). That is not an invention: the validator says
 * so in its own hint — "Each case needs { name, value } or { name, expr }"
 * (validate/stepRules/branchingRules.js) — it parses `c.expr` through the
 * restricted grammar, and the runtime evaluates it (execControl.switchCaseRule).
 *
 * Both paths used to rebuild a case as `{ name: c.name, value: c.value }`,
 * which DROPPED `expr`. So the rule-style switch the canvas editor writes —
 * every output carrying its own condition — could not be built by the AI at
 * all (it arrived as `{name, value: undefined}`), and any builder_update_step
 * patch that touched `cases` silently erased the author's expressions. That is
 * the same class of loss BFSF-356 fixed on the client side, where
 * routeModel.js now persists `routeStyle` for exactly this reason.
 *
 * Keys are still rebuilt, never merged — the discipline the rest of this file
 * keeps — but the rebuild now includes the two the engine actually reads, and
 * omits whichever is absent so the stored shape stays clean.
 */
function sanitizeSwitchCases(cases) {
    if (!Array.isArray(cases)) return [];
    return cases.map((c) => {
        const out = { name: c?.name };
        if (typeof c?.expr === 'string' && c.expr.trim()) out.expr = c.expr;
        if (c?.value !== undefined) out.value = c.value;
        return out;
    });
}

function applyAddSwitch(draft, args) {
    // Refused BEFORE anything is mutated: a switch has no single successor to
    // hand the anchor's old edge to (see draftGraph.spliceSuccessors).
    if (args.splice === true) {
        return { error: 'splice is not supported when the new step is a switch - add it with nextStepIds and remove the old edge instead.' };
    }
    const step = {
        id: newId('sw'),
        type: 'switch',
        expr: args.expr,
        cases: sanitizeSwitchCases(args.cases),
        defaultBranch: typeof args.defaultBranch === 'string' ? args.defaultBranch : null,
        label: args.label || 'Condition',
    };
    const lastId = layerAwareAnchor(draft, args.afterStepId, step.id);
    draft.steps.push(step);
    // Route the incoming edge through branchEdgeFor so chaining a switch
    // directly after a condition/switch still labels the branch.
    const incoming = branchEdgeFor(draft, lastId, step.id, { branch: args.branch, caseName: args.caseName });
    if (args.splice === true) spliceSuccessors(draft, lastId, step, incoming);
    draft.edges.push(incoming);
    // Wire any provided case targets in one shot.
    const next = args.nextStepIds || {};
    for (const caseName of Object.keys(next)) {
        const target = next[caseName];
        if (typeof target !== 'string') continue;
        const label = caseName === 'default' ? 'case:default' : `case:${caseName}`;
        draft.edges.push({ from: step.id, to: target, label, caseName });
    }
    return { added: step };
}

function applyAddWait(draft, args) {
    const step = { id: newId('wait'), type: 'wait', seconds: Math.max(1, Math.min(86400, Number(args.seconds) || 1)), label: args.label || 'Wait' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

/**
 * A further page of the automation's public form. Clamps mirror validate.js
 * (FORM_PAGE_MIN/MAX_WAIT_S) and the builder UI's formState.js, so an
 * AI-built page and a hand-built one are the same object.
 */
function applyAddFormPage(draft, args) {
    const ending = args.mode === 'ending';
    const step = {
        id: newId('fp'),
        type: 'form_page',
        mode: ending ? 'ending' : 'input',
        form: (args.form && typeof args.form === 'object') ? args.form : null,
        label: args.label || (ending ? 'Show a summary' : 'Ask for more info'),
    };
    if (!ending) {
        step.waitSeconds = Math.max(60, Math.min(7 * 24 * 3600, Math.round(Number(args.waitSeconds) || 3600)));
    }
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

function applyAddStopError(draft, args) {
    const step = { id: newId('stop'), type: 'stop_error', message: args.message, label: args.label || 'Stop with an error' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

module.exports = {
    applyAddCondition,
    applyAddGuard,
    applyAddTokenize,
    applyAddLoop,
    applyAddSwitch,
    applyAddWait,
    applyAddFormPage,
    applyAddStopError,
    sanitizeSwitchCases,
};
