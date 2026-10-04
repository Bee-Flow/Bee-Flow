/**
 * Describe → document: one forced tool call, the mechanical repairs, ONE
 * repair round on the validator's findings, and a clear refusal when the
 * model still cannot make it runnable.
 *
 * Run: node --test --test-force-exit playbooks/composeRecipe.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { composeRecipe, RECIPE_TOOL, systemPrompt } = require('./composeRecipe');
const C = require('./composeRecipe');

// The contract: a top-level `columns` array, required, alphabetically first.
const GOOD = { columns: [{ key: 'naam', name: 'Naam', type: 'text' }], title: 'Leveranciers', phases: [{ kind: 'automation', label: 'R', brief: 'Build an automation into "{{table.name}}" with {{field.naam}}' }, { kind: 'app', label: 'A', brief: 'Build an app on {{table.name}}' }] };

// What chatForcedTool returns: the parsed document plus the stop reason and
// the raw argument string it was parsed from. An answer given as a bare
// document is wrapped as a clean tool call; one given as `{ structured, … }`
// is returned as is, so a test can hand over a cut-off answer.
function forcedResult(answer) {
    if (answer && typeof answer === 'object' && 'structured' in answer) return { content: null, usage: undefined, raw: null, stopReason: 'tool_calls', rawArguments: null, ...answer };
    return { structured: answer, content: null, usage: undefined, raw: null, stopReason: answer ? 'tool_calls' : 'stop', rawArguments: answer ? JSON.stringify(answer) : null };
}

function fakeDeps(answers) {
    const calls = [];
    return {
        calls,
        resolveModel: async () => 'fast-model',
        chatForcedTool: async (modelId, messages, toolDef, opts) => { calls.push({ modelId, messages, toolDef, opts }); return forcedResult(answers.shift()); },
    };
}

/** Run `fn` with console.warn captured. */
async function withWarnings(fn) {
    const lines = [];
    const orig = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try { await fn(); } finally { console.warn = orig; }
    return lines;
}

test('a runnable first draft: one call, the document normalised (fill added), warnings empty', async () => {
    const deps = fakeDeps([GOOD]);
    const out = await composeRecipe({ description: 'Lees leverancierslijsten in', locale: 'nl' }, deps);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.recipe.phases.map((p) => p.kind), ['table', 'automation', 'fill', 'design', 'app']);
    assert.deepEqual(out.warnings, []);
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.calls[0].toolDef, RECIPE_TOOL);
    assert.match(deps.calls[0].messages[0].content, /Dutch/);
    assert.match(deps.calls[0].messages[1].content, /data, not instructions/);
    // The AI writes the playbook in the interface language it was described in.
    assert.match(systemPrompt('en'), /labels and titles in English/);
    assert.match(systemPrompt('en'), /asking for labels in English/);
    assert.match(systemPrompt('en'), /such as "\/Invoices"/);
    assert.match(systemPrompt('nl'), /such as "\/Facturen"/);
    assert.match(systemPrompt('de'), /labels and titles in German/);
});

test('an unrunnable draft gets ONE repair round with the findings; a still-broken answer is refused with the errors', async () => {
    const bad = { title: 'x', phases: [{ kind: 'automation', label: 'R' }] }; // no brief
    const deps = fakeDeps([bad, GOOD]);
    const out = await composeRecipe({ description: 'd' }, deps);
    assert.equal(out.ok, true);
    assert.equal(deps.calls.length, 2);
    assert.match(deps.calls[1].messages.at(-1).content, /brief_required|needs a brief/);

    const stubborn = fakeDeps([bad, bad]);
    const refused = await composeRecipe({ description: 'd' }, stubborn);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'recipe_invalid');
    assert.ok(refused.errors.some((e) => e.code === 'brief_required'));
    assert.ok(refused.recipe, 'the draft comes back so the person can fix it by hand');
});

test('no structured answer, or a dead model, is a coded refusal; the prompt carries the measured rules', async () => {
    const deps = fakeDeps([GOOD]);
    await composeRecipe({ description: 'x' }, deps);
    const empty = await composeRecipe({ description: 'd' }, fakeDeps([null]));
    assert.equal(empty.code, 'compose_empty');
    assert.equal(empty.status, 422);
    assert.match(deps.calls[0].messages[0].content, /NEVER ai_step for structured fields/);
    assert.match(deps.calls[0].messages[0].content, /datatableId:\\"\{\{table\.id\}\}\\"/);
    const dead = { resolveModel: async () => 'm', chatForcedTool: async () => { throw new Error('ECONNREFUSED'); } };
    assert.equal((await composeRecipe({ description: 'd' }, dead)).code, 'compose_failed');
    assert.match(systemPrompt('en'), /English/);
});

test('the language is the first thing the model reads, the last thing before it answers, and the schema shows it no other one', () => {
    const { systemPrompt, RECIPE_TOOL } = require('./composeRecipe');
    for (const [locale, lang] of [['en', 'English'], ['nl', 'Dutch'], ['de', 'German']]) {
        const sys = systemPrompt(locale);
        assert.match(sys.split('\n')[0], new RegExp(`^LANGUAGE: ${lang}\\.`), 'the demand opens the prompt');
        assert.match(sys.trim().split('\n').at(-1), new RegExp(`in ${lang}\\.$`), 'and closes it');
    }
    // The schema used to teach Dutch by example ("e.g. datum"), which a small
    // model copies whatever the prompt says (measured 2026-09-16).
    const json = JSON.stringify(RECIPE_TOOL);
    assert.doesNotMatch(json, /datum|Nederlands|Dutch/i);
    assert.match(json, /e\.g\. invoice_date/);
});

test('the user turn repeats the language, so the last thing read is not the person\'s own', async () => {
    const seen = [];
    const deps = {
        resolveModel: async () => 'fast',
        chatForcedTool: async (m, messages) => { seen.push(messages); return forcedResult(null); },
    };
    await composeRecipe({ description: 'Lees de facturen in /Facturen', locale: 'en' }, deps);
    const user = seen[0].at(-1);
    assert.equal(user.role, 'user');
    assert.match(user.content, /you answer in English/);
    assert.match(user.content, /every label and column name in English\.$/);
    assert.match(user.content, /Lees de facturen in \/Facturen/, 'the description itself is untouched');
});


test('the model is never offered a kind the prompt does not explain', () => {
    // `access` and `compliance` are appended by withClosingPhases after the last
    // app phase. Offering them in the enum meant a model could put an access
    // phase second, nothing was appended, and the stage mounted with no app.
    assert.ok(!C.PROPOSABLE_KINDS.includes('access'));
    assert.ok(!C.PROPOSABLE_KINDS.includes('compliance'));
    assert.deepEqual([...C.PROPOSABLE_KINDS], ['table', 'automation', 'fill', 'design', 'app', 'app_turn']);
    assert.deepEqual(C.RECIPE_TOOL.function.parameters.properties.phases.items.properties.kind.enum, [...C.PROPOSABLE_KINDS]);
});

test('a workspace without the approvals capability is not asked to write one', () => {
    const on = C.systemPrompt('en', { approvalsAllowed: true });
    const off = C.systemPrompt('en', { approvalsAllowed: false });
    assert.match(on, /An APPROVAL FLOW is a second `automation` phase/);
    assert.match(off, /never propose an approval flow/);
    assert.doesNotMatch(off, /builder_add_approval/);
    // The approval paragraph is the longest single rule in the prompt; not
    // sending it to a small local model that cannot use it is most of a
    // kilobyte of instruction back.
    assert.ok(on.length - off.length > 800, `saved ${on.length - off.length} chars`);
    // And the option itself is gone from the contract, not merely discouraged.
    assert.ok(C.recipeTool({ approvalsAllowed: false }).function.parameters.properties.phases.items.properties.requires === undefined);
    assert.ok(C.recipeTool({ approvalsAllowed: true }).function.parameters.properties.phases.items.properties.requires);
});

test('the schema puts `columns` first, requires it, and neither it nor the prompt speaks of table.fields any more', () => {
    // Gemma's chat template renders a tool's properties SORTED BY NAME, and
    // an optional key that came last was the one the model skipped after
    // writing five briefs (four composes in one day, 2026-09-17). Required,
    // top-level and alphabetically first, the columns are written before
    // anything long.
    const params = RECIPE_TOOL.function.parameters;
    assert.equal(Object.keys(params.properties)[0], 'columns');
    assert.deepEqual([...Object.keys(params.properties)].sort()[0], 'columns', 'first in sorted order too');
    assert.deepEqual(params.required, ['title', 'columns', 'phases']);
    assert.equal(params.properties.table, undefined, 'the nested object is gone from the contract');
    const col = params.properties.columns;
    assert.equal(col.type, 'array');
    assert.deepEqual(col.items.required, ['key', 'name', 'type']);
    assert.deepEqual(col.items.properties.type.enum, ['text', 'richtext', 'number', 'date', 'datetime', 'bool', 'select', 'multiselect', 'file']);
    assert.match(col.description, /Empty array only when the playbook needs no table/);
    assert.match(RECIPE_TOOL.function.description, /columns of its table \(empty when none\)/);
    // The prompt speaks the same language as the schema.
    for (const locale of ['en', 'nl', 'de']) {
        for (const approvalsAllowed of [true, false]) {
            const sys = systemPrompt(locale, { approvalsAllowed });
            assert.doesNotMatch(sys, /table\.fields/, `${locale}/${approvalsAllowed}: the old spelling`);
            assert.match(sys, /creates a Studio datatable from the top-level `columns` list/);
            assert.match(sys, /never put columns inside a phase/);
            assert.match(sys, /entries in `columns`\. Column keys snake_case/);
            assert.match(sys, /a brief may only reference keys that `columns` declares/);
            assert.match(sys, /ALWAYS declares its `columns` — a fill phase and every \{\{field\.…\}\} depend on them/);
        }
    }
    assert.doesNotMatch(JSON.stringify(RECIPE_TOOL), /table\.fields/);
    // And the capability-narrowed tool is the same contract minus `requires`.
    const off = C.recipeTool({ approvalsAllowed: false }).function.parameters;
    assert.equal(Object.keys(off.properties)[0], 'columns');
    assert.deepEqual(off.required, ['title', 'columns', 'phases']);
});

test('the repair round is a native tool_call/tool pair echoing the model\'s own arguments', async () => {
    const bad = { columns: [], title: 'x', phases: [{ kind: 'automation', label: 'R' }] }; // no brief
    const deps = fakeDeps([bad, GOOD]);
    const out = await composeRecipe({ description: 'd', locale: 'en' }, deps);
    assert.equal(out.ok, true);
    const second = deps.calls[1].messages;
    assert.equal(second.length, 4, 'system, user, the call, its result');
    assert.deepEqual(second.slice(0, 2), deps.calls[0].messages, 'the prefix is byte-identical, so the prompt cache holds');
    const call = second[2];
    assert.equal(call.role, 'assistant');
    assert.equal(call.content, null);
    assert.equal(call.tool_calls.length, 1);
    // Nine alphanumerics: Mistral's API rejects any other tool-call id shape,
    // and the rest (Anthropic, OpenAI, Google, llama.cpp) take it too.
    assert.deepEqual(call.tool_calls[0], { id: 'repair001', type: 'function', function: { name: 'return_playbook', arguments: JSON.stringify(bad) } });
    assert.match(call.tool_calls[0].id, /^[a-zA-Z0-9]{9}$/);
    const result = second[3];
    assert.equal(result.role, 'tool');
    assert.equal(result.tool_call_id, 'repair001');
    assert.equal(result.name, 'return_playbook');
    assert.match(result.content, /^NOT RUNNABLE\. Fix exactly these and call return_playbook again with the WHOLE playbook:\n- Phase "R" needs a brief\./);
    // The same tool, the same options, both rounds.
    assert.equal(deps.calls[1].toolDef, deps.calls[0].toolDef);
    assert.deepEqual(deps.calls[1].opts, deps.calls[0].opts);

    // Arguments that were loosely repaired from a non-JSON shape are echoed
    // as the parsed object — llama.cpp parses an assistant tool call's
    // arguments for the template and 400s the round on a string that is not JSON.
    const dsl = fakeDeps([{ structured: bad, rawArguments: '{title:<|"|>x<|"|>,phases:[' }, GOOD]);
    await composeRecipe({ description: 'd' }, dsl);
    assert.equal(dsl.calls[1].messages[2].tool_calls[0].function.arguments, JSON.stringify(bad));
    // No raw string at all (a provider that hands over parsed input): same.
    const parsedOnly = fakeDeps([{ structured: bad, rawArguments: null }, GOOD]);
    await composeRecipe({ description: 'd' }, parsedOnly);
    assert.equal(parsedOnly.calls[1].messages[2].tool_calls[0].function.arguments, JSON.stringify(bad));
});

test('an answer cut off at max_tokens is compose_truncated — its own sentence, on either round', async () => {
    for (const stop of ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS']) {
        const out = await composeRecipe({ description: 'd' }, fakeDeps([{ structured: null, stopReason: stop }]));
        assert.equal(out.ok, false);
        assert.equal(out.code, 'compose_truncated', stop);
        assert.equal(out.status, 422);
        assert.match(out.error, /longer than the model can write in one answer — describe fewer screens and steps, or split it into two playbooks/);
    }
    // Nothing, and not cut off: the empty refusal as before.
    const empty = await composeRecipe({ description: 'd' }, fakeDeps([{ structured: null, stopReason: 'stop' }]));
    assert.equal(empty.code, 'compose_empty');
    // The repair round cut off: the fix is a shorter description, not the
    // first draft's findings.
    const bad = { columns: [], title: 'x', phases: [{ kind: 'automation', label: 'R' }] };
    const cut = await composeRecipe({ description: 'd' }, fakeDeps([bad, { structured: null, stopReason: 'length' }]));
    assert.equal(cut.code, 'compose_truncated');
    // The repair round empty but not cut off: the first draft's findings, as today.
    const dud = await composeRecipe({ description: 'd' }, fakeDeps([bad, { structured: null, stopReason: 'stop' }]));
    assert.equal(dud.code, 'recipe_invalid');
    assert.ok(dud.errors.some((e) => e.code === 'brief_required'));
});

test('a cut-off answer the loose parser could still close is a PARTIAL document: refused as truncated, never repaired', async () => {
    // The arguments cut right after the table phase: `parseGemmaArgs`
    // closes the brackets and hands back a document with one phase. Judged
    // as a document it "has no builder phase" — a finding that would send
    // the model re-writing the same over-long playbook (cut again) and the
    // person fixing the wrong thing. The stop reason says what really
    // happened, and the argument string (not JSON) says the tail is missing.
    const cutArgs = '{"columns":[{"key":"invoice_date","name":"Invoice date","type":"date"}],"title":"Invoices","phases":[{"kind":"table","label":"Table"},';
    const partial = { columns: [{ key: 'invoice_date', name: 'Invoice date', type: 'date' }], title: 'Invoices', phases: [{ kind: 'table', label: 'Table' }] };
    const deps = fakeDeps([{ structured: partial, stopReason: 'length', rawArguments: cutArgs }, GOOD]);
    let out;
    const lines = await withWarnings(async () => { out = await composeRecipe({ description: 'd', locale: 'en' }, deps); });
    assert.equal(out.code, 'compose_truncated', JSON.stringify(out));
    assert.equal(out.status, 422);
    assert.equal(deps.calls.length, 1, 'no repair round — it could only be cut the same way');
    assert.ok(lines.some((l) => /\[Playbooks\] compose truncated on round 1: stop=length, document keys \[columns, title, phases\], phases=1/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /compose invalid/.test(l)), 'a cut-off answer is not an invalid one');

    // Even one that happens to validate: the last brief is cut mid-sentence
    // and would run half-written. The loose parser's closing is the tell —
    // the argument string is not JSON.
    const halfBrief = { ...GOOD, phases: [GOOD.phases[0], { kind: 'app', label: 'A', brief: '## Build an app on {{table.name}}\n1. `app_set_plan`\n2. `app_link_da' }] };
    const half = await composeRecipe({ description: 'd' }, fakeDeps([{ structured: halfBrief, stopReason: 'length', rawArguments: JSON.stringify(halfBrief).slice(0, -8) }]));
    assert.equal(half.code, 'compose_truncated');

    // But a truncated stop whose argument string is complete JSON means the
    // cap fell AFTER the closing brace: the document is whole, and runs.
    const whole = await composeRecipe({ description: 'd' }, fakeDeps([{ structured: GOOD, stopReason: 'length', rawArguments: JSON.stringify(GOOD) }]));
    assert.equal(whole.ok, true, JSON.stringify(whole));
    // …and when whole but invalid, it earns the repair round like any other
    // draft — the findings are real, not an artifact of the cut.
    const bad = { columns: [], title: 'x', phases: [{ kind: 'automation', label: 'R' }] };
    const wholeBad = fakeDeps([{ structured: bad, stopReason: 'length', rawArguments: JSON.stringify(bad) }, GOOD]);
    const fixed = await composeRecipe({ description: 'd' }, wholeBad);
    assert.equal(fixed.ok, true);
    assert.equal(wholeBad.calls.length, 2);

    // The repair round cut short the same way: truncated, on round 2, even
    // though the first draft's findings were about a brief.
    const cut2 = fakeDeps([bad, { structured: partial, stopReason: 'length', rawArguments: cutArgs }]);
    let out2;
    const lines2 = await withWarnings(async () => { out2 = await composeRecipe({ description: 'd' }, cut2); });
    assert.equal(out2.code, 'compose_truncated');
    assert.equal(cut2.calls.length, 2);
    assert.ok(lines2.some((l) => /compose truncated on round 2: stop=length/.test(l)), lines2.join('\n'));
    // A cut-off repair with no arguments to read at all (a provider that
    // parsed them itself): the stop reason alone decides.
    const noRaw = await composeRecipe({ description: 'd' }, fakeDeps([bad, { structured: partial, stopReason: 'max_tokens', rawArguments: null }]));
    assert.equal(noRaw.code, 'compose_truncated');
});

test('a repair round the runtime refuses is logged and told apart from a model that could not repair', async () => {
    // A chat template that cannot render the tool_call/tool pair answers
    // 400; BaseProvider throws without logging. The first draft's findings
    // stand, and the log says the second round never answered — otherwise
    // the live gate reads a dead repair path as model quality.
    const bad = { columns: [], title: 'x', phases: [{ kind: 'automation', label: 'R' }] };
    let n = 0;
    const deps = {
        resolveModel: async () => 'gemma-4-26b-a4b',
        chatForcedTool: async () => { if (n++ === 0) return forcedResult(bad); throw new Error('llamacpp API error 400: Unsupported param: tool_calls'); },
    };
    let out;
    const lines = await withWarnings(async () => { out = await composeRecipe({ description: 'd' }, deps); });
    assert.equal(out.code, 'recipe_invalid');
    assert.ok(out.errors.some((e) => e.code === 'brief_required'), 'the first draft\'s findings');
    assert.ok(lines.some((l) => l === '[Playbooks] compose repair round failed on gemma-4-26b-a4b: llamacpp API error 400: Unsupported param: tool_calls'), lines.join('\n'));
    const invalid = lines.find((l) => /compose invalid/.test(l));
    assert.match(invalid, /round=1, stop=tool_calls, repair=failed/);

    // The other outcomes are named too: a repair no better than the draft,
    // and one that came back empty.
    const worse = { columns: [], title: 'x', phases: [{ kind: 'automation', label: 'R' }, { kind: 'app', label: 'A' }] };
    const discarded = await withWarnings(async () => { await composeRecipe({ description: 'd' }, fakeDeps([bad, worse])); });
    assert.match(discarded.find((l) => /compose invalid/.test(l)), /round=1, stop=tool_calls, repair=discarded/);
    const empty = await withWarnings(async () => { await composeRecipe({ description: 'd' }, fakeDeps([bad, { structured: null, stopReason: 'stop' }])); });
    assert.match(empty.find((l) => /compose invalid/.test(l)), /round=1, stop=tool_calls, repair=empty/);
    const adopted = await withWarnings(async () => { await composeRecipe({ description: 'd' }, fakeDeps([worse, bad])); });
    assert.match(adopted.find((l) => /compose invalid/.test(l)), /round=2, stop=tool_calls, repair=adopted/);
});

test('the findings locate a phase by the label the model wrote, not by its index in the normalised document', async () => {
    // Raw: [table, automation, app-without-brief]. Normalised: [table, automation,
    // fill, design, app] — the app is phases[4] there, phases[2] in the call
    // the repair round echoes. A small model told about phases[4] in a
    // three-phase call adds phases rather than fixes one.
    const raw = {
        columns: [{ key: 'supplier', name: 'Supplier', type: 'text' }, { key: 'state', name: 'State', type: 'select' }],
        title: 'Invoices',
        phases: [
            { key: 'table', kind: 'table', label: 'Table' },
            { key: 'read', kind: 'automation', label: 'Read invoices', brief: '## Build an automation\n1. `data_extraction` {{field.supplier}} and {{field.amount}}\n2. `datatable add_row` into **{{table.name}}**', requiresRole: 'status' },
            { key: 'app', kind: 'app', label: 'App' },
        ],
    };
    const deps = fakeDeps([raw, GOOD]);
    await composeRecipe({ description: 'd', locale: 'en' }, deps);
    const findings = deps.calls[1].messages.at(-1).content.split('\n').slice(1);
    assert.deepEqual(findings, [
        '- Column "state" is a select without options.',
        '- phase "Read invoices": {{field.amount}} is not a column key — `columns` declares: supplier, state.',
        '- phase "Read invoices": requiresRole "status" is not a column of the table.',
        '- Phase "App" needs a brief.',
    ]);
    assert.ok(!/phases\[\d+\]|columns\[\d+\]|table\.fields/.test(deps.calls[1].messages.at(-1).content), 'no index into a document the model does not hold');
    // Findings on the document itself keep their path — there is nothing
    // else to point at.
    const bare = fakeDeps([{ columns: [], phases: [{ kind: 'table', label: 'T' }] }, GOOD]);
    await composeRecipe({ description: 'd', locale: 'en' }, bare);
    const lines = bare.calls[1].messages.at(-1).content.split('\n').slice(1);
    assert.ok(lines.includes('- title: A title is required.'), lines.join('\n'));
    assert.ok(lines.includes('- phases: A playbook needs an automation or an app phase — a table alone builds nothing.'), lines.join('\n'));
    assert.ok(lines.includes('- Phase "T" is a table phase but the document has no columns. Add a top-level `columns` array with one entry {key, name, type} per column.'), lines.join('\n'));
});

test('a table is synthesized from the briefs\' placeholders ONLY after the repair round still declared none', async () => {
    // The shape of the four failed composes: a table phase, briefs full of
    // {{field.…}}, and no columns anywhere.
    const noTable = {
        columns: [],
        title: 'Invoices',
        phases: [
            { kind: 'table', label: 'Table' },
            { kind: 'automation', label: 'Read', brief: '## Build an automation\n1. `data_extraction` with {{field.invoice_date}} (date), {{field.supplier}} (string), {{field.total_amount}} (number), {{field.status}}\n2. `datatable add_row` into **{{table.name}}** (id `{{table.id}}`)' },
            { kind: 'fill', label: 'First rows' },
            { kind: 'app', label: 'App', brief: '## Build an app on {{table.name}} with {{field.file_path}}' },
        ],
    };
    const stubborn = fakeDeps([noTable, noTable]);
    const lines = [];
    let out;
    const warned = await withWarnings(async () => { out = await composeRecipe({ description: 'd', locale: 'en' }, stubborn); });
    lines.push(...warned);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(stubborn.calls.length, 2, 'the model was asked once to declare them');
    assert.match(stubborn.calls[1].messages.at(-1).content, /Add a top-level `columns` array .* — the briefs reference: invoice_date, supplier, total_amount, status, file_path/);
    assert.ok(out.warnings.includes('table_synthesized'), JSON.stringify(out.warnings));
    assert.ok(out.recipe.warnings.includes('table_synthesized'), 'the document says so too');
    assert.deepEqual(out.recipe.table.fields.map((f) => [f.key, f.name, f.type, f.required]), [
        ['invoice_date', 'Invoice date', 'date', true],
        ['supplier', 'Supplier', 'text', true],
        ['total_amount', 'Total amount', 'number', true],
        ['status', 'Status', 'text', false],
        ['file_path', 'File path', 'text', false],
    ]);
    assert.deepEqual(out.recipe.phases.map((p) => p.kind), ['table', 'automation', 'fill', 'design', 'app']);
    assert.ok(!lines.some((l) => /compose invalid/.test(l)), 'a synthesized table is not a failure');

    // A first draft without columns whose repair declares them: no synthesis,
    // and no warning — the model's own schema is the one that runs.
    const repaired = { ...noTable, columns: [{ key: 'invoice_date', name: 'Invoice date', type: 'date' }, { key: 'supplier', name: 'Supplier', type: 'text' }, { key: 'total_amount', name: 'Total', type: 'number' }, { key: 'status', name: 'Status', type: 'text' }, { key: 'file_path', name: 'File', type: 'text' }] };
    const fixed = await composeRecipe({ description: 'd', locale: 'en' }, fakeDeps([noTable, repaired]));
    assert.equal(fixed.ok, true, JSON.stringify(fixed));
    assert.ok(!fixed.warnings.includes('table_synthesized'));
    assert.equal(fixed.recipe.table.fields[2].name, 'Total');

    // Never on the first pass: a runnable-but-for-the-table first draft still
    // costs the repair round (calls = 2), it is not silently patched (calls = 1).
    const once = fakeDeps([noTable, repaired]);
    await composeRecipe({ description: 'd', locale: 'en' }, once);
    assert.equal(once.calls.length, 2);

    // And a document broken for OTHER reasons is not patched with a table —
    // a missing brief is not a table problem.
    const briefless = { columns: [], title: 'x', phases: [{ kind: 'table', label: 'T' }, { kind: 'automation', label: 'R' }] };
    const refused = await composeRecipe({ description: 'd' }, fakeDeps([briefless, briefless]));
    assert.equal(refused.code, 'recipe_invalid');
    assert.equal(refused.recipe.table, null);
});

test('the compose-invalid line says whether the answer was cut off, garbled, and what the table phase carried', async () => {
    const inPhase = { title: 'x', phases: [{ kind: 'automation', label: 'R' }, { kind: 'table', label: 'T', columns: 'not a list', extra: 1 }] };
    let lines;
    // Stopped at the cap with the JSON complete: whole, so judged as a
    // document (a cut-off one is compose_truncated, its own line).
    lines = await withWarnings(async () => { await composeRecipe({ description: 'd' }, fakeDeps([{ structured: inPhase, stopReason: 'length', rawArguments: JSON.stringify(inPhase) }, inPhase])); });
    const line = lines.find((l) => /compose invalid/.test(l));
    assert.ok(line, lines.join('\n'));
    assert.match(line, /brief_required/);
    assert.match(line, /columns=undefined/);
    assert.match(line, /tablePhase=\{kind, label, columns, extra\}/);
    assert.match(line, /round=1, stop=length, repair=discarded/, 'the document described is the first draft — the repair was no better');
    assert.match(line, /garbled=false/);
    // The chopped-string signature is named, and the brief warning is a
    // warning: the document still runs.
    const garbled = { ...GOOD, phases: [{ kind: 'automation', label: 'R', brief: 'Build into {{table.name}} with type "text}}},systemPrompt:" and {{field.naam}}' }, GOOD.phases[1]] };
    let out;
    lines = await withWarnings(async () => { out = await composeRecipe({ description: 'd' }, fakeDeps([garbled])); });
    assert.equal(out.ok, true);
    assert.ok(out.warnings.includes('brief_garbled'), JSON.stringify(out.warnings));
    assert.ok(lines.some((l) => /compose brief_garbled: phases\[1\]\.brief/.test(l)), lines.join('\n'));
});

test('PLAYBOOK_COMPOSE_EFFORT is a measured experiment: off by default, and only then does a budget go along', async () => {
    const env = { effort: process.env.PLAYBOOK_COMPOSE_EFFORT, budget: process.env.PLAYBOOK_COMPOSE_BUDGET_TOKENS };
    const restore = () => {
        if (env.effort === undefined) delete process.env.PLAYBOOK_COMPOSE_EFFORT; else process.env.PLAYBOOK_COMPOSE_EFFORT = env.effort;
        if (env.budget === undefined) delete process.env.PLAYBOOK_COMPOSE_BUDGET_TOKENS; else process.env.PLAYBOOK_COMPOSE_BUDGET_TOKENS = env.budget;
    };
    try {
        delete process.env.PLAYBOOK_COMPOSE_EFFORT;
        delete process.env.PLAYBOOK_COMPOSE_BUDGET_TOKENS;
        const off = fakeDeps([GOOD]);
        await composeRecipe({ description: 'd' }, off);
        assert.equal(off.calls[0].opts.reasoningEffort, 'none');
        assert.equal(off.calls[0].opts.budgetTokens, 0, 'an explicit 0 is what every adapter reads as "no thinking"');
        assert.equal(off.calls[0].opts.maxTokens, 6000);
        assert.equal(off.calls[0].opts.timeoutMs, C.MODEL_BUDGET_MS);

        process.env.PLAYBOOK_COMPOSE_EFFORT = 'medium';
        const on = fakeDeps([GOOD]);
        await composeRecipe({ description: 'd' }, on);
        assert.equal(on.calls[0].opts.reasoningEffort, 'medium');
        assert.equal(on.calls[0].opts.budgetTokens, 1024);

        process.env.PLAYBOOK_COMPOSE_BUDGET_TOKENS = '2048';
        const sized = fakeDeps([GOOD]);
        await composeRecipe({ description: 'd' }, sized);
        assert.equal(sized.calls[0].opts.budgetTokens, 2048);

        // 'none' spelled explicitly, in any case, is still off — and no budget.
        process.env.PLAYBOOK_COMPOSE_EFFORT = 'None';
        const explicit = fakeDeps([GOOD]);
        await composeRecipe({ description: 'd' }, explicit);
        assert.equal(explicit.calls[0].opts.reasoningEffort, 'none');
        assert.equal(explicit.calls[0].opts.budgetTokens, 0);
    } finally { restore(); }
});

test('"only a dashboard" reaches the composer as a binding SCREENS line; a description that says nothing about screens adds nothing', async () => {
    const deps = fakeDeps([GOOD]);
    await composeRecipe({ description: 'Read the invoices in /Invoices into a table. In the app I want only a data insight dashboard.', locale: 'en' }, deps);
    const user = deps.calls[0].messages[1].content;
    assert.match(user, /\n\nSCREENS \(binding, from the person's own words "only a data insight dashboard"\): exactly ONE screen[^\n]*\. Write the app brief with exactly those "### Screen" headings and say so in the design phase's goal\.\n\nReturn the playbook now/);
    const plain = fakeDeps([GOOD]);
    await composeRecipe({ description: 'Lees leverancierslijsten in', locale: 'nl' }, plain);
    assert.doesNotMatch(plain.calls[0].messages[1].content, /SCREENS \(binding/);
});

// The 502 carried the provider's own words -- `The model could not be
// reached: ${e.message}` -- to the person composing: an internal host and
// port, a provider's request id, whatever a proxy put in its error page. The
// client gets a fixed sentence now and a correlation id; the operator's log
// gets the error under that same id, the way core/http/terminalErrorHandler
// ties the two together.
test('a model that cannot be reached is a fixed sentence and a correlation id; the error itself goes to the log under that id', async () => {
    const { runWithRequestId } = require('../telemetry/log');
    const leak = 'connect ECONNREFUSED 10.20.30.40:8080 (upstream llama-box-3, x-request-id 9f8e)';
    const dead = { resolveModel: async () => 'local-model', chatForcedTool: async () => { throw new Error(leak); } };
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    let out;
    try {
        out = await runWithRequestId('req-4711', () => composeRecipe({ description: 'd' }, dead));
    } finally { console.error = orig; }
    assert.equal(out.ok, false);
    assert.equal(out.code, 'compose_failed');
    assert.equal(out.status, 502);
    assert.equal(out.error, 'The model could not be reached. Try again in a moment.');
    assert.doesNotMatch(JSON.stringify(out), /10\.20\.30\.40|ECONNREFUSED|llama-box/);
    assert.equal(out.correlationId, 'req-4711', 'the request\'s own id, the one on its X-Request-Id header');
    const logged = lines.find((l) => l.includes('correlationId=req-4711'));
    assert.ok(logged, `logged under the id: ${JSON.stringify(lines)}`);
    assert.match(logged, /ECONNREFUSED 10\.20\.30\.40:8080/, 'the operator still reads what happened');
    assert.match(logged, /local-model/);

    // Outside a request (a script, a test) there is still an id to quote.
    console.error = () => {};
    try {
        const bare = await composeRecipe({ description: 'd' }, dead);
        assert.match(bare.correlationId, /^[0-9a-f-]{36}$/);
    } finally { console.error = orig; }
});
