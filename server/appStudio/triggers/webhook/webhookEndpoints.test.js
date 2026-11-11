'use strict';

/**
 * The address and the secret of a webhook trigger (webhookEndpoints.mts), the `webhook` kind
 * (kinds/webhook.mts) and where the secret is NOT: against the real stores on PGlite
 * (testUtils/webhookTriggerHarness.testkit.js).
 *
 * Run: cd server && node --test appStudio/triggers/webhook/webhookEndpoints.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { webhookHarness } = require('../../../testUtils/webhookTriggerHarness.testkit');
const { applyToolCall } = require('../../builderTools');
const { canonicalizeAppDefinition } = require('../../canonicalize');
const { validateAppDefinition } = require('../../validate');
const { emptyDefinition } = require('../../componentSpecs');
const { unattendedActionProblems, runsUnattended } = require('../unattendedPolicy.mts');
const webhook = require('../kinds/webhook.mts').default;

const h = webhookHarness({ before, after, beforeEach });
const { s, t, w, publish, unpublish, endpoint, secret, signed, receive, definition, hook, row, settle, endpoints } = h;
const { webhookView, revealWebhookSecret, rotateWebhookSecret, isEndpointId } = endpoints;

const view = () => webhookView(t.app, 'hook', h.endpointDeps());
const reveal = () => revealWebhookSecret(t.app, 'hook', h.endpointDeps());
const rotate = () => rotateWebhookSecret(t.app, 'hook', h.endpointDeps());

// ── When an endpoint exists ─────────────────────────────────────────────────

test('a draft has no endpoint; a publish makes one; a publish with the action edited keeps the address and the secret', async () => {
    t.app.definition = definition([hook()]);
    assert.equal(await endpoint(), null);
    assert.equal((await view()).endpoint, null);
    await publish(definition([hook()]));
    const first = await endpoint();
    assert.equal(isEndpointId(first.endpointId), true);
    await publish(definition([hook()], [h.write('other')]));
    assert.deepEqual(await endpoint(), first);
    assert.equal((await receive(await signed({ a: 1 }))).status, 202, 'the sender goes on with what it was given');
});

test('an unpublish keeps the address (nothing is accepted meanwhile); a publish without the trigger removes it and its log', async () => {
    await publish(definition([hook()]));
    const first = await endpoint();
    await receive(await signed({ a: 1 }, { secret: 'wrong' }));
    await unpublish();
    assert.deepEqual(await endpoint(), first);
    await publish(definition([hook()]));
    assert.deepEqual(await endpoint(), first);
    await publish(definition([h.every(15)]));
    assert.equal(await endpoint(), null);
    assert.equal((await h.pg.query('SELECT COUNT(*)::int AS n FROM studio_app_webhook_deliveries')).rows[0].n, 0);
    assert.deepEqual(await receive(await signed({ a: 1 }, { endpointId: first.endpointId })), { status: 404 });
});

test('two triggers have two addresses and two secrets; one trigger\'s secret does not open the other', async () => {
    await publish(definition([hook(), hook({ id: 'other' })]));
    const [a, b] = [await endpoint('hook'), await endpoint('other')];
    assert.notEqual(a.endpointId, b.endpointId);
    assert.notEqual(await secret('hook'), await secret('other'));
    assert.deepEqual(await receive(await signed({ a: 1 }, { endpointId: b.endpointId, secret: await secret('hook') })), { status: 404 });
});

// ── The secret is shown once ────────────────────────────────────────────────

test('the owner is shown the secret once; after that only a rotation hands one out', async () => {
    await publish(definition([hook()]));
    assert.equal((await view()).endpoint.secretAvailable, true);
    const shown = await reveal();
    assert.deepEqual(shown, { ok: true, secret: await secret(), previousValidUntil: null });
    assert.equal((await view()).endpoint.secretAvailable, false);
    const again = await reveal();
    assert.deepEqual([again.ok, again.status, again.code], [false, 409, 'secret_shown']);
    const [one, two] = await Promise.all([rotate(), rotate()]);
    assert.notEqual(one.secret, two.secret);
    assert.equal((await reveal()).code, 'secret_shown', 'a rotated secret was handed out by the rotation');
});

test('a trigger without an endpoint has no secret to show or rotate', async () => {
    assert.equal((await reveal()).code, 'no_endpoint');
    assert.equal((await rotate()).code, 'no_endpoint');
});

// ── Rotation ────────────────────────────────────────────────────────────────

test('after a rotation the new secret signs, the old one signs on for the overlap and then stops', async () => {
    await publish(definition([hook()]));
    const old = await secret();
    const rotated = await rotate();
    assert.equal(rotated.previousValidUntil, new Date(s.clock + 3600_000).toISOString());
    assert.equal((await view()).endpoint.previousValidUntil, rotated.previousValidUntil);
    const send = async (key) => {
        const out = await receive(await signed({ a: 1 }, { secret: key }));
        if (out.status === 202) await settle((await row('hook')).lastRunId);
        return out.status;
    };
    assert.deepEqual([await send(rotated.secret), await send(old)], [202, 202]);
    s.clock += 3601_000;
    assert.deepEqual([await send(rotated.secret), await send(old)], [202, 404]);
    assert.equal((await view()).endpoint.previousValidUntil, null);
});

test('with an overlap of 0 the old secret stops at the rotation', async () => {
    await publish(definition([hook()]));
    const old = await secret();
    w.limits.rotationOverlapSeconds = 0;
    const rotated = await rotate();
    assert.equal(rotated.previousValidUntil, null);
    assert.equal((await endpoint()).prevSecretCipher, null);
    assert.deepEqual(await receive(await signed({ a: 1 }, { secret: old })), { status: 404 });
    assert.equal((await receive(await signed({ a: 1 }, { secret: rotated.secret }))).status, 202);
});

// ── Where the secret is not ─────────────────────────────────────────────────

test('the secret and the address are in no definition, armed row, run, delivery log, view or log line', async () => {
    const lines = [];
    const log = { info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
    await publish(definition([hook()]));
    await endpoints.syncWebhookEndpoints('app_1', { ...h.endpointDeps(), log });
    const key = await secret();
    const { endpointId, secretCipher } = await endpoint();
    assert.notEqual(secretCipher, key, 'stored sealed');
    await receive(await signed({ a: 1 }), { log });
    await settle((await row('hook')).lastRunId);
    await receive(await signed({ a: 1 }, { secret: 'wrong' }), { log });
    const rotated = await rotateWebhookSecret(t.app, 'hook', { ...h.endpointDeps(), log });
    const everything = JSON.stringify([
        t.app.definition, t.app.publishedDefinition, await h.rows(), await h.runs(), await h.deliveries(), await view(), lines,
        s.executed.map((e) => e.ctx),
        (await h.pg.query('SELECT * FROM studio_app_action_run_steps')).rows,
    ]);
    for (const [what, value] of [['the secret', key], ['the rotated secret', rotated.secret], ['the sealed secret', secretCipher]]) {
        assert.equal(everything.includes(value), false, `${what} leaked`);
    }
    // The address is the owner's to read in the view, and nowhere else.
    const withoutView = JSON.stringify([t.app.publishedDefinition, await h.rows(), await h.runs(), lines, s.executed.map((e) => e.ctx)]);
    assert.equal(withoutView.includes(endpointId), false);
    assert.equal(lines.length > 0, true);
});

// ── The kind ────────────────────────────────────────────────────────────────

const BASE = canonicalizeAppDefinition(emptyDefinition()).def;
const JOB = { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'n', value: { kind: 'static', value: 1 } }] };
const app = (triggers) => ({ ...BASE, variables: [{ name: 'n', type: 'number' }], actions: { act_job1: JOB }, triggers });

test('the canonical webhook trigger is { id, kind, actionId, auth }: a secret or an address written into it is dropped', () => {
    const { def } = canonicalizeAppDefinition(app([{ kind: 'webhook', actionId: 'act_job1', secret: 'abc', endpointId: 'x', url: 'https://example.test/hook' }]));
    assert.deepEqual(def.triggers, [{ id: 'trigger1', kind: 'webhook', actionId: 'act_job1', auth: 'hmac' }]);
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(validateAppDefinition(def, {}).errors, []);
    assert.equal(canonicalizeAppDefinition(app([{ kind: 'webhook', actionId: 'act_job1', auth: 'none' }])).def.triggers, undefined, 'another auth is not kept');
});

test('the validator refuses a webhook trigger that skipped the canonicalizer with a secret or without hmac', () => {
    const codes = (trigger) => validateAppDefinition({ ...canonicalizeAppDefinition(app(undefined)).def, schemaVersion: 3, triggers: [trigger] }, {}).errors.map((e) => `${e.code} @ ${e.path}`);
    assert.deepEqual(codes({ id: 'hook', kind: 'webhook', actionId: 'act_job1', auth: 'hmac', secret: 'abc' }), ['triggers.field_unknown @ triggers[0].secret']);
    assert.deepEqual(codes({ id: 'hook', kind: 'webhook', actionId: 'act_job1' }), ['triggers.webhook_invalid @ triggers[0].auth']);
});

test('a webhook run may not hold an http_request step, whatever the catalogue says about unattended runs', () => {
    assert.deepEqual(webhook.refusedKinds, ['http_request']);
    assert.equal(runsUnattended('create_record', webhook.refusedKinds), true);
    assert.equal(runsUnattended('http_request', webhook.refusedKinds), false);
    const action = { kind: 'sequence', steps: [{ kind: 'condition', expr: 'true', then: [{ kind: 'create_record', tableId: 't', values: {} }, { kind: 'http_request', connectorId: 'c' }] }] };
    const problems = unattendedActionProblems(action, 'act', { refusedKinds: webhook.refusedKinds });
    assert.deepEqual(problems.map((p) => [p.code, p.kind]), [['triggers.step_not_unattended', 'http_request']]);
});

test('app_set_trigger writes a webhook trigger; its result and the draft hold no address and no secret', async () => {
    const wrap = { def: canonicalizeAppDefinition(app(undefined)).def };
    const out = await applyToolCall('app_set_trigger', { kind: 'webhook', actionId: 'act_job1', secret: 'abc' }, wrap);
    assert.equal(out.error, undefined, out.error);
    assert.deepEqual(out.trigger, { id: 'trigger1', kind: 'webhook', actionId: 'act_job1', auth: 'hmac' });
    assert.equal(JSON.stringify([out, wrap.def]).includes('abc'), false);
});
