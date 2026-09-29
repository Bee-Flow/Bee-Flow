'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseGemmaArgs,
    extractLeakedToolCalls,
    recoverLeakedToolCalls,
    hasLeakedToolCallSyntax,
    RECOVERED_CALL_HINT,
} = require('./leakedToolCalls');

// Verbatim trace, 2026-09-13, App Studio builder on Gemma 4 26B-A4B (Fast
// tier, thinking off): the whole of round 4's "thinking", as the owner's
// screenshot showed it before markdown ate the underscores. No content, no
// tool call, stop='stop'.
const GEMMA_TRACE = '<|tool_call>call:app_upsert_table{fields:[{key:<|">name<|">,type:<|">text<|">},{key:<|">email<|">,type:<|">text<|">},{key:<|">category<|">,type:<|">select<|">,options:[{label:<|">Services<|">,value:<|">services<|">},{label:<|">Hardware<|">,value:<|">hardware<|">},{label:<|">Software<|">,value:<|">software<|">},{label:<|">Logistics<|">,value:<|">logistics<|">}]},{key:<|">contact_person<|">,type:<|">text<|">}],name:<|">suppliers<|">}<tool_call|>';

const MENU = new Set(['app_upsert_table', 'app_add_components', 'app_set_meta', 'builder_add_steps']);

test('parseGemmaArgs: the measured trace parses to the exact arguments the model meant', () => {
    const inner = GEMMA_TRACE.slice('<|tool_call>call:app_upsert_table'.length, -'<tool_call|>'.length);
    const args = parseGemmaArgs(inner);
    assert.deepEqual(args, {
        fields: [
            { key: 'name', type: 'text' },
            { key: 'email', type: 'text' },
            {
                key: 'category', type: 'select',
                options: [
                    { label: 'Services', value: 'services' },
                    { label: 'Hardware', value: 'hardware' },
                    { label: 'Software', value: 'software' },
                    { label: 'Logistics', value: 'logistics' },
                ],
            },
            { key: 'contact_person', type: 'text' },
        ],
        name: 'suppliers',
    });
});

test('parseGemmaArgs: fenced keys, plain JSON quotes, numbers, booleans, a trailing comma and quotes inside a value all parse', () => {
    assert.deepEqual(parseGemmaArgs('{<|">name<|">:<|">Invoice "Q3"<|">,limit:5,active:true,}'), { name: 'Invoice "Q3"', limit: 5, active: true });
    assert.deepEqual(parseGemmaArgs('{"name":"x","props":{"span":12}}'), { name: 'x', props: { span: 12 } });
    assert.deepEqual(parseGemmaArgs(''), {});
    assert.deepEqual(parseGemmaArgs('{}'), {});
});

test('parseGemmaArgs: a bare identifier value is the string the model meant (2026-09-17: four app_update_component calls in one live round were refused as unparsable for exactly `{mode:read}`)', () => {
    // Until 2026-09-17 this was "null, never a guess". The live round showed
    // the opposite: the unquoted word IS the value, the model has no other
    // spelling in mind, and the tool's own schema validates it afterwards.
    assert.deepEqual(parseGemmaArgs('{mode:read}'), { mode: 'read' });
    assert.deepEqual(parseGemmaArgs('{kind:formula,expr:screen.params.id,n:-3}'), { kind: 'formula', expr: 'screen.params.id', n: -3 });
    // The literals stay literals, and a key may be bare, fenced or quoted.
    assert.deepEqual(parseGemmaArgs('{true:true,<|">false<|">:false,"null":null}'), { true: true, false: false, null: null });
});

test('parseGemmaArgs: an unclosed fence or string, a dangling key, a cut scalar or an array root is null, never a guess', () => {
    assert.equal(parseGemmaArgs('{name:<|">suppliers}'), null);
    assert.equal(parseGemmaArgs('{name:"suppliers}'), null);
    assert.equal(parseGemmaArgs('{name:'), null);
    assert.equal(parseGemmaArgs('{name'), null);
    assert.equal(parseGemmaArgs('[1,2]'), null);
    assert.equal(parseGemmaArgs('{name:Invoice Tracker}'), null, 'two barewords in a row is not a value');
    assert.equal(parseGemmaArgs('{a:1,b:[1,2}'), null, 'a mismatched closer is garbage, not a cut');
    // A binding cut after its first scalar has lost the key that gives it
    // meaning — appStudio/builderTools/actionNormalise.parseGarbledBinding
    // relies on this null to refuse the step rather than write a half binding.
    assert.equal(parseGemmaArgs('{kind:"static"'), null);
    assert.equal(parseGemmaArgs('{"steps":[{"tempId":"a"'), null, 'the base.js invalid-args fixture stays invalid');
    assert.equal(parseGemmaArgs('{limit:1'), null, 'the number may itself be cut (10, 100, …)');
});

test('parseGemmaArgs: a tail cut right after a closer is closed in stack order — every element on the wire was complete', () => {
    assert.deepEqual(parseGemmaArgs('{steps:[{a:1},{b:2}'), { steps: [{ a: 1 }, { b: 2 }] });
    assert.deepEqual(parseGemmaArgs('{steps:[{a:1},{b:2},'), { steps: [{ a: 1 }, { b: 2 }] }, 'a comma after the closer keeps it closable');
    assert.deepEqual(parseGemmaArgs('{a:{b:[1,2,3]}'), { a: { b: [1, 2, 3] } });
    assert.deepEqual(parseGemmaArgs('{"components":[{"type":"card","children":[{"type":"text"}]}'), { components: [{ type: 'card', children: [{ type: 'text' }] }] });
    // Cut inside the next element: the opened container has nothing complete in it.
    assert.equal(parseGemmaArgs('{steps:[{a:1},{b:2},{'), null);
    assert.equal(parseGemmaArgs('{steps:[{a:1},{b:2},{c'), null);
});

test('parseGemmaArgs: a runaway nesting (a model looping on `[`) is null and never a RangeError — every caller promises not to throw', () => {
    // The reviewer's reproduction, 2026-09-18: a tool call whose arguments
    // are `{"steps":` + thousands of `[`, cut at finish_reason 'length'.
    // Before the depth ceiling this escaped parseGemmaArgs as a RangeError
    // and rejected the streaming adapter's [DONE] flush (base.js) and
    // chatForcedTool (llmClient) instead of yielding "does not parse".
    assert.equal(parseGemmaArgs('{"steps":' + '['.repeat(6000)), null);
    assert.equal(parseGemmaArgs('{a:' + '['.repeat(10000)), null);
    assert.equal(parseGemmaArgs('{a:' + '[['.repeat(100000)), null, 'a `[[` token halves the count — still null, still no throw');
    assert.equal(parseGemmaArgs('{a:' + '{b:'.repeat(8000)), null, 'objects count the same as arrays');
    // The ceiling is a nesting count, not a size: a long flat batch is fine,
    // and a deep-but-sane object (the deepest real call is under twenty)
    // parses whole or cut after a closer.
    const flat = '{rows:[' + Array.from({ length: 5000 }, (_, i) => `{n:${i}}`).join(',') + ']}';
    assert.equal(parseGemmaArgs(flat).rows.length, 5000);
    const nested = (d) => '{a:' + '['.repeat(d) + '1' + ']'.repeat(d) + '}';
    assert.deepEqual(parseGemmaArgs(nested(20)).a.length, 1);
    assert.equal(parseGemmaArgs(nested(255)).a.length, 1, '256 open containers is the last accepted depth');
    assert.equal(parseGemmaArgs(nested(256)), null, '257 is past the ceiling, closed or not');
    assert.equal(parseGemmaArgs('{a:' + '['.repeat(100) + '1' + ']'.repeat(100)).a.length, 1, 'cut after a closer at depth 101 still closes');
    // A leaked call with the same tail lands in `rejected`, not in a throw.
    const leaked = extractLeakedToolCalls('<|tool_call>call:app_add_components{components:' + '['.repeat(9000), { toolNames: new Set(['app_add_components']) });
    assert.deepEqual(leaked.calls, []);
    assert.equal(leaked.rejected.length, 1);
    assert.equal(leaked.rejected[0].reason, 'unparsable');
});

test('parseGemmaArgs: both fence spellings, and text after the first complete object is ignored', () => {
    // The template writes <|"|>, the measured transcripts <|"> — either closes either.
    assert.deepEqual(parseGemmaArgs('{name:<|"|>A<|"|>,label:<|">B<|">}'), { name: 'A', label: 'B' });
    assert.deepEqual(parseGemmaArgs('{name:<|"|>A<|">}'), { name: 'A' });
    // A fenced value keeps braces, quotes and {{templates}} verbatim.
    assert.deepEqual(
        parseGemmaArgs('{prompt:<|"|>Read {{table.id}} then {datatableId:"x"}<|"|>,n:-1.5e3}'),
        { prompt: 'Read {{table.id}} then {datatableId:"x"}', n: -1500 },
    );
    // A plain-quoted string keeps its punctuation and its escapes.
    assert.deepEqual(parseGemmaArgs('{title:"Total, x: 1", q:"say \\"hi\\""}'), { title: 'Total, x: 1', q: 'say "hi"' });
    // The close token, prose or the next call after the object is not the object's business.
    assert.deepEqual(parseGemmaArgs('{a:1}<tool_call|> and then I will add the screen.'), { a: 1 });
    assert.deepEqual(parseGemmaArgs('{a:1}{b:2}'), { a: 1 });
    // Nested arrays of objects with every scalar kind.
    assert.deepEqual(
        parseGemmaArgs('{rows:[{n:1,ok:true},{n:2.5,ok:false,x:null},[1,[2]]],empty:[],e:{}}'),
        { rows: [{ n: 1, ok: true }, { n: 2.5, ok: false, x: null }, [1, [2]]], empty: [], e: {} },
    );
});

// ─── The garbled shapes recorded in the builder traces ──────────────────────
// appStudio/builderTools/traces/2026-09-13-invoice-tracker.json and
// 2026-09-13-playbook-refusals.json carry the calls verbatim as the runtime
// handed them up: valid JSON with string values that swallowed structure
// (llama.cpp's PEG parser cuts a string at a brace inside an array —
// issue #21384). actionNormalise.parseGarbledBinding unescapes such a value
// and hands it here; these are those values.

test('parseGemmaArgs: the binding-as-a-string shapes from the traces parse back into their binding', () => {
    // invoice-tracker #4 app_set_action .actions[0].action.values.category —
    // an escaped binding followed by the tail of the entry it swallowed.
    const cat = '{kind:\\"field\\",name:\\"category\\",formId:\\"cmp_bslzxp\\"}`,email:'.replace(/\\+"/g, '"');
    assert.deepEqual(parseGemmaArgs(cat), { kind: 'field', name: 'category', formId: 'cmp_bslzxp' });
    // playbook-refusals #2 / #13 — recordId as a string, escaped and plain.
    assert.deepEqual(parseGemmaArgs('{kind:"formula",expr:"screen.params.recordId"}'), { kind: 'formula', expr: 'screen.params.recordId' });
    assert.deepEqual(parseGemmaArgs('{kind:"formula",expr:"screen.params.id"}'), { kind: 'formula', expr: 'screen.params.id' });
    // playbook-refusals #54 — a whole list source as a spaced, escaped JSON string.
    const source = '{ \\"kind\\": \\"list\\", \\"tableId\\": \\"tbl_52aad5\\", \\"filter\\": [ { \\"field\\": \\"status\\", \\"op\\": \\"eq\\", \\"value\\": \\"Wachtend\\" } ] }'.replace(/\\+"/g, '"');
    assert.deepEqual(parseGemmaArgs(source), { kind: 'list', tableId: 'tbl_52aad5', filter: [{ field: 'status', op: 'eq', value: 'Wachtend' }] });
    // playbook-refusals #51/#52 — sixty recordIds that were nothing but `{kind:`.
    assert.equal(parseGemmaArgs('{kind:'), null);
});

test('parseGemmaArgs: a value that swallowed the rest of its batch is valid input for a fenced string, so the caller must check looksGarbled', () => {
    // playbook-refusals #37-39 .updates[0].props.fields[7].type and fields[8].
    // These arrive as STRING VALUES inside otherwise valid JSON: the parser
    // is not where they are caught (core/llm/partialJsonScan.looksGarbled is).
    const { looksGarbled } = require('./partialJsonScan');
    const args = parseGemmaArgs('{updates:[{props:{fields:[{type:<|">text}]}}]}<tool_call|><|tool_call>call:app_set_action{action:{kind:<|">},<|">,steps:[{expiresInHours:168,kind:<|">]}}]}');
    assert.deepEqual(args, { updates: [{ props: { fields: [{ type: 'text}]}}]}<tool_call|><|tool_call>call:app_set_action{action:{kind:' }, ',steps:[{expiresInHours:168,kind:'] } }] });
    // This shape has neither `}}}` nor a `},key:` run (`}]}}]}` then a
    // control token), which looksGarbled used to miss; since 2026-09-17 the
    // wire markers themselves are part of its regex, so every consumer
    // (composeRecipe's brief_garbled, actionNormalise, addSteps) sees it —
    // and llmClient.extractForcedResult's wire-token check stays as the
    // independent second signal.
    assert.equal(looksGarbled(args), true);
    assert.equal(looksGarbled({ type: 'text}]}}]}' }), false, 'without the marker the closer run alone is not the signature');
    assert.equal(hasLeakedToolCallSyntax(JSON.stringify(args)), true);
    assert.equal(looksGarbled(parseGemmaArgs('{fn:<|">count}],kind:<|">}')), true);
    assert.equal(looksGarbled(parseGemmaArgs('{type:<|">card}],parentId:<|">}')), true);
    // The trace's honest prompt with {{loop.f.content}} lines is NOT garbled.
    assert.equal(looksGarbled(parseGemmaArgs('{prompt:<|">Datum: {{loop.f.content}}\nTotaal: {{loop.f.content}}<|">}')), false);
});

test('parseGemmaArgs: the invalid-JSON drops from the container log — a batch cut at max_tokens between entries is saved, one cut inside a string is not', () => {
    // "Dropping tool_use app_add_components: invalid JSON args (Unterminated
    // string … 19703)": cut mid-string, nothing to close honestly.
    assert.equal(parseGemmaArgs('{"components":[{"type":"card","props":{"title":"Overzicht van de fact'), null);
    // "Dropping tool_use builder_set_plan: invalid JSON args (… position 125)":
    // a plan whose last item closed before the cut is a plan.
    assert.deepEqual(
        parseGemmaArgs('{"items":[{"id":"p1","label":"Tabel aanmaken"},{"id":"p2","label":"Routine bouwen"}'),
        { items: [{ id: 'p1', label: 'Tabel aanmaken' }, { id: 'p2', label: 'Routine bouwen' }] },
    );
});

test('extractLeakedToolCalls: Gemma syntax → one call, the surrounding reasoning kept as text', () => {
    const text = `I need a suppliers table first.\n${GEMMA_TRACE}\nThen the invoices table.`;
    const out = extractLeakedToolCalls(text, { toolNames: MENU });
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0].name, 'app_upsert_table');
    assert.equal(out.calls[0].format, 'gemma');
    assert.equal(out.calls[0].args.name, 'suppliers');
    assert.equal(out.calls[0].args.fields.length, 4);
    assert.deepEqual(out.rejected, []);
    assert.equal(out.text, 'I need a suppliers table first.\n\nThen the invoices table.');
});

test('extractLeakedToolCalls: a call cut off before its close token is still read when its braces are complete', () => {
    const text = '<|tool_call>call:app_set_meta{name:<|">Invoice Tracker<|">}';
    const out = extractLeakedToolCalls(text, { toolNames: MENU });
    assert.equal(out.calls.length, 1);
    assert.deepEqual(out.calls[0].args, { name: 'Invoice Tracker' });
    assert.equal(out.text, '');
});

test('extractLeakedToolCalls: two calls in one text come back in order', () => {
    const text = '<|tool_call>call:app_set_meta{name:<|">A<|">}<tool_call|><|tool_call>call:app_upsert_table{name:<|">t<|">,fields:[]}<tool_call|>';
    const out = extractLeakedToolCalls(text, { toolNames: MENU });
    assert.deepEqual(out.calls.map((c) => c.name), ['app_set_meta', 'app_upsert_table']);
});

test('extractLeakedToolCalls: Hermes/Qwen <tool_call> JSON, with arguments as an object or a JSON string', () => {
    const a = extractLeakedToolCalls('<tool_call>\n{"name": "app_set_meta", "arguments": {"name": "X"}}\n</tool_call>', { toolNames: MENU });
    assert.deepEqual(a.calls.map((c) => [c.name, c.args, c.format]), [['app_set_meta', { name: 'X' }, 'hermes']]);
    const b = extractLeakedToolCalls('<tool_call>{"name":"app_set_meta","arguments":"{\\"name\\":\\"Y\\"}"}</tool_call>', { toolNames: MENU });
    assert.deepEqual(b.calls[0].args, { name: 'Y' });
});

test('extractLeakedToolCalls: a reply that IS one call object is a call; ordinary JSON in prose is not', () => {
    const a = extractLeakedToolCalls('{"name":"app_set_meta","arguments":{"name":"Z"}}', { toolNames: MENU });
    assert.equal(a.calls.length, 1);
    assert.equal(a.calls[0].format, 'json');
    assert.equal(a.text, '');
    const b = extractLeakedToolCalls('Here is the shape: {"name":"app_set_meta","arguments":{}} — shall I?', { toolNames: MENU });
    assert.equal(b.calls.length, 0);
    assert.equal(b.text, 'Here is the shape: {"name":"app_set_meta","arguments":{}} — shall I?');
});

test('extractLeakedToolCalls: a name off the menu or arguments that do not parse are reported, not run', () => {
    // `{name:oops}` used to be the unparsable fixture; a bare word is a string
    // now (see the parseGemmaArgs tests), so the broken call is an unclosed fence.
    const out = extractLeakedToolCalls(
        '<|tool_call>call:app_make_table{name:<|">x<|">}<tool_call|><|tool_call>call:app_set_meta{name:<|">oops}<tool_call|>',
        { toolNames: MENU },
    );
    assert.equal(out.calls.length, 0);
    assert.deepEqual(out.rejected.map((r) => [r.name, r.reason]), [['app_make_table', 'unknown_tool'], ['app_set_meta', 'unparsable']]);
});

test('extractLeakedToolCalls: without a menu every well-formed name is accepted', () => {
    const out = extractLeakedToolCalls('<|tool_call>call:anything_goes{a:1}<tool_call|>');
    assert.deepEqual(out.calls.map((c) => [c.name, c.args]), [['anything_goes', { a: 1 }]]);
});

test('hasLeakedToolCallSyntax: only the two wire syntaxes count', () => {
    assert.equal(hasLeakedToolCallSyntax(GEMMA_TRACE), true);
    assert.equal(hasLeakedToolCallSyntax('<tool_call>{}</tool_call>'), true);
    assert.equal(hasLeakedToolCallSyntax('I will call app_upsert_table next.'), false);
    assert.equal(hasLeakedToolCallSyntax(null), false);
});

test('recoverLeakedToolCalls: the measured round — call in an unsigned thinking part, no content — becomes a tool call the loop can run', () => {
    const response = { content: null, toolCalls: null, thinkingParts: [{ id: 's1-t0', text: GEMMA_TRACE, signature: null, redacted: false }], finishReason: 'stop' };
    const out = recoverLeakedToolCalls(response, { toolNames: MENU, iter: 4 });
    assert.equal(out.toolCalls.length, 1);
    const tc = out.toolCalls[0];
    assert.equal(tc.id, 'leak_4_0');
    assert.equal(tc.type, 'function');
    assert.equal(tc.function.name, 'app_upsert_table');
    assert.equal(JSON.parse(tc.function.arguments).name, 'suppliers');
    assert.equal(tc._recovered, true);
    assert.equal(tc._recoveredFrom, 'thinking');
    assert.deepEqual(out.sources, ['thinking']);
    assert.equal(out.content, null);
    assert.deepEqual(out.rejected, []);
});

test('recoverLeakedToolCalls: a call in the content is removed from the content the transcript keeps', () => {
    const response = { content: `Adding the table now.\n${GEMMA_TRACE}`, thinkingParts: [] };
    const out = recoverLeakedToolCalls(response, { toolNames: MENU, iter: 1 });
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.content, 'Adding the table now.');
    assert.deepEqual(out.sources, ['content']);
});

test('recoverLeakedToolCalls: signed (Anthropic) and redacted thinking is never read; a normal round is untouched', () => {
    const signed = { content: 'Done.', thinkingParts: [{ text: GEMMA_TRACE, signature: 'sig' }, { text: GEMMA_TRACE, redacted: true }] };
    const a = recoverLeakedToolCalls(signed, { toolNames: MENU });
    assert.equal(a.toolCalls.length, 0);
    assert.equal(a.content, 'Done.');
    const plain = { content: 'All set — the app has two tables.', thinkingParts: [{ text: 'Let me check the plan.' }] };
    const b = recoverLeakedToolCalls(plain, { toolNames: MENU });
    assert.equal(b.toolCalls.length, 0);
    assert.equal(b.content, plain.content);
    assert.deepEqual(b.sources, []);
});

test('recoverLeakedToolCalls: an unknown name in the thinking lands in rejected with its source, and never a tool call — and the raw span is logged so the next fix has a fixture', (t) => {
    const warned = [];
    t.mock.method(console, 'warn', (line) => warned.push(String(line)));
    const response = { content: null, thinkingParts: [{ text: '<|tool_call>call:app_make_table{name:<|">x<|">}<tool_call|>' }] };
    const out = recoverLeakedToolCalls(response, { toolNames: MENU });
    assert.equal(out.toolCalls.length, 0);
    assert.deepEqual(out.rejected.map((r) => [r.name, r.reason, r.source]), [['app_make_table', 'unknown_tool', 'thinking']]);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /app_make_table:unknown_tool in thinking/);
    assert.match(warned[0], /call:app_make_table\{name:/);
    // An unparsable call is logged the same way, with its raw span capped at 300 chars.
    warned.length = 0;
    const long = `<|tool_call>call:app_set_meta{name:<|">${'x'.repeat(500)}}<tool_call|>`;
    recoverLeakedToolCalls({ content: long, thinkingParts: [] }, { toolNames: MENU });
    assert.equal(warned.length, 1);
    assert.match(warned[0], /app_set_meta:unparsable in content/);
    assert.ok(warned[0].length < 420, `capped: ${warned[0].length}`);
});

test('the hint the model reads back states the rule — and never spells a control token into the transcript', () => {
    assert.match(RECOVERED_CALL_HINT, /written as TEXT/);
    assert.match(RECOVERED_CALL_HINT, /ONLY as function calls/);
    // llama-server tokenises message text with special tokens on: a literal
    // marker in a tool result would reach the model as the real token.
    assert.doesNotMatch(RECOVERED_CALL_HINT, /<\|?tool_call/);
});
