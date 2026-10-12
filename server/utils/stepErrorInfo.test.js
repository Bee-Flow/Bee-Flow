/**
 * utils/stepErrorInfo.js — a failed step as the drawer's error card.
 *
 * Proven, per error family: the code, the plain-English title and cause
 * (params filled, no dashes as punctuation), the i18n keys, the setting that
 * fixes it (settingKey) and the fix buttons. Plus: the runner's enriched
 * Nextcloud errors keep their raw text as `technical`, a legacy row is
 * classified from its message alone, and nothing here ever throws.
 *
 * Run: cd server && node --test utils/stepErrorInfo.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    describeStepError, safeDescribeStepError, legacyStepErrorInfo, stepErrorI18nDefaults, STEP_ERROR_CODES, _test,
} = require('./stepErrorInfo');

const lit = (value) => ({ kind: 'literal', value });
const ncStep = (tool, inputs = {}) => ({ id: 's1', type: 'integration_action', tool, inputs });
const fixIds = (info) => info.fixes.map(f => f.id);

/** The runner's shape: execAi's enrichNextcloudError rewrote the message. */
function enriched(raw, code) {
    const err = new Error(`Rewritten — remediation`);
    err.ncRawMessage = raw;
    err.ncError = { code };
    return err;
}

test('Nextcloud no access: "Bee may not open this folder", rings the connection, share + other account', () => {
    const info = describeStepError(
        enriched('Nextcloud PROPFIND failed (403): Forbidden', 'NO_ACCESS'),
        { step: ncStep('nextcloud_read_file', { path: lit('/Invoices/2026/a.pdf') }), inputs: { path: '/Invoices/2026/a.pdf' } },
    );
    assert.strictEqual(info.code, 'nextcloud_no_access');
    assert.strictEqual(info.title, 'Bee may not open this folder');
    assert.match(info.cause, /cannot open \/Invoices\/2026\. Share the folder/);
    assert.strictEqual(info.settingKey, 'connection');
    assert.deepStrictEqual(fixIds(info), ['share_folder', 'switch_account']);
    assert.deepStrictEqual(info.fixes[0].params, { folder: '/Invoices/2026' });
    assert.strictEqual(info.fixes[0].labelKey, 'automations.output.fix_share');
    assert.strictEqual(info.titleKey, 'automations.step_error.nextcloud_no_access.title');
    assert.strictEqual(info.causeKey, 'automations.step_error.nextcloud_no_access.cause');
    assert.strictEqual(info.params.folder, '/Invoices/2026');
    assert.strictEqual(info.params.app, 'Files');
    // The raw text, not the rewritten one, is the technical message.
    assert.strictEqual(info.technical, 'Nextcloud PROPFIND failed (403): Forbidden');
});

test('no access names the account on the share button when the caller knows it', () => {
    const info = describeStepError('Upload failed (403): forbidden', {
        step: ncStep('nextcloud_upload_file', { path: '/Shared/x.txt' }), account: 'bee-bot',
    });
    assert.strictEqual(info.fixes[0].label, 'Share the folder with bee-bot');
    assert.strictEqual(info.fixes[0].labelKey, 'automations.output.fix_share_with');
    assert.deepStrictEqual(info.fixes[0].params, { folder: '/Shared', account: 'bee-bot' });
});

test('a 403 on Deck is "no permission", not a folder to share', () => {
    const info = describeStepError('Permission denied', { step: ncStep('nextcloud_deck_create_card', { boardId: 3 }) });
    assert.strictEqual(info.code, 'permission_denied');
    assert.strictEqual(info.title, 'Bee may not do this in Nextcloud');
    assert.strictEqual(info.settingKey, 'connection');
});

test('Nextcloud not found: rings the input the message quotes, pick another + retry', () => {
    const info = describeStepError('nextcloud_read_file failed: File not found: /Invoices/missing.pdf', {
        step: ncStep('nextcloud_read_file', { path: lit('/Invoices/missing.pdf'), limit: 5 }),
    });
    assert.strictEqual(info.code, 'nextcloud_not_found');
    assert.strictEqual(info.settingKey, 'inputs.path');
    assert.strictEqual(info.cause, 'Nothing was found at /Invoices/missing.pdf. It may have been moved, renamed or deleted.');
    assert.deepStrictEqual(fixIds(info), ['pick_other', 'retry']);
    assert.deepStrictEqual(info.fixes[0].params, { settingKey: 'inputs.path' });
});

test('not found without a target setting falls back to the generic cause', () => {
    const info = describeStepError('File not found', { step: ncStep('nextcloud_read_file', { path: { kind: 'ref', path: 'steps.a.output.p' } }) });
    assert.strictEqual(info.settingKey, 'inputs.path');
    assert.strictEqual(info.causeKey, 'automations.step_error.nextcloud_not_found.cause_generic');
    assert.doesNotMatch(info.cause, /\{/);
});

test('fileId is the setting when the step has no path', () => {
    const info = describeStepError('Nextcloud request failed (404)', { step: ncStep('nextcloud_add_file_comment', { fileId: 991, message: 'hi' }) });
    assert.strictEqual(info.code, 'nextcloud_not_found');
    assert.strictEqual(info.settingKey, 'inputs.fileId');
});

test('Nextcloud not connected and session expired: reconnect first, connection ringed', () => {
    const nc = describeStepError('NOT_CONNECTED', { step: ncStep('nextcloud_list_files', { path: '/' }) });
    assert.strictEqual(nc.code, 'nextcloud_not_connected');
    assert.strictEqual(nc.title, 'Nextcloud is not connected');
    assert.strictEqual(nc.settingKey, 'connection');
    assert.deepStrictEqual(fixIds(nc), ['reconnect', 'switch_account']);

    const exp = describeStepError('Nextcloud token refresh failed — user must re-authenticate', { step: ncStep('nextcloud_list_files') });
    assert.strictEqual(exp.code, 'nextcloud_session_expired');
    assert.strictEqual(exp.title, 'The Nextcloud sign-in has expired');
    assert.deepStrictEqual(fixIds(exp), ['reconnect', 'switch_account']);
});

test('Nextcloud app disabled names the app', () => {
    const info = describeStepError('The Notes app is not enabled for this user', { step: ncStep('nextcloud_notes_create', { title: 'x' }) });
    assert.strictEqual(info.code, 'nextcloud_app_disabled');
    assert.strictEqual(info.title, 'Notes is not available in Nextcloud');
    assert.match(info.cause, /^Notes is not enabled/);
    assert.strictEqual(info.settingKey, 'connection');
    assert.deepStrictEqual(fixIds(info), ['switch_account', 'retry']);
});

test('missing field: names the field and rings it', () => {
    const info = describeStepError('nextcloud_list_files failed: path is required', { step: ncStep('nextcloud_list_files', {}) });
    assert.strictEqual(info.code, 'missing_field');
    assert.strictEqual(info.settingKey, 'inputs.path');
    assert.strictEqual(info.cause, 'The setting "path" needs a value before this step can run.');
    assert.deepStrictEqual(fixIds(info), ['open_settings']);

    const other = describeStepError('Missing required parameter: roomToken', { step: { type: 'integration_action', tool: 'slack_post', inputs: {} } });
    assert.strictEqual(other.code, 'missing_field');
    assert.strictEqual(other.settingKey, 'inputs.roomToken');

    const either = describeStepError('Either sourceHandle (preferred for binary) or content (for inline text) is required.', {
        step: ncStep('nextcloud_upload_file', { path: '/a', content: '' }),
    });
    assert.strictEqual(either.settingKey, 'inputs.content');
});

test('rate limit, timeout and provider errors offer a retry and ring nothing', () => {
    const rl = describeStepError(Object.assign(new Error('Too Many Requests'), { status: 429 }), { step: { type: 'integration_action', tool: 'gmail_send' } });
    assert.strictEqual(rl.code, 'rate_limited');
    assert.strictEqual(rl.cause, 'Gmail is limiting how often Bee may call it. Wait a moment, then try again.');
    assert.strictEqual(rl.settingKey, null);
    assert.deepStrictEqual(fixIds(rl), ['retry']);

    const to = describeStepError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), { step: { type: 'http_request' } });
    assert.strictEqual(to.code, 'timeout');
    assert.strictEqual(to.cause.startsWith('The web service did not answer in time.'), true);

    const pe = describeStepError(Object.assign(new Error('Overloaded'), { status: 529 }), { step: { type: 'ai_step' } });
    assert.strictEqual(pe.code, 'provider_error');
    assert.strictEqual(pe.title, 'The AI model had a problem');
    assert.deepStrictEqual(fixIds(pe), ['retry']);
});

test('model errors: unavailable rings the model tier, too long and refused ring the prompt', () => {
    const un = describeStepError('Could not resolve model for tier fast', { step: { type: 'ai_step', prompt: 'x' } });
    assert.strictEqual(un.code, 'model_unavailable');
    assert.strictEqual(un.settingKey, 'modelTier');
    assert.deepStrictEqual(fixIds(un), ['open_settings']);

    const long = describeStepError(Object.assign(new Error('prompt is too long: 250000 tokens > 200000 maximum'), { status: 400 }), { step: { type: 'ai_step' } });
    assert.strictEqual(long.code, 'model_context_too_long');
    assert.strictEqual(long.settingKey, 'prompt');

    const quota = describeStepError('Your credit balance is too low to access the Anthropic API.', { step: { type: 'ai_step' } });
    assert.strictEqual(quota.code, 'model_quota');

    const refused = describeStepError('The response was blocked by the content policy', { step: { type: 'ai_step' } });
    assert.strictEqual(refused.code, 'model_refused');
    assert.strictEqual(refused.settingKey, 'prompt');

    // data_extraction's model is an admin setting: nothing to ring on the step.
    const de = describeStepError('data_extraction: no model is configured — set the extraction model', { step: { type: 'data_extraction' } });
    assert.strictEqual(de.code, 'model_unavailable');
    assert.strictEqual(de.settingKey, null);
});

test('validation: a 400 naming an input rings it', () => {
    const info = describeStepError(Object.assign(new Error('Invalid value for dueDate: not a date'), { status: 400 }), {
        step: { type: 'integration_action', tool: 'youtrack_create_issue', inputs: { dueDate: 'tomorrow' } },
    });
    assert.strictEqual(info.code, 'validation');
    assert.strictEqual(info.settingKey, 'inputs.dueDate');
    assert.strictEqual(info.cause, 'YouTrack did not accept the value of "dueDate". Check that setting and try again.');
    assert.deepStrictEqual(fixIds(info), ['open_settings']);
});

test('generic auth, permission and not-found errors from other integrations', () => {
    const step = { type: 'integration_action', tool: 'gmail_send', inputs: {} };
    assert.strictEqual(describeStepError(Object.assign(new Error('x'), { status: 401 }), { step }).code, 'auth_expired');
    assert.strictEqual(describeStepError('Gmail is not connected for this user', { step }).code, 'not_connected');
    assert.strictEqual(describeStepError(Object.assign(new Error('x'), { status: 403 }), { step }).code, 'permission_denied');
    const nf = describeStepError(Object.assign(new Error('Requested entity was not found'), { status: 404 }),
        { step: { type: 'integration_action', tool: 'drive_read', inputs: { fileId: lit('abc') } } });
    assert.strictEqual(nf.code, 'not_found');
    assert.strictEqual(nf.settingKey, 'inputs.fileId');
    assert.strictEqual(nf.title, 'Bee cannot find what this step points at');
});

test('guardrail, tool no longer permitted and unknown', () => {
    const g = describeStepError(Object.assign(new Error('blocked'), { guardrailBlocked: true }), { step: { type: 'ai_step' } });
    assert.strictEqual(g.code, 'guardrail_blocked');
    assert.deepStrictEqual(g.fixes, []);
    const t = describeStepError('You no longer have permission to use "gmail_send". Ask your organisation admin.', { step: { type: 'integration_action', tool: 'gmail_send' } });
    assert.strictEqual(t.code, 'tool_not_permitted');
    assert.strictEqual(t.settingKey, 'tool');
    const u = describeStepError('Something odd', { step: { type: 'code' } });
    assert.strictEqual(u.code, 'unknown');
    assert.deepStrictEqual(fixIds(u), ['retry']);
});

test('the technical message is capped, never thrown on, and absent when empty', () => {
    const long = 'x'.repeat(5000);
    assert.ok(describeStepError(long).technical.length <= 2000);
    assert.strictEqual(describeStepError(null).technical, null);
    assert.strictEqual(describeStepError(null).code, 'unknown');
    const hostile = { get message() { throw new Error('boom'); } };
    assert.strictEqual(safeDescribeStepError(hostile, {}), null);
});

test('legacy rows: classified from the message, the step type and the recorded inputs', () => {
    const info = legacyStepErrorInfo('Nextcloud PROPFIND failed (403): Forbidden', 'integration_action', { path: '/HR/contract.pdf' });
    assert.strictEqual(info.code, 'nextcloud_no_access');
    assert.strictEqual(info.params.folder, '/HR');
    assert.strictEqual(legacyStepErrorInfo('', 'ai_step', null), null);
    assert.strictEqual(legacyStepErrorInfo('Could not resolve model for tier fast', 'ai_step', null).code, 'model_unavailable');
});

test('every English text is dash-free punctuation and has an i18n key', () => {
    const texts = stepErrorI18nDefaults();
    for (const code of STEP_ERROR_CODES) {
        assert.ok(texts[`automations.step_error.${code}.title`], code);
        assert.ok(texts[`automations.step_error.${code}.cause`], code);
    }
    for (const [k, v] of Object.entries(texts)) {
        assert.doesNotMatch(v, /[–—]| - /, k);
        assert.ok(k.startsWith('automations.step_error.'));
    }
});

test('helpers: status only from plain shapes, folder of a path', () => {
    assert.strictEqual(_test.statusOf(null, 'Invoice 450 EUR'), null);
    assert.strictEqual(_test.statusOf(null, 'failed (404)'), 404);
    assert.strictEqual(_test.statusOf({ response: { status: 502 } }, ''), 502);
    assert.strictEqual(_test.folderOf('/a/b/c.pdf'), '/a/b');
    assert.strictEqual(_test.folderOf('/a/b/'), '/a/b');
    assert.strictEqual(_test.folderOf('c.pdf'), '/');
    assert.strictEqual(_test.serviceOf({ tool: 'weird_tool' }), 'Weird');
});
