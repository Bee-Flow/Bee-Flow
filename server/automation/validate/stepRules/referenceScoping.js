/**
 * The pass over every BINDING a step carries, whatever field it sits in.
 *
 * Two halves. First the collection (refSurfaces.js): each step type keeps its
 * bindings somewhere of its own — `inputs`, a template string on the step, a
 * rule's expr, a datatable's `values` and `where[].value` — so every one of
 * them is gathered there, and a type that is missing from that list is a type
 * whose references reach run time unchecked. Then the checks, with the
 * runner's own readers (refPaths.js): a path or a `{{ }}` placeholder must
 * parse under the shared path grammar (`ref.syntax`), an expression input must
 * parse (`expr.parse`), every root must resolve (trigger/steps/vars/secrets/
 * loop), a `loop.<var>` must be bound by this step's own forEach or by a loop
 * it sits inside, and a `steps.<id>` — dotted, bracketed, or inside an
 * expression — must name a step that exists and has already run.
 *
 * Runs LAST, after the per-type field rules, because a ref that is reported
 * here reads best after the step's own shape has been reported.
 */

const { isObject, collectLiteralBraces, pickClosestId } = require('../helpers');
const { LOOP_RUNTIME_KEYS } = require('../constants');
const { TOPIC_HOST_SPEC } = require('../../expr');
const {
    REF_ROOTS, refHead, suggestPathSpelling, suggestExprSpelling, tryParseExpr, exprStepIds,
} = require('../refPaths');
const { collectStepRefs } = require('./refSurfaces');
const { forEachBoundVars } = require('./iterationRules');

function checkReferences(ctx, step, at) {
    const { pushE, pushW, trigger, refIds, refSeen, stepsById, loopVarsAbove } = ctx;
    // Reference scoping — collect all ref paths used in this step's
    // inputs / prompt / expr / template fields (refSurfaces.js), ensure their
    // roots resolve to known sources, and any "steps.<id>.output" is for
    // a step that has run before this one. Inside a layer the same
    // roots apply: `trigger` is the layer_input (so bindings stay
    // {{trigger.output.<param>}}), `steps` are the layer's own steps.
    //
    // NOTE: ai_step.prompt IS interpolated by the runner (execAiStep,
    // leaveUnresolved:true), but it is excluded from THIS error-level pass:
    // a `{{from}}` placeholder naming the step's own inputs.from key is
    // legitimate, and a typo can never crash a run. The dedicated
    // WARNING-only prompt lint lives in modelStepRules (ref.prompt_unknown_step
    // / ref.prompt_unknown_root — C28).
    const refs = collectStepRefs(step);
    if (step.type === 'untokenize' && !step.sourceRef) {
        pushW({ code: 'untokenize.sourceRef_missing', severity: 'warning', path: at + '.sourceRef', message: `Step ${step.id}: this step has nothing to restore yet.`, hint: 'Point it at the value that holds the placeholders. The run fails until you do.' });
    }

    // Uninterpolated-literal lint: a kind:'literal' input carrying {{…}}
    // ships verbatim (only kind:'template' interpolates), so the user
    // gets raw braces in their file path / message instead of a value.
    const litBraces = [];
    collectLiteralBraces(step.inputs, litBraces);
    if (step.type === 'set') collectLiteralBraces(step.fields, litBraces);
    if (step.type === 'knowledge_write') {
        collectLiteralBraces(step.content, litBraces);
        collectLiteralBraces(step.title, litBraces);
        collectLiteralBraces(step.sourceUri, litBraces);
    }
    if (step.type === 'datatable') {
        collectLiteralBraces(step.values, litBraces);
        for (const w of (Array.isArray(step.where) ? step.where : [])) {
            if (isObject(w)) collectLiteralBraces(w.value, litBraces);
        }
    }
    for (const lit of litBraces) {
        const shown = lit.length > 48 ? lit.slice(0, 48) + '…' : lit;
        pushW({ code: 'literal.uninterpolated', severity: 'warning', path: at, message: `Step ${step.id}: literal input "${shown}" contains {{…}} but is kind:'literal', so it ships verbatim instead of being interpolated.`, hint: "Set kind:'template' on that input so {{trigger.output.…}} / {{steps.…}} placeholders are substituted at runtime." });
    }

    const fieldAt = (where) => (where ? `${at}${where.startsWith('[') ? '' : '.'}${where}` : at);
    const fieldName = (where) => (where ? `"${where}"` : 'a binding');

    // A `steps.<id>` read: the step must exist and must have run by now.
    const checkStepRead = (upstreamId, shown, tokens) => {
        if (!refIds.has(upstreamId) && upstreamId !== step.id) {
            // Promote unknown-step refs to errors with a "did you mean"
            // suggestion so the LLM gets the actual id in its hint
            // and self-corrects on the next turn instead of repeating
            // the fabricated id.
            const candidates = Array.from(refIds).filter(id => id !== trigger.id && id !== step.id);
            const suggestion = pickClosestId(upstreamId, candidates);
            // QUOTE THE BINDING. The message used to name only the
            // missing id, and the mutation echo carries no `inputs` —
            // so a model whose memory of what it wrote differed from
            // what it actually wrote had no surface anywhere that
            // showed the difference. One observed build burned ten
            // rounds insisting it had written the full id when it had
            // written a bare tempId. Quoting the path ends that.
            const idList = candidates.join(', ') || '(none yet)';
            const looksLikeTempId = suggestion && String(suggestion).startsWith(`${upstreamId}_`);
            pushE({
                code: 'ref.unknown_step',
                severity: 'error',
                path: at,
                message: `Step ${step.id}: binding "${shown}" refers to non-existent step "${upstreamId}".`,
                hint: looksLikeTempId
                    ? `The real id is "${suggestion}". If "${upstreamId}" was a builder_add_steps tempId, note that tempIds only resolve inside the call that declared them, and only when written as steps.$${upstreamId} — afterwards use the minted id. Available step ids: ${idList}.`
                    : suggestion
                        ? `Did you mean "${suggestion}"? Available step ids: ${idList}.`
                        : `No step of that name exists. Available step ids: ${idList}.`,
            });
            return;
        }
        if (!refSeen.has(upstreamId) && upstreamId !== step.id) {
            pushW({ code: 'ref.forward', severity: 'warning', path: at, message: `Step ${step.id}: refers to step "${upstreamId}" — will resolve to undefined at runtime if it doesn't produce output by then.`, hint: `Wire an edge from "${upstreamId}" to "${step.id}" so the upstream output is available.` });
        }
        // `count` on a find_rows step is rows.length CLAMPED BY THE
        // PAGE SIZE — never "how many rows match" — so a condition on
        // `count > 100` after a page of 50 can never fire. It is now
        // `returned`, with `count` kept as an alias for one release;
        // name the step so the author can find the binding.
        const upstream = stepsById.get(upstreamId);
        if (tokens && upstream && upstream.type === 'datatable'
            && (upstream.op || 'find_rows') === 'find_rows'
            && tokens.length === 4 && tokens[2].key === 'output' && tokens[3].key === 'count') {
            pushW({ code: 'datatable.count_deprecated', severity: 'warning', path: at, message: `Step ${step.id}: "${upstreamId}.output.count" is the number of rows on THIS PAGE, not how many rows match.`, hint: `Use ${upstreamId}.output.returned for the page size, or a "Count rows" step for the real total. \`count\` still works for now.` });
        }
    };

    // An expression: parse it the way the runner will, report a parse error
    // where nothing else does, and scope every `steps.<id>` it reads.
    const checkExpr = (r) => {
        const opts = r.host === 'topics' ? { host: TOPIC_HOST_SPEC } : undefined;
        const { ast, error } = tryParseExpr(r.src, opts);
        if (error) {
            if (!(r.parse ?? r.binding)) return;     // its own rule reports it (condition/switch/filter/set)
            const suggestion = suggestExprSpelling(r.src, opts);
            pushW({
                code: 'expr.parse', severity: 'warning', path: fieldAt(r.where),
                message: `Step ${step.id}: the expression in ${fieldName(r.where)} does not parse (${error.message}), so it evaluates to nothing at run time.`,
                hint: suggestion
                    ? `Write it as: ${suggestion}`
                    : 'Expressions read paths without {{ }}: write a list position as [0] and a key with spaces or symbols as ["…"].',
            });
            return;
        }
        for (const id of new Set(exprStepIds(ast))) checkStepRead(id, r.src, null);
    };

    for (const r of refs) {
        if (r.kind === 'expr') { checkExpr(r); continue; }
        const path = r.path;
        if (typeof path !== 'string' || !path) continue;
        const head = refHead(path);
        const { root } = head;
        if (!root) { pushW({ code: 'ref.invalid', severity: 'warning', path: at, message: `Step ${step.id}: invalid ref "${path}".`, hint: 'Refs must start with one of: trigger, steps, vars, secrets, loop.' }); continue; }
        // A path the runner cannot read resolves to nothing, silently. Name
        // the field and give the spelling it would read; the head is still
        // checked below, so an unknown step behind a bad tail is an error too.
        if (!head.valid) {
            const suggestion = suggestPathSpelling(path);
            pushW({
                code: 'ref.syntax', severity: 'warning', path: fieldAt(r.where),
                message: `Step ${step.id}: ${fieldName(r.where)} reads ${r.template ? `{{ ${path} }}` : `"${path}"`}, which is not a path the run can read — it resolves to nothing.`,
                hint: suggestion
                    ? `Write it as ${suggestion} — a key with spaces or symbols goes in ["…"], a position in a list in [0].`
                    : 'Use dots between names, [0] for a position in a list and ["…"] around a key with spaces or symbols. A {{ }} placeholder holds one path, not a calculation.',
            });
            if (!REF_ROOTS.has(root) && root !== 'item' && root !== '_index') continue;
        }
        if (root === 'loop') {
            // `loop.<var>` is bound by this step's own forEach or by a loop
            // whose body holds it — nowhere else. A step that reads
            // loop.e without iterating gets undefined for every field at
            // run time; measured 2026-09-12 as a create_row whose every
            // column was empty, on an automation that had validated clean.
            const v = head.second;
            // The forEach binds its item AND the outer items it keeps
            // (forEach.parents — a step deepened into a list inside each item).
            const ownVars = forEachBoundVars(step.forEach);
            const own = ownVars[0] || null;
            const above = loopVarsAbove.get(step) || [];
            // `loop._index` is injected by execFlow beside the item, so it
            // is bound exactly where any itemVar is — and unbound only
            // where none is (no forEach, not inside a loop body).
            const injected = LOOP_RUNTIME_KEYS.has(v);
            if (v && (injected ? (!own && !above.length) : (!ownVars.includes(v) && !above.includes(v)))) {
                const bound = [...ownVars, ...above];
                pushE({
                    code: 'ref.loop_unbound', severity: 'error', path: at,
                    message: `Step ${step.id}: binding "${path}" reads loop.${v}, but nothing binds "${v}" for this step${bound.length ? ` (bound here: ${bound.map(b => 'loop.' + b).join(', ')})` : ' — it has no forEach and is not inside a loop'}.`,
                    hint: own
                        ? `Use loop.${own}… (this step's forEach.itemVar), or rename itemVar to "${v}".`
                        : `Give this step a forEach ({overRef:"steps.<id>.output.results", itemVar:"${v}"}) so it runs once per item, or bind to the upstream output directly (steps.<id>.output.…).`,
                });
            }
            continue;
        }
        if (root === 'trigger' || root === 'vars' || root === 'secrets') continue;
        // List-mode set evaluates its field bindings per row with `item`
        // and `_index` injected into the scope (execSet, same convention
        // as execFilter). Without this, every editor-written
        // {kind:'ref', path:'item.x'} binding warned ref.invalid on save.
        // Filter/switch never hit this because their per-row positions
        // are exprs, which skip static sub-path checks.
        if ((root === 'item' || root === '_index')
            && (step.type === 'set' || step.type === 'datetime')
            && typeof step.arrayRef === 'string') continue;
        if (root === 'steps') {
            const upstreamId = head.second;
            if (!upstreamId) { pushW({ code: 'ref.no_step_id', severity: 'warning', path: at, message: `Step ${step.id}: ref must include a step id.`, hint: 'Use the form steps.<id>.output.<field>.' }); continue; }
            checkStepRead(upstreamId, path, head.tokens);
            continue;
        }
        pushW({ code: 'ref.unknown_root', severity: 'warning', path: at, message: `Step ${step.id}: unknown ref root "${root}".`, hint: 'Refs must start with one of: trigger, steps, vars, secrets, loop.' });
    }
}

module.exports = { checkReferences };
