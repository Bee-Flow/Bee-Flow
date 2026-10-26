// @typecheck
/** Forms: settings PATCH split, public share link, no half-built question. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { json, installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');

test.after(resetFakeNc);
const { executeNextcloudFormsTool } = require('./nextcloudFormsTools');

const PROXY = 'https://proxy.example.test/app_api/proxy/bee_flow/nc';

function install({ mode = 'connector', failOption = false, failQuestionPatch = false } = {}) {
    return installFakeNc(({ url, method, body }) => {
        if (method === 'PATCH' && /\/questions\//.test(url) && failQuestionPatch) return json(500, 'x');
        if (method === 'PATCH') {
            const keys = Object.keys(body.keyValuePairs);
            if (keys.includes('state') && keys.length > 1) return json(403, { ocs: { meta: { message: 'mixed' } } });
            return json(200, { ocs: { data: 1 } });
        }
        if (/\/options$/.test(url)) return failOption ? json(500, 'boom') : json(200, { ocs: { data: [{ id: 1 }] } });
        if (/\/questions$/.test(url)) return json(200, { ocs: { data: { id: 5 } } });
        if (method === 'DELETE') return json(200, {});
        const form = { id: 3, hash: 'abc', title: 't', questions: [] };
        return json(200, { ocs: { data: method === 'GET' ? form : { id: 3, hash: 'abc' } } });
    }, { mode, baseUrl: PROXY, publicBaseUrl: 'https://nc.example.test' });
}

test('state and other settings go out as separate PATCH calls', async () => {
    const calls = install();
    const out = await executeNextcloudFormsTool('nextcloud_forms_update_settings', { formId: 3, state: 1, title: 'x' }, 'u', {});
    assert.equal(out.success, true);
    const patches = calls.filter(c => c.method === 'PATCH').map(c => Object.keys(c.body.keyValuePairs));
    assert.deepEqual(patches, [['title'], ['state']]);
    assert.deepEqual(out.updated, ['title', 'state']);
});

test('shareUrl is the public Nextcloud URL, not the connector proxy', async () => {
    install();
    const out = await executeNextcloudFormsTool('nextcloud_forms_get', { formId: 3 }, 'u', {});
    assert.equal(out.shareUrl, 'https://nc.example.test/index.php/apps/forms/s/abc');
});

test('a failed option removes the half-built question and the options are returned on success', async () => {
    let calls = install({ failOption: true });
    const bad = await executeNextcloudFormsTool('nextcloud_forms_add_question', { formId: 3, text: 'q', type: 'dropdown', options: ['a'] }, 'u', {});
    assert.ok(bad.error);
    assert.ok(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/questions/5')));
    calls = install();
    const ok = await executeNextcloudFormsTool('nextcloud_forms_add_question', { formId: 3, text: 'q', type: 'dropdown', options: ['a', 'b'] }, 'u', {});
    assert.deepEqual(ok.question.options.map((/** @type {{ text: string }} */ o) => o.text), ['a', 'b']);
});

test('reopening a form (state 0) is sent before the other settings, closing after', async () => {
    let calls = install();
    await executeNextcloudFormsTool('nextcloud_forms_update_settings', { formId: 3, state: 0, title: 'x' }, 'u', {});
    assert.deepEqual(calls.filter(c => c.method === 'PATCH').map(c => Object.keys(c.body.keyValuePairs)), [['state'], ['title']]);
    calls = install();
    await executeNextcloudFormsTool('nextcloud_forms_update_settings', { formId: 3, state: 1, title: 'x' }, 'u', {});
    assert.deepEqual(calls.filter(c => c.method === 'PATCH').map(c => Object.keys(c.body.keyValuePairs)), [['title'], ['state']]);
});

test('a failed isRequired/description PATCH removes the half-built question too', async () => {
    const calls = install({ failQuestionPatch: true });
    const out = await executeNextcloudFormsTool('nextcloud_forms_add_question', { formId: 3, text: 'q', isRequired: true }, 'u', {});
    assert.ok(out.error);
    assert.ok(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/questions/5')));
});
