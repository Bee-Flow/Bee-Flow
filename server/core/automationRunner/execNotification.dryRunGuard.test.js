// @typecheck
/**
 * RM-5(e): a dry run guards a notification the way a live run does.
 *
 * The Privacy Shield pass (guardOutbound) runs BEFORE the dry-run return, so a
 * notification the shield blocks live is an error row in the rehearsal too,
 * not a green "would notify" (the dry-run honesty rule, ./execCode.js
 * header). A privacy check that could not run on this server is the
 * environment: an amber 'would_fail_live' row. A block on text built from data
 * the dry run made up itself is only annotated. The dry-run output carries
 * `_dryRun`, the marker blankInputs reads for "not really delivered".
 *
 * The guard is swapped on the safety module object (outboundGuard reads it
 * through that object), no module mocking; the policy rides on ctx.
 * Run: node --test core/automationRunner/execNotification.dryRunGuard.test.js
 */
'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const safety = require('./safety');
const { execNotification: run } = require('./execNotification');
/** Results are read loosely here: each case asserts the fields it is about. */
const execNotification = async (/** @type {any} */ step, /** @type {any} */ c, /** @type {any} */ rs, /** @type {string} */ mode) => /** @type {any} */ (await run(step, c, rs, mode));

const original = { guardToolInput: safety.guardToolInput, logEgress: safety.logEgress };
/** @type {null | string[]} */
let wouldBlock = null;
/** @type {Array<{ value: any, mode: string }>} */
let guarded = [];
/** @type {any[]} */
let ledger = [];

safety.logEgress = async (/** @type {any} */ row) => { ledger.push(row); };
safety.guardToolInput = async (/** @type {any} */ value, _policy, _audit, /** @type {string} */ mode) => {
    guarded.push({ value, mode });
    if (!wouldBlock) return { value, tokenMap: null, blocked: false, categories: [], markers: [] };
    if (mode !== 'dry_run') throw new safety.GuardrailBlockError(`Blocked: sensitive data detected (${wouldBlock.join(', ')})`, { categories: wouldBlock });
    return { value, tokenMap: null, blocked: true, categories: wouldBlock, markers: [], wouldBlock: true };
};
after(() => Object.assign(safety, original));
beforeEach(() => { wouldBlock = null; guarded = []; ledger = []; });

const POLICY = { piiEnabled: true, action: 'block', regexRules: [], scope: {}, privacyScope: 'external' };
const ctx = (extra = {}) => /** @type {any} */ ({ userId: 'u1', orgId: 'o1', runId: 'r1', _safetyPolicy: POLICY, ...extra });
/** @param {Record<string, any>} [steps] */
const state = (steps = {}) => ({ trigger: { output: { name: 'Jan' } }, steps, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] });
const mail = (body) => ({ id: 'n1', type: 'notification', channels: ['email'], title: 'New lead', body });
const REAL = { read: { output: { email: 'jan@example.com' }, status: 'success' } };

test('dry run: the interpolated text is guarded before the dry-run return', async () => {
    const r = await execNotification(mail('Lead {{steps.read.output.email}}'), ctx(), state(REAL), 'dry_run');
    assert.equal(guarded.length, 1);
    assert.equal(guarded[0].mode, 'dry_run');
    assert.match(guarded[0].value.body, /jan@example\.com/);
    assert.equal(r.output._dryRun, true);
    assert.deepEqual(r.output.wouldNotify, { title: 'New lead', body: 'Lead jan@example.com', channels: ['email'] });
    assert.equal(r.skippedReason, undefined);
    assert.equal(ledger.length, 0, 'a dry run delivers nothing and logs no delivery');
});

test('dry run: a block on REAL data is an error, as live', async () => {
    wouldBlock = ['Email Address'];
    for (const mode of ['dry_run', 'live']) {
        await assert.rejects(
            () => execNotification(mail('Lead {{steps.read.output.email}}'), ctx(), state(REAL), mode),
            (/** @type {any} */ e) => e.guardrailBlocked === true && /Email Address/.test(e.message),
        );
    }
});

test('dry run: a block on text the dry run made up itself is only annotated', async () => {
    wouldBlock = ['Email Address'];
    const sim = { read: { output: { email: 'sample@example.com' }, status: 'success', synthesised: true } };
    const r = await execNotification(mail('Lead {{steps.read.output.email}}'), ctx(), state(sim), 'dry_run');
    assert.equal(r.output._dryRun, true);
    assert.deepEqual(r.output._guardrailWouldBlock, ['Email Address']);
    assert.equal(r.skippedReason, undefined);

    const trig = await execNotification(mail('Hello {{trigger.output.name}}'), ctx({ triggerSynthetic: true }), state(), 'dry_run');
    assert.deepEqual(trig.output._guardrailWouldBlock, ['Email Address']);
});

test('dry run: a privacy check that could not run here is amber, not an error and not green', async () => {
    wouldBlock = ['privacy_protection_unavailable'];
    const r = await execNotification(mail('Lead {{steps.read.output.email}}'), ctx(), state(REAL), 'dry_run');
    assert.equal(r.skippedReason, 'would_fail_live');
    assert.equal(r.output._dryRun, true);
    assert.match(r.output.skipped, /live run would stop/);
});

test('dry run: an in-app only notification is guarded as internal and still marked _dryRun', async () => {
    const r = await execNotification({ id: 'n2', type: 'notification', channels: ['inapp', 'pager'], title: 'Hi' }, ctx(), state(), 'dry_run');
    assert.equal(guarded.length, 1);
    assert.equal(r.output._dryRun, true);
    assert.deepEqual(r.output.wouldNotify.ignoredChannels, ['pager']);
});
