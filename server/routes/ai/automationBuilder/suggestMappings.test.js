/**
 * POST /suggest-mappings (suggestMappings.js): the AI fallback of Auto-map.
 *
 * What is pinned here is what makes it safe to put a model's answer on the
 * canvas without the author checking every field:
 *   - the model sees canonical paths over deep JSON (name/value lists by
 *     name, JSON text read through), short values, no addresses, no secrets;
 *   - every proposal is resolved against the samples with the runtime's own
 *     path grammar and engine, and dropped with a reason when it does not;
 *   - what survives renders as pills: a field, text with fields, or one
 *     transform of one field — anything else is downgraded or dropped;
 *   - the value fits the input's type.
 * The model, the gates and the rate limit are injected; nothing here reaches
 * the module system or the network.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/suggestMappings.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../../core/http/routeHarness');
const {
    makeSuggestMappingsRouter, normaliseSuggestRequest, buildSuggestPrompt, verifySuggestions,
    suggestMappings, pairNameKey, SuggestMappingsBody, SUGGEST_MAPPINGS_TOOL,
} = require('./suggestMappings');

// ── A Microsoft Graph "list messages" answer, nested the way Graph nests it ──
const GRAPH_MAIL = {
    '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('me')/messages",
    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=10',
    value: [
        {
            id: 'AAMkAGI2TAAA=',
            subject: 'Invoice 2026-031 for March',
            receivedDateTime: '2026-03-04T09:12:00Z',
            hasAttachments: true,
            importance: 'high',
            isRead: false,
            from: { emailAddress: { name: 'Jan de Vries', address: 'jan@contoso.nl' } },
            toRecipients: [
                { emailAddress: { name: 'Finance', address: 'finance@fabrikam.nl' } },
                { emailAddress: { name: 'Bob', address: 'bob@fabrikam.nl' } },
            ],
            body: { contentType: 'html', content: '<p>Hi, the invoice is attached. Questions? Mail jan@contoso.nl</p>' },
            internetMessageHeaders: [
                { name: 'Message-ID', value: '<CAF123@contoso.nl>' },
                { name: 'X-Priority', value: '1' },
                { name: 'Subject', value: 'Invoice 2026-031 for March' },
            ],
            attachments: [{ id: 'att1', name: 'invoice-031.pdf', contentType: 'application/pdf', size: 48213 }],
            extensions: { apiToken: 'sk-DO-NOT-SHOW' },
        },
        {
            id: 'AAMkAGI2TBBB=',
            subject: 'Lunch?',
            receivedDateTime: '2026-03-04T11:00:00Z',
            hasAttachments: false,
            importance: 'normal',
            isRead: true,
            from: { emailAddress: { name: 'Bob', address: 'bob@fabrikam.nl' } },
            toRecipients: [],
            categories: ['Personal'],
        },
    ],
};

const MAIL_SOURCE = { root: 'steps.g1.output', label: 'Get mail', real: true, sample: GRAPH_MAIL };
const ITEM_SOURCE = { root: 'loop.item', label: 'Current item (loop.item)', real: true, sample: GRAPH_MAIL.value[0] };
const HTTP_SOURCE = {
    root: 'steps.h1.output', label: 'Call API', real: true,
    sample: { status: 200, body: '```json\n{"data":{"items":[{"id":"inv_9","amount":"1250.50","paid":false}]}}\n```' },
};

const PARAMS = [
    { key: 'title', type: 'string', required: true, description: 'Task title' },
    { key: 'assigneeEmail', type: 'string', format: 'email', required: true },
    { key: 'dueDate', type: 'string', format: 'date-time' },
    { key: 'priority', type: 'string', enum: ['low', 'normal', 'high'] },
    { key: 'amount', type: 'number' },
    { key: 'recipients', type: 'string', description: 'Comma-separated addresses' },
    { key: 'urgent', type: 'boolean' },
    { key: 'labels', type: 'array', itemsType: 'string' },
    { key: 'notes', type: 'string' },
    { key: 'messageRef', type: 'string' },
];

const input = (sources = [MAIL_SOURCE], params = PARAMS) => normaliseSuggestRequest(SuggestMappingsBody.parse({ params, sources }));
const verify = (bindings, sources = [MAIL_SOURCE], params = PARAMS) => verifySuggestions(bindings, input(sources, params));
const byKey = (out) => Object.fromEntries(out.suggestions.map((s) => [s.key, s]));
const rejectedKey = (out, key) => out.rejected.find((r) => r.key === key);

// ── What the model sees ─────────────────────────────────────────────────────

test('the model gets canonical full paths over deep JSON, short values, no addresses and no secrets', () => {
    const { messages } = buildSuggestPrompt(input([MAIL_SOURCE, HTTP_SOURCE]));
    const user = messages[1].content;
    // Keys that are not identifiers are quoted the way the runtime reads them.
    assert.match(user, /steps\.g1\.output\["@odata\.nextLink"\]/);
    // Deep leaves are offered, element by element, with full paths.
    assert.match(user, /steps\.g1\.output\.value\[0\]\.from\.emailAddress\.address {2}\(email\) = "<email>"/);
    assert.match(user, /steps\.g1\.output\.value\[0\]\.toRecipients\[0\]\.emailAddress\.address/);
    // A key only the second element has is still offered, from that element.
    assert.match(user, /steps\.g1\.output\.value\[1\]\.categories {2}\(list of 1 texts\)/);
    // A name/value list is offered by name, as one field.
    assert.match(user, /steps\.g1\.output\.value\[0\]\.internetMessageHeaders\[name="Subject"\]\.value {2}\(text\) = "Invoice 2026-031 for March"/);
    assert.doesNotMatch(user, /internetMessageHeaders\[2\]/);
    // JSON text (even ```json fenced) is read through with the same paths.
    assert.match(user, /steps\.h1\.output\.body {2}\(JSON text, read with plain paths: group, 1 field\)/);
    assert.match(user, /steps\.h1\.output\.body\.data\.items\[0\]\.amount {2}\(text\) = "1250\.50"/);
    // Nothing personal or secret travels verbatim.
    assert.doesNotMatch(user, /jan@contoso\.nl|finance@fabrikam\.nl|bob@fabrikam\.nl/);
    assert.doesNotMatch(user, /sk-DO-NOT-SHOW/);
    assert.match(user, /extensions\.apiToken {2}\(hidden\)/);
    // The nearest step comes first, and the inputs are listed with their type.
    assert.ok(user.indexOf('root steps.h1.output') < user.indexOf('root steps.g1.output'));
    assert.match(user, /- "assigneeEmail" \(e-mail address, required\)/);
    assert.match(user, /- "priority" \(one of: "low", "normal", "high"\)/);
});

// The fixture of shared/expr/path.test.mjs: an HTTP body (text) holding a
// payload (text) holding list items whose meta is text again, down to a
// ```json fenced AI answer.
const LVL3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
const LVL2 = JSON.stringify({ items: [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: LVL3 }) }, { sku: 'B2', meta: '{"tags":["z"]}' }] });
const NESTED_SOURCE = { root: 'steps.http.output', label: 'Call API', real: true, sample: { body: JSON.stringify({ data: { payload: LVL2 } }) } };
const BASE = 'steps.http.output.body.data.payload';

test('JSON text inside JSON text is shown to the model as structure, every level, with plain paths', () => {
    const { messages } = buildSuggestPrompt(input([NESTED_SOURCE]));
    const user = messages[1].content;
    assert.match(user, /steps\.http\.output\.body {2}\(JSON text, read with plain paths: group, 1 field\)/);
    assert.ok(user.includes(`${BASE}.items[0].meta.ai.verdict.score  (number) = 0.93`), 'three levels of JSON text down, fenced at the last');
    assert.match(user, /payload\.items\[0\]\.meta\.ai\.verdict\["reason code"\] {2}\(text\) = "R-7"/);
    assert.ok(user.includes(`${BASE}.items[0].meta.tags  (list of 2 texts) = ["x", "y"]`));
    // No escaped JSON reaches the model.
    assert.doesNotMatch(user, /\\"/);
    assert.match(messages[0].content, /JSON text inside JSON text\) is read with plain paths straight through every level/);
});

test('paths straight through nested JSON text verify, as ref, template and transform', () => {
    const params = [
        { key: 'sku', type: 'string' },
        { key: 'score', type: 'number' },
        { key: 'reasonCode', type: 'string' },
        { key: 'tags', type: 'string' },
        { key: 'summary', type: 'string' },
        { key: 'lastTag', type: 'string' },
    ];
    const out = verify([
        { key: 'sku', kind: 'ref', path: `${BASE}.items[0].sku` },
        { key: 'score', kind: 'ref', path: `${BASE}.items[0].meta.ai.verdict.score` },
        { key: 'reasonCode', kind: 'ref', path: `${BASE}.items[0].meta.ai.verdict['reason code']` },
        { key: 'tags', kind: 'ref', path: `${BASE}.items[*].meta.tags` },
        { key: 'summary', kind: 'template', value: `{{${BASE}.items[sku="B2"].sku}}: {{${BASE}.items[sku="B2"].meta.tags[0]}}` },
        { key: 'lastTag', kind: 'expr', value: `upper(${BASE}.items[0].meta.tags[-1])` },
    ], [NESTED_SOURCE], params);
    assert.deepStrictEqual(out.rejected, []);
    const s = byKey(out);
    assert.strictEqual(s.sku.sampleValue, 'A1');
    assert.strictEqual(s.score.sampleValue, '0.93');
    assert.deepStrictEqual(s.reasonCode.binding, { kind: 'ref', path: `${BASE}.items[0].meta.ai.verdict["reason code"]` });
    assert.strictEqual(s.reasonCode.sampleValue, 'R-7');
    assert.deepStrictEqual(s.tags.binding, { kind: 'expr', value: `join(${BASE}.items[*].meta.tags, ", ")` });
    assert.strictEqual(s.tags.sampleValue, 'x, y, z');
    assert.strictEqual(s.summary.sampleValue, 'B2: z');
    assert.strictEqual(s.lastTag.sampleValue, 'Y');
});

test('long text is cut short before it reaches the model', () => {
    const long = { root: 'trigger.output', sample: { note: 'x'.repeat(5000) } };
    const { messages } = buildSuggestPrompt(input([long]));
    const line = messages[1].content.split('\n').find((l) => l.includes('trigger.output.note'));
    assert.ok(line.length < 200, line);
});

test('a name/value list is recognised by its value key, a list of files is not', () => {
    assert.strictEqual(pairNameKey([{ name: 'Subject', value: 'a' }, { name: 'From', value: 'b' }]), 'name');
    assert.strictEqual(pairNameKey([{ name: 'a.pdf', url: 'u1' }, { name: 'b.pdf', url: 'u2' }]), null);
    assert.strictEqual(pairNameKey([{ name: 'Subject', value: 'a' }]), null, 'one entry is not a list of pairs');
});

test('the tool lets the model answer only ref, template or expr', () => {
    const item = SUGGEST_MAPPINGS_TOOL.function.parameters.properties.bindings.items;
    assert.deepStrictEqual(item.properties.kind.enum, ['ref', 'template', 'expr']);
    assert.deepStrictEqual(item.required, ['key', 'kind', 'reason']);
});

// ── Verification: paths ─────────────────────────────────────────────────────

test('a ref is resolved on the sample and comes back in canonical spelling', () => {
    const out = verify([
        { key: 'title', kind: 'ref', path: 'steps.g1.output.value.0.subject', reason: 'The subject' },
        { key: 'assigneeEmail', kind: 'ref', path: '{{ steps.g1.output.value[0].from.emailAddress.address }}', reason: 'The sender' },
    ]);
    const s = byKey(out);
    assert.deepStrictEqual(s.title.binding, { kind: 'ref', path: 'steps.g1.output.value[0].subject' });
    assert.strictEqual(s.title.sampleValue, 'Invoice 2026-031 for March');
    assert.strictEqual(s.title.reason, 'The subject');
    assert.deepStrictEqual(s.assigneeEmail.binding, { kind: 'ref', path: 'steps.g1.output.value[0].from.emailAddress.address' });
    assert.deepStrictEqual(out.rejected, []);
});

test('a path that is not in the data, or not from a step above, is dropped with a reason', () => {
    const out = verify([
        { key: 'title', kind: 'ref', path: 'steps.g1.output.value[0].subjekt', reason: '' },
        { key: 'notes', kind: 'ref', path: 'steps.other.output.text', reason: '' },
        { key: 'messageRef', kind: 'ref', path: 'secrets.apiKey', reason: '' },
    ]);
    assert.deepStrictEqual(out.suggestions, []);
    assert.match(rejectedKey(out, 'title').reason, /not in the data of "Get mail"/);
    assert.match(rejectedKey(out, 'notes').reason, /does not start at one of the steps above/);
    assert.match(rejectedKey(out, 'messageRef').reason, /not in the data of the steps above/);
});

test('a path written relative to the only source that holds it gets its root', () => {
    const out = verify([{ key: 'title', kind: 'ref', path: 'value[0].subject', reason: '' }]);
    assert.deepStrictEqual(byKey(out).title.binding, { kind: 'ref', path: 'steps.g1.output.value[0].subject' });
});

test('a name/value entry picked by name resolves (case-insensitively) and stays one field', () => {
    const out = verify([{ key: 'messageRef', kind: 'ref', path: "steps.g1.output.value[0].internetMessageHeaders[name='message-id'].value", reason: '' }]);
    assert.deepStrictEqual(byKey(out).messageRef.binding, { kind: 'ref', path: 'steps.g1.output.value[0].internetMessageHeaders[name="message-id"].value' });
    assert.strictEqual(byKey(out).messageRef.sampleValue, '<CAF123@contoso.nl>');
});

test('fields inside JSON text (an HTTP body, fenced) resolve with plain paths', () => {
    const out = verify([{ key: 'notes', kind: 'ref', path: 'steps.h1.output.body.data.items[0].id', reason: '' }], [HTTP_SOURCE]);
    assert.deepStrictEqual(byKey(out).notes.binding, { kind: 'ref', path: 'steps.h1.output.body.data.items[0].id' });
});

test('while the step runs per mail, [0] of that mail list becomes the current mail', () => {
    const out = verify(
        [{ key: 'title', kind: 'ref', path: 'steps.g1.output.value[0].subject', reason: '' }],
        [MAIL_SOURCE, ITEM_SOURCE],
    );
    assert.deepStrictEqual(byKey(out).title.binding, { kind: 'ref', path: 'loop.item.subject' });
});

// ── Verification: pill shapes ───────────────────────────────────────────────

test('a template of fields is kept, canonical; one lone placeholder is a ref', () => {
    const out = verify([
        { key: 'title', kind: 'template', value: ' Invoice from {{steps.g1.output.value[0].from.emailAddress.name}}: {{ steps.g1.output.value.0.subject }} ', reason: '' },
        { key: 'notes', kind: 'template', value: '{{steps.g1.output.value[0].body.content}}', reason: '' },
    ]);
    const s = byKey(out);
    assert.deepStrictEqual(s.title.binding, {
        kind: 'template',
        value: 'Invoice from {{steps.g1.output.value[0].from.emailAddress.name}}: {{steps.g1.output.value[0].subject}}',
    });
    assert.strictEqual(s.title.sampleValue, 'Invoice from Jan de Vries: Invoice 2026-031 for March');
    assert.deepStrictEqual(s.notes.binding, { kind: 'ref', path: 'steps.g1.output.value[0].body.content' });
});

test('{{ }} means text with fields whatever kind the model claimed', () => {
    const out = verify([
        { key: 'title', kind: 'ref', path: '{{steps.g1.output.value[0].subject}} ({{steps.g1.output.value[0].importance}})' },
        { key: 'notes', kind: 'expr', value: '{{ steps.g1.output.value[0].id }}' },
    ]);
    assert.deepStrictEqual(byKey(out).title.binding, { kind: 'template', value: '{{steps.g1.output.value[0].subject}} ({{steps.g1.output.value[0].importance}})' });
    assert.deepStrictEqual(byKey(out).notes.binding, { kind: 'ref', path: 'steps.g1.output.value[0].id' });
});

test('a formula inside text, fixed text, or a group inside text is dropped', () => {
    const out = verify([
        { key: 'title', kind: 'template', value: 'Re: {{upper(steps.g1.output.value[0].subject)}}', reason: '' },
        { key: 'notes', kind: 'template', value: 'Always this text', reason: '' },
        { key: 'messageRef', kind: 'template', value: 'From {{steps.g1.output.value[0].from}}', reason: '' },
    ]);
    assert.deepStrictEqual(out.suggestions, []);
    assert.match(rejectedKey(out, 'title').reason, /formula inside text/);
    assert.match(rejectedKey(out, 'notes').reason, /holds no field/);
    assert.match(rejectedKey(out, 'messageRef').reason, /a group of fields into the text/);
});

test('one transform of one field is kept as a pill and a chip', () => {
    const out = verify([
        { key: 'title', kind: 'expr', value: 'upper(steps.g1.output.value[0].subject)', reason: '' },
        { key: 'notes', kind: 'expr', value: "formatDate(steps.g1.output.value[0].receivedDateTime, 'D MMMM YYYY')", reason: '' },
    ]);
    const s = byKey(out);
    assert.deepStrictEqual(s.title.binding, { kind: 'expr', value: 'upper(steps.g1.output.value[0].subject)' });
    assert.deepStrictEqual(s.notes.binding, { kind: 'expr', value: 'formatDate(steps.g1.output.value[0].receivedDateTime, "D MMMM YYYY")' });
    assert.strictEqual(s.notes.sampleValue, '4 maart 2026');
});

test('a formula that is just a path is a ref; text glued with + is a template', () => {
    const out = verify([
        { key: 'title', kind: 'expr', value: 'steps.g1.output.value[0].subject', reason: '' },
        { key: 'notes', kind: 'expr', value: '"From " + steps.g1.output.value[0].from.emailAddress.name + " about " + steps.g1.output.value[0].subject', reason: '' },
    ]);
    const s = byKey(out);
    assert.deepStrictEqual(s.title.binding, { kind: 'ref', path: 'steps.g1.output.value[0].subject' });
    assert.deepStrictEqual(s.notes.binding, {
        kind: 'template',
        value: 'From {{steps.g1.output.value[0].from.emailAddress.name}} about {{steps.g1.output.value[0].subject}}',
    });
});

test('nested calls, operators, unknown functions and odd arguments are dropped, never shown as raw formula', () => {
    const out = verify([
        { key: 'title', kind: 'expr', value: 'upper(trim(steps.g1.output.value[0].subject))', reason: '' },
        { key: 'amount', kind: 'expr', value: 'steps.g1.output.value[0].attachments[0].size / 1024', reason: '' },
        { key: 'notes', kind: 'expr', value: 'eval(steps.g1.output.value[0].subject)', reason: '' },
        { key: 'messageRef', kind: 'expr', value: 'formatNumber(steps.g1.output.value[0].attachments[0].size, "euros")', reason: '' },
    ]);
    assert.deepStrictEqual(out.suggestions, []);
    assert.match(rejectedKey(out, 'title').reason, /cannot be shown as pills/);
    assert.match(rejectedKey(out, 'amount').reason, /raw formula/);
    assert.match(rejectedKey(out, 'notes').reason, /does not compile \(Unknown function: eval\)/);
    assert.match(rejectedKey(out, 'messageRef').reason, /these arguments/);
});

test('odd keys are fine as a pill or in text; inside a transform a key with , or ( is not', () => {
    const odd = { root: 'trigger.output', label: 'Form', sample: { 'Amount (EUR)': '12.50', 'Story Points': 5, 'a}}b': 'x' } };
    const params = [{ key: 'points', type: 'number' }, { key: 'note', type: 'string' }, { key: 'amount', type: 'number' }];
    const out = verify([
        { key: 'points', kind: 'ref', path: 'trigger.output["Story Points"]' },
        { key: 'note', kind: 'template', value: 'Note: {{trigger.output["a}}b"]}}' },
        { key: 'amount', kind: 'ref', path: 'trigger.output["Amount (EUR)"]' },
    ], [odd], params);
    assert.deepStrictEqual(byKey(out).points.binding, { kind: 'ref', path: 'trigger.output["Story Points"]' });
    assert.deepStrictEqual(byKey(out).note.binding, { kind: 'template', value: 'Note: {{trigger.output["a}}b"]}}' });
    assert.strictEqual(byKey(out).note.sampleValue, 'Note: x');
    // Numeric text needs number(…) for a number input, and that chip cannot hold this key.
    assert.match(rejectedKey(out, 'amount').reason, /cannot be shown as a pill inside a transform/);
});

test('a transform that changes nothing is dropped in favour of the bare field', () => {
    const out = verify([{ key: 'title', kind: 'expr', value: 'toStr(steps.g1.output.value[0].subject)', reason: '' }]);
    assert.deepStrictEqual(byKey(out).title.binding, { kind: 'ref', path: 'steps.g1.output.value[0].subject' });
});

// ── Verification: does the value fit the input ──────────────────────────────

test('a list of addresses for a text input is joined; for an e-mail input, a name is refused', () => {
    const out = verify([
        { key: 'recipients', kind: 'ref', path: 'steps.g1.output.value[0].toRecipients[*].emailAddress.address', reason: '' },
        { key: 'assigneeEmail', kind: 'ref', path: 'steps.g1.output.value[0].from.emailAddress.name', reason: '' },
    ]);
    assert.deepStrictEqual(byKey(out).recipients.binding, {
        kind: 'expr', value: 'join(steps.g1.output.value[0].toRecipients[*].emailAddress.address, ", ")',
    });
    assert.strictEqual(byKey(out).recipients.sampleValue, 'finance@fabrikam.nl, bob@fabrikam.nl');
    assert.match(rejectedKey(out, 'assigneeEmail').reason, /does not look like an e-mail address/);
});

test('numeric text for a number input is read as a number; plain text is refused', () => {
    const out = verify([
        { key: 'amount', kind: 'ref', path: 'steps.h1.output.body.data.items[0].amount', reason: '' },
    ], [HTTP_SOURCE]);
    assert.deepStrictEqual(byKey(out).amount.binding, { kind: 'expr', value: 'number(steps.h1.output.body.data.items[0].amount)' });
    const bad = verify([{ key: 'amount', kind: 'ref', path: 'steps.g1.output.value[0].subject', reason: '' }]);
    assert.match(rejectedKey(bad, 'amount').reason, /the input takes a number/);
});

test('choices, dates, yes/no, lists and groups are checked against the sample', () => {
    const out = verify([
        { key: 'priority', kind: 'ref', path: 'steps.g1.output.value[0].importance', reason: '' },
        { key: 'dueDate', kind: 'ref', path: 'steps.g1.output.value[0].receivedDateTime', reason: '' },
        { key: 'urgent', kind: 'ref', path: 'steps.g1.output.value[0].hasAttachments', reason: '' },
        { key: 'labels', kind: 'ref', path: 'steps.g1.output.value[1].categories', reason: '' },
        { key: 'title', kind: 'ref', path: 'steps.g1.output.value[0].from', reason: '' },
    ]);
    const s = byKey(out);
    assert.ok(s.priority && s.dueDate && s.urgent && s.labels);
    assert.match(rejectedKey(out, 'title').reason, /is a group of fields, the input takes text/);

    const bad = verify([
        { key: 'priority', kind: 'ref', path: 'steps.g1.output.value[0].subject', reason: '' },
        { key: 'dueDate', kind: 'expr', value: 'formatDate(steps.g1.output.value[0].receivedDateTime, "D MMMM YYYY")', reason: '' },
        { key: 'urgent', kind: 'ref', path: 'steps.g1.output.value[0].importance', reason: '' },
        { key: 'labels', kind: 'ref', path: 'steps.g1.output.value[0].subject', reason: '' },
        { key: 'amount', kind: 'template', value: '{{steps.g1.output.value[0].id}}-x', reason: '' },
    ]);
    assert.deepStrictEqual(bad.suggestions, []);
    assert.match(rejectedKey(bad, 'priority').reason, /not one of the allowed values/);
    assert.match(rejectedKey(bad, 'dueDate').reason, /the input takes a date/);
    assert.match(rejectedKey(bad, 'urgent').reason, /the input takes yes\/no/);
    assert.match(rejectedKey(bad, 'labels').reason, /the input takes a list/);
    assert.match(rejectedKey(bad, 'amount').reason, /gives text, the input takes a number/);
});

test('only the inputs that were asked for, once each', () => {
    const out = verify([
        { key: 'title', kind: 'ref', path: 'steps.g1.output.value[0].subject', reason: '' },
        { key: 'title', kind: 'ref', path: 'steps.g1.output.value[0].id', reason: '' },
        { key: 'password', kind: 'ref', path: 'steps.g1.output.value[0].id', reason: '' },
    ]);
    assert.strictEqual(out.suggestions.length, 1);
    assert.strictEqual(out.suggestions[0].binding.path, 'steps.g1.output.value[0].subject');
    assert.match(rejectedKey(out, 'password').reason, /not one of the inputs/);
});

test('an answer that is not a list of bindings yields nothing, never a throw', () => {
    assert.deepStrictEqual(verify(null), { suggestions: [], rejected: [] });
    assert.deepStrictEqual(verify('junk'), { suggestions: [], rejected: [] });
    assert.deepStrictEqual(verify([null, 7, { kind: 'ref' }]), { suggestions: [], rejected: [] });
});

// ── The request ─────────────────────────────────────────────────────────────

test('a root that is not a step output, the trigger or a loop item is refused', () => {
    for (const root of ['secrets', 'steps.a', 'steps.a.output.items', 'vars.x', 'steps.__proto__.output']) {
        assert.throws(() => input([{ root, sample: {} }]), (e) => e.status === 400 && e.code === 'suggest_mappings_bad_root', root);
    }
});

test('secret-like inputs are never asked about, and a sample that is too big is refused', () => {
    const r = input([MAIL_SOURCE], [{ key: 'apiKey' }, { key: 'title', type: 'string' }]);
    assert.deepStrictEqual(r.params.map((p) => p.key), ['title']);
    assert.throws(() => input([{ root: 'trigger.output', sample: { blob: 'x'.repeat(200_001) } }]), (e) => e.status === 400);
});

test('the injected model is asked once, with the tool, and its answer verified', async () => {
    const calls = [];
    const chat = async (messages, tool, options) => {
        calls.push({ messages, tool, options });
        return { structured: { bindings: [{ key: 'title', kind: 'ref', path: 'steps.g1.output.value[0].subject', reason: 'Subject' }] } };
    };
    const out = await suggestMappings(input(), { chat });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].tool, SUGGEST_MAPPINGS_TOOL);
    assert.strictEqual(calls[0].options.temperature, 0);
    assert.deepStrictEqual(out.suggestions.map((s) => s.key), ['title']);
});

// ── The route ───────────────────────────────────────────────────────────────

const pass = (req, res, next) => next();
let modelAnswer = { bindings: [] };
let modelFails = false;
const asked = [];
const models = [];
const api = h.serve('/', makeSuggestMappingsRouter({
    requireAuth: pass,
    rateLimit: pass,
    requireBeta: pass,
    resolveModel: async (opts) => { models.push(opts); return 'fast-model'; },
    chatForcedTool: async (modelId, messages) => {
        asked.push({ modelId, messages });
        if (modelFails) throw new Error('provider down');
        return { structured: modelAnswer };
    },
}));
test.after(api.close);
test.beforeEach(() => { asked.length = 0; models.length = 0; modelFails = false; modelAnswer = { bindings: [] }; });

test('the route answers verified suggestions and the reasons for what it dropped', async () => {
    modelAnswer = {
        bindings: [
            { key: 'title', kind: 'template', value: 'Invoice: {{steps.g1.output.value[0].subject}}', reason: 'The subject of the mail' },
            { key: 'assigneeEmail', kind: 'ref', path: 'steps.g1.output.value[0].from.emailAddress.address', reason: 'The sender' },
            { key: 'priority', kind: 'ref', path: 'steps.g1.output.value[0].nope', reason: 'guess' },
        ],
    };
    const res = await api.call('POST', '/suggest-mappings', {
        body: { step: { label: 'Create task', tool: 'planner_create_task' }, params: PARAMS, sources: [MAIL_SOURCE], mapped: [{ key: 'notes', kind: 'ref', paths: ['steps.g1.output.value[0].body.content'] }] },
    });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.suggestions.map((s) => [s.key, s.binding.kind]), [['title', 'template'], ['assigneeEmail', 'ref']]);
    assert.deepStrictEqual(res.body.rejected.map((r) => r.key), ['priority']);
    assert.strictEqual(asked[0].modelId, 'fast-model');
    assert.deepStrictEqual(models[0], { userOrgId: 'org1', userId: 'u1' });
    assert.match(asked[0].messages[1].content, /- "notes" ← steps\.g1\.output\.value\[0\]\.body\.content/);
    assert.match(asked[0].messages[1].content, /The step: "Create task" \(action planner_create_task\)/);
});

test('a model that fails is a 502 the editor can stay silent about', async () => {
    modelFails = true;
    const res = await api.call('POST', '/suggest-mappings', { body: { params: PARAMS, sources: [MAIL_SOURCE] } });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.code, 'suggest_mappings_unavailable');
});

test('a malformed request is refused before the model is asked', async () => {
    const noParams = await api.call('POST', '/suggest-mappings', { body: { params: [], sources: [MAIL_SOURCE] } });
    h.assertRefused(assert, noParams, 'body.params', /at least one input/);
    const extra = await api.call('POST', '/suggest-mappings', { body: { params: PARAMS, sources: [MAIL_SOURCE], instruction: 'x' } });
    assert.strictEqual(extra.status, 400);
    const badRoot = await api.call('POST', '/suggest-mappings', { body: { params: PARAMS, sources: [{ root: 'secrets', sample: {} }] } });
    assert.strictEqual(badRoot.status, 400);
    assert.strictEqual(badRoot.body.code, 'suggest_mappings_bad_root');
    assert.deepStrictEqual(asked, []);
});
