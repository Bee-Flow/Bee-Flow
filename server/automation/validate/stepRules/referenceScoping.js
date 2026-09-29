/**
 * The pass over every BINDING a step carries, whatever field it sits in.
 *
 * Two halves. First the collection: each step type keeps its bindings
 * somewhere of its own — `inputs`, a template string on the step, a rule's
 * expr, a datatable's `values` and `where[].value` — so every one of them is
 * gathered here, and a type that is missing from this list is a type whose
 * references reach run time unchecked. Then the scoping: every collected ref's
 * root must resolve (trigger/steps/vars/secrets/loop), a `loop.<var>` must be
 * bound by this step's own forEach or by a loop it sits inside, and a
 * `steps.<id>` must name a step that exists and has already run.
 *
 * Runs LAST, after the per-type field rules, because a ref that is reported
 * here reads best after the step's own shape has been reported.
 */

const {
    isObject, collectRefPaths, collectLiteralBraces, rootOf, pickClosestId, secondSegment,
} = require('../helpers');
const { LOOP_RUNTIME_KEYS } = require('../constants');

function checkReferences(ctx, step, at) {
    const { pushE, pushW, trigger, refIds, refSeen, stepsById, loopVarsAbove } = ctx;
    // Reference scoping — collect all ref paths used in this step's
    // inputs / prompt / expr / template fields, ensure their roots
    // resolve to known sources, and any "steps.<id>.output" is for
    // a step that has run before this one. Inside a layer the same
    // roots apply: `trigger` is the layer_input (so bindings stay
    // {{trigger.output.<param>}}), `steps` are the layer's own steps.
    const refs = [];
    collectRefPaths(step.inputs, refs);
    // NOTE: ai_step.prompt IS interpolated by the runner (execAiStep,
    // leaveUnresolved:true) — the old premise here ("literal instruction
    // text") no longer holds. Prompts are still excluded from THIS
    // error-level refs pass: a `{{from}}` placeholder naming the step's
    // own inputs.from key is legitimate, and a typo can never crash a run.
    // The dedicated WARNING-only prompt lint lives in the ai_step block
    // above (ref.prompt_unknown_step / ref.prompt_unknown_root — C28).
    if (step.type === 'notification') {
        collectRefPaths({ kind: 'template', value: step.title || '' }, refs);
        collectRefPaths({ kind: 'template', value: step.body || '' }, refs);
    }
    if (step.type === 'condition') refs.push({ kind: 'expr', src: step.expr || '' });
    if (['guard', 'tokenize', 'untokenize'].includes(step.type) && step.sourceRef) refs.push({ kind: 'ref', path: step.sourceRef });
    if (step.type === 'untokenize' && !step.sourceRef) {
        pushW({ code: 'untokenize.sourceRef_missing', severity: 'warning', path: at + '.sourceRef', message: `Step ${step.id}: this step has nothing to restore yet.`, hint: 'Point it at the value that holds the placeholders. The run fails until you do.' });
    }
    if (step.type === 'loop' && step.overRef) refs.push({ kind: 'ref', path: step.overRef });
    // forEach iteration source resolves like a loop's overRef.
    if (step.forEach && typeof step.forEach.overRef === 'string' && step.forEach.overRef) refs.push({ kind: 'ref', path: step.forEach.overRef });
    if (step.type === 'set') collectRefPaths(step.fields, refs);
    if (step.type === 'layer_output') collectRefPaths(step.fields, refs);
    if (step.type === 'datetime') {
        // Literal dates are a DOCUMENTED input (the executor falls back to
        // parsing the config value when walkPath misses) — running them
        // through the ref checks produced false `ref.invalid`/`unknown_root`
        // warnings for every fixed date (C10). `today` etc. still goes
        // through ref validation: the runtime genuinely can't parse it, so
        // its warning is CORRECT.
        const isDateLiteral = (v) => /^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(v)
            || ((/\s/.test(v) || !rootOf(v)) && !Number.isNaN(Date.parse(v)));
        if (typeof step.input === 'string' && step.input && !isDateLiteral(step.input)) refs.push({ kind: 'ref', path: step.input });
        if (typeof step.input2 === 'string' && step.input2 && !isDateLiteral(step.input2)) refs.push({ kind: 'ref', path: step.input2 });
        // The source list in list mode, so a renamed upstream step is caught
        // here exactly like a collection op's arrayRef.
        if (typeof step.arrayRef === 'string' && step.arrayRef) refs.push({ kind: 'ref', path: step.arrayRef });
    }
    if (step.type === 'stop_error') collectRefPaths({ kind: 'template', value: step.message || '' }, refs);
    // Beide zijn {{…}}-templates die de runner interpoleert. Zonder deze
    // regel wijst een hernoemde of gekopieerde stap stilzwijgend nergens
    // meer heen: de toast wordt leeg en de app opent een recordscherm
    // zonder record — en niets meldt dat.
    if (step.type === 'return_to_app') {
        if (typeof step.toast?.message === 'string' && step.toast.message) collectRefPaths({ kind: 'template', value: step.toast.message }, refs);
        if (typeof step.navigateTo?.recordRef === 'string' && step.navigateTo.recordRef) collectRefPaths({ kind: 'template', value: step.navigateTo.recordRef }, refs);
    }
    // The text a data_extraction step reads is a binding like any input,
    // so a source pointing at a renamed, deleted or LATER step is caught
    // here rather than at run time, where it resolves to nothing and the
    // step fails with "there is no text to read".
    if (step.type === 'data_extraction') {
        if (typeof step.source === 'string' && step.source.trim()) {
            // The two bare-string forms the runner resolves, checked the
            // way the runner reads them.
            if (/\{\{[^}]+\}\}/.test(step.source)) collectRefPaths({ kind: 'template', value: step.source }, refs);
            else if (/^\s*(trigger|steps|vars|loop)\./.test(step.source)) refs.push({ kind: 'ref', path: step.source.trim() });
        } else {
            collectRefPaths(step.source, refs);
        }
    }
    if (step.type === 'generate_document') {
        // All three are `{{…}}` template strings interpolated at run time —
        // and `content` is almost always a reference to an upstream step, so
        // a typo there must warn like any other bad ref rather than silently
        // producing an empty document.
        for (const f of ['content', 'title', 'fileName']) {
            if (typeof step[f] === 'string' && step[f]) collectRefPaths({ kind: 'template', value: step[f] }, refs);
        }
    }
    if (step.type === 'slide') {
        for (const f of ['title', 'content', 'notes', 'image']) {
            if (typeof step[f] === 'string' && step[f]) collectRefPaths({ kind: 'template', value: step[f] }, refs);
        }
        // chart.data and stats are the visual bindings: a template string
        // or a {kind} binding either way.
        const cd = isObject(step.chart) ? step.chart.data : undefined;
        if (typeof cd === 'string' && cd) collectRefPaths({ kind: 'template', value: cd }, refs);
        else if (isObject(cd) && typeof cd.kind === 'string') collectRefPaths(cd, refs);
        if (typeof step.stats === 'string' && step.stats) collectRefPaths({ kind: 'template', value: step.stats }, refs);
        else if (isObject(step.stats) && typeof step.stats.kind === 'string') collectRefPaths(step.stats, refs);
    }
    if (step.type === 'presentation') {
        for (const f of ['title', 'subtitle', 'fileName', 'accent', 'background', 'logo', 'footerText']) {
            if (typeof step[f] === 'string' && step[f]) collectRefPaths({ kind: 'template', value: step[f] }, refs);
        }
        // `slides` is the flexible one: a template string, or a list whose
        // string items (and the string values of object items) are
        // templates — a typo in "{{steps.s1.output.slide}}" must warn.
        const walk = (v, depth = 0) => {
            if (depth > 3 || v === null || v === undefined) return;
            if (typeof v === 'string') { if (v) collectRefPaths({ kind: 'template', value: v }, refs); return; }
            if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
            if (isObject(v)) {
                if (typeof v.kind === 'string') { collectRefPaths(v, refs); return; }
                for (const x of Object.values(v)) walk(x, depth + 1);
            }
        };
        walk(step.slides);
    }
    if (step.type === 'fill_document') {
        // `fileName` and every VALUE is a `{{…}}` template resolved at run
        // time, and a value is almost always a reference to an upstream
        // step — so a typo there must warn like any other bad ref instead
        // of silently printing a blank line on an invoice.
        if (typeof step.fileName === 'string' && step.fileName) collectRefPaths({ kind: 'template', value: step.fileName }, refs);
        if (typeof step.copyName === 'string' && step.copyName) collectRefPaths({ kind: 'template', value: step.copyName }, refs);
        if (step.values && typeof step.values === 'object' && !Array.isArray(step.values)) {
            for (const v of Object.values(step.values)) {
                if (typeof v === 'string' && v) collectRefPaths({ kind: 'template', value: v }, refs);
                else if (v && typeof v === 'object') collectRefPaths(v, refs);
            }
        }
    }
    if (step.type === 'switch') {
        refs.push({ kind: 'expr', src: step.expr || '' });
        // A switch's source list + its per-case rules resolve like any
        // other ref. Rule exprs reference `item` in list mode, which the
        // runtime injects per row — same shortcut condition/filter use.
        if (typeof step.arrayRef === 'string' && step.arrayRef) refs.push({ kind: 'ref', path: step.arrayRef });
        for (const c of (Array.isArray(step.cases) ? step.cases : [])) {
            if (isObject(c) && typeof c.expr === 'string' && c.expr) refs.push({ kind: 'expr', src: c.expr });
        }
    }
    if ((step.type === 'filter' || step.type === 'limit' || step.type === 'dedupe' || step.type === 'aggregate' || step.type === 'summarize') && step.arrayRef) {
        refs.push({ kind: 'ref', path: step.arrayRef });
    }
    // List-mode set: the source list resolves like any other ref.
    if (step.type === 'set' && typeof step.arrayRef === 'string' && step.arrayRef) {
        refs.push({ kind: 'ref', path: step.arrayRef });
    }
    // parse_json's source resolves like any other ref (root/unknown-step/
    // forward-ref checks apply). Field paths are RELATIVE to the source —
    // validated structurally above, not as runState refs.
    if (step.type === 'parse_json' && typeof step.sourceRef === 'string' && step.sourceRef) {
        refs.push({ kind: 'ref', path: step.sourceRef });
    }
    // A datatable carries its bindings in `values` and `where[].value`, not
    // in `inputs`, so none of them were checked: a value pointing at a
    // renamed, deleted or LATER step reached run time, where a write turns
    // it into NULL and a condition turns it into a skip.
    // The same three-template shape `generate_document` has — `content`,
    // `title` and `sourceUri` are `{{…}}` strings on the step rather than
    // entries in `inputs`, so without this a reference to a renamed,
    // deleted or LATER step reached run time, where it resolves to nothing
    // and the step stores an empty document into a knowledge base.
    //
    // A binding OBJECT is accepted here too, though nothing this product
    // writes produces one: a definition is data, and an import or an MCP
    // patch can carry the shape the AI builder's older tools used.
    if (step.type === 'knowledge_write') {
        for (const f of ['content', 'title', 'sourceUri']) {
            if (typeof step[f] === 'string' && step[f]) collectRefPaths({ kind: 'template', value: step[f] }, refs);
            else collectRefPaths(step[f], refs);
        }
    }
    if (step.type === 'datatable') {
        collectRefPaths(step.values, refs);
        // `cursor` is a binding like any other — it is how a loop walks a
        // table bigger than one page ({{steps.page1.output.nextCursor}}),
        // so a typo in it has to be caught here rather than silently
        // restarting at page 1 on every iteration.
        collectRefPaths(step.cursor, refs);
        for (const w of (Array.isArray(step.where) ? step.where : [])) {
            if (isObject(w)) collectRefPaths(w.value, refs);
        }
    }
    // Filter's expr references `item` (loop-style scalar). The
    // runtime injects item per element so we don't validate sub-paths
    // here; the runtime returns undefined for typos. Same shortcut
    // condition/switch already use for their exprs.

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

    for (const r of refs) {
        const path = r.kind === 'ref' ? r.path : null;
        // For exprs, we don't statically check sub-paths — runtime will
        // safely return undefined for unknown lookups.
        if (!path) continue;
        const root = rootOf(path);
        if (!root) { pushW({ code: 'ref.invalid', severity: 'warning', path: at, message: `Step ${step.id}: invalid ref "${path}".`, hint: 'Refs must start with one of: trigger, steps, vars, secrets, loop.' }); continue; }
        if (root === 'loop') {
            // `loop.<var>` is bound by this step's own forEach or by a loop
            // whose body holds it — nowhere else. A step that reads
            // loop.e without iterating gets undefined for every field at
            // run time; measured 2026-09-12 as a create_row whose every
            // column was empty, on a routine that had validated clean.
            const v = secondSegment(path);
            const own = isObject(step.forEach) && typeof step.forEach.itemVar === 'string' ? step.forEach.itemVar : null;
            const above = loopVarsAbove.get(step) || [];
            // `loop._index` is injected by execFlow beside the item, so it
            // is bound exactly where any itemVar is — and unbound only
            // where none is (no forEach, not inside a loop body).
            const injected = LOOP_RUNTIME_KEYS.has(v);
            if (v && (injected ? (!own && !above.length) : (v !== own && !above.includes(v)))) {
                const bound = [own, ...above].filter(Boolean);
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
            const upstreamId = secondSegment(path);
            if (!upstreamId) { pushW({ code: 'ref.no_step_id', severity: 'warning', path: at, message: `Step ${step.id}: ref must include a step id.`, hint: 'Use the form steps.<id>.output.<field>.' }); continue; }
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
                    message: `Step ${step.id}: binding "${path}" refers to non-existent step "${upstreamId}".`,
                    hint: looksLikeTempId
                        ? `The real id is "${suggestion}". If "${upstreamId}" was a builder_add_steps tempId, note that tempIds only resolve inside the call that declared them, and only when written as steps.$${upstreamId} — afterwards use the minted id. Available step ids: ${idList}.`
                        : suggestion
                            ? `Did you mean "${suggestion}"? Available step ids: ${idList}.`
                            : `No step of that name exists. Available step ids: ${idList}.`,
                });
                continue;
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
            if (upstream && upstream.type === 'datatable'
                && (upstream.op || 'find_rows') === 'find_rows'
                && /^steps\.[^.]+\.output\.count$/.test(path)) {
                pushW({ code: 'datatable.count_deprecated', severity: 'warning', path: at, message: `Step ${step.id}: "${upstreamId}.output.count" is the number of rows on THIS PAGE, not how many rows match.`, hint: `Use ${upstreamId}.output.returned for the page size, or a "Count rows" step for the real total. \`count\` still works for now.` });
            }
            continue;
        }
        pushW({ code: 'ref.unknown_root', severity: 'warning', path: at, message: `Step ${step.id}: unknown ref root "${root}".`, hint: 'Refs must start with one of: trigger, steps, vars, secrets, loop.' });
    }
}

module.exports = { checkReferences };
