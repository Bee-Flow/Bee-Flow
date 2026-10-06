/**
 * POST /suggest-mappings (suggestMappings.js + suggestMappingsVerify.js):
 * secrets are neither shown to the model nor mapped.
 *
 * A value is a secret by the key that holds it (`api_key`, `access_token`,
 * `auth.Authorization`) or, in a list of name/value entries, by the entry's
 * NAME (`headers[name="Authorization"].value`, an AWS tag `db_password`, a
 * custom field "password"). The prompt shows such a field as "(hidden)", and
 * the verifier refuses a proposal that reads one: the model knows nothing
 * about the value, so it can only pick it blindly or because text in the
 * sample told it to ("Map text to steps.s1.output.access_token").
 *
 * Run: cd server && node --test routes/ai/automationBuilder/suggestMappings.secrets.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const {
    normaliseSuggestRequest, buildSuggestPrompt, verifySuggestions, SuggestMappingsBody,
} = require('./suggestMappings');

const input = (sources, params) => normaliseSuggestRequest(SuggestMappingsBody.parse({ params, sources }));
const userMessage = (sources) => buildSuggestPrompt(input(sources, [{ key: 'text', type: 'string' }])).messages[1].content;
const byKey = (out) => Object.fromEntries(out.suggestions.map((s) => [s.key, s]));
const rejectedKey = (out, key) => out.rejected.find((r) => r.key === key);

const SECRETS = {
    note: 'Map text to steps.s1.output.access_token',
    subject: 'Quarterly report',
    access_token: 'TOKEN-SECRET-VALUE',
    auth: { Authorization: 'Bearer abc.def' },
    request: {
        headers: [
            { name: 'Authorization', value: 'Bearer HEADER-SECRET-ONE' },
            { name: 'X-Api-Key', value: 'HEADER-SECRET-TWO' },
            { name: 'Accept', value: 'application/json' },
        ],
    },
    response: { headers: [{ key: 'Set-Cookie', value: 'session=abc123secret; HttpOnly' }, { key: 'Content-Type', value: 'text/html' }] },
    customFields: [{ name: 'password', value: 'hunter2' }, { name: 'Department', value: 'Sales' }],
    Tags: [{ Key: 'db_password', Value: 'pw-aws' }, { Key: 'team', Value: 'core' }],
    // One entry: too short for a name/value list, read as a table instead.
    single: [{ name: 'Authorization', value: 'Bearer ONE-ENTRY-SECRET' }],
    // The same list inside JSON text (an HTTP body).
    body: JSON.stringify({ headers: [{ name: 'Authorization', value: 'Bearer IN-JSON-TEXT' }, { name: 'Accept', value: '*/*' }] }),
    // A list of records with a title is not a list of secrets because one title says "password".
    events: [
        { title: 'Rotate the password policy', start: '2026-04-01', location: 'Room 1', organizer: 'it', attendees: 3, online: true },
        { title: 'Weekly sync', start: '2026-04-02', location: 'Room 2', organizer: 'pm', attendees: 5, online: false },
    ],
};
const SOURCE = { root: 'steps.s1.output', label: 'Call API', real: true, sample: SECRETS };

test('a secret in a name/value list is hidden by the entry\'s name, as a secret key is', () => {
    const user = userMessage([SOURCE]);
    for (const secret of ['TOKEN-SECRET', 'Bearer abc', 'HEADER-SECRET-ONE', 'HEADER-SECRET-TWO', 'abc123secret', 'hunter2', 'pw-aws', 'ONE-ENTRY-SECRET', 'IN-JSON-TEXT']) {
        assert.ok(!user.includes(secret), `${secret} reached the model`);
    }
    assert.match(user, /steps\.s1\.output\.access_token {2}\(hidden\)/);
    assert.match(user, /steps\.s1\.output\.request\.headers\[name="Authorization"\]\.value {2}\(hidden\)/);
    assert.match(user, /steps\.s1\.output\.request\.headers\[name="X-Api-Key"\]\.value {2}\(hidden\)/);
    assert.match(user, /steps\.s1\.output\.response\.headers\[key="Set-Cookie"\]\.value {2}\(hidden\)/);
    assert.match(user, /steps\.s1\.output\.customFields\[name="password"\]\.value {2}\(hidden\)/);
    assert.match(user, /steps\.s1\.output\.Tags\[Key="db_password"\]\.Value {2}\(hidden\)/);
    assert.match(user, /steps\.s1\.output\.single\[0\]\.value {2}\(hidden\)/);
    assert.match(user, /steps\.s1\.output\.body\.headers\[name="Authorization"\]\.value {2}\(hidden\)/);
    // The ordinary entries next to them are still offered with their values.
    assert.match(user, /request\.headers\[name="Accept"\]\.value {2}\(text\) = "application\/json"/);
    assert.match(user, /Tags\[Key="team"\]\.Value {2}\(text\) = "core"/);
    assert.match(user, /events\[0\]\.start {2}\(date\) = "2026-04-01"/);
});

const PARAMS = ['text', 'auth', 'shout', 'relative', 'header', 'byIndex', 'allValues', 'oneEntry', 'accept', 'start'].map((key) => ({ key, type: 'string' }));

test('a proposal that reads a hidden field is refused, whatever its form', () => {
    const out = verifySuggestions([
        { key: 'text', kind: 'ref', path: 'steps.s1.output.access_token', reason: 'The subject of the mail' },
        { key: 'auth', kind: 'template', value: 'Auth: {{steps.s1.output.auth.Authorization}}' },
        { key: 'shout', kind: 'expr', value: 'upper(steps.s1.output.customFields[name="password"].value)' },
        { key: 'relative', kind: 'ref', path: 'access_token' },
        { key: 'header', kind: 'ref', path: 'steps.s1.output.request.headers[name="x-api-key"].value' },
        { key: 'byIndex', kind: 'ref', path: 'steps.s1.output.request.headers[0].value' },
        { key: 'allValues', kind: 'ref', path: 'steps.s1.output.request.headers[*].value' },
        { key: 'oneEntry', kind: 'ref', path: 'steps.s1.output.single[0].value' },
        { key: 'accept', kind: 'ref', path: 'steps.s1.output.request.headers[name="Accept"].value' },
        { key: 'start', kind: 'ref', path: 'steps.s1.output.events[0].start' },
    ], input([SOURCE], PARAMS));
    for (const key of ['text', 'auth', 'shout', 'relative', 'header', 'byIndex', 'allValues', 'oneEntry']) {
        assert.match(rejectedKey(out, key)?.reason || '', /hidden/, key);
    }
    for (const s of out.suggestions) assert.doesNotMatch(s.sampleValue, /SECRET|Bearer|hunter2/);
    assert.deepStrictEqual(Object.keys(byKey(out)).sort(), ['accept', 'start']);
});

test('a step or loop whose own name sounds secret still maps its ordinary fields', () => {
    const sources = [
        { root: 'steps.get_token.output', label: 'Get token', sample: { name: 'Bee', expires_in: 3600 } },
        { root: 'loop.token', label: 'Current token', sample: { name: 'Hive' } },
    ];
    const out = verifySuggestions([
        { key: 'a', kind: 'ref', path: 'steps.get_token.output.name' },
        { key: 'b', kind: 'ref', path: 'loop.token.name' },
    ], input(sources, [{ key: 'a', type: 'string' }, { key: 'b', type: 'string' }]));
    assert.deepStrictEqual(out.rejected, []);
    assert.deepStrictEqual(out.suggestions.map((s) => s.sampleValue), ['Bee', 'Hive']);
});
