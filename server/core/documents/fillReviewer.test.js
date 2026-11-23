'use strict';
/**
 * The model's final check (fillReviewer.mts) with the model, the Privacy
 * Shield and the usage log handed in: what goes out, what comes back, and what
 * is kept of it. The contract code is the real one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFillReviewer, reviewMessages, shieldForCheck, REVIEW_TOOL } = require('./fillReviewer.mts');

const contract = () => require('./documentContract');
const DOC = {
    id: 'd1', name: 'Offer Van Dijk', docType: 'quote', kind: 'document', bodyHtml: '<p>{{client}} {{scope}} {{price}} {{iban}}</p>',
    settings: {
        contract: { instructions: 'Formal Dutch business tone.', parameters: [
            { key: 'client', type: 'text', label: 'Client', required: true, instructions: 'The legal name of the client' },
            { key: 'scope', type: 'text', label: 'Scope', required: true },
            { key: 'price', type: 'number', label: 'Price', required: true },
            { key: 'iban', type: 'text', label: 'IBAN' },
        ] },
        sampleValues: { client: 'Van Dijk', scope: 'we fix it asap', price: 5 },
    },
};
const WHO = { userId: 'u1', orgId: 'org1' };

function kit(over = {}) {
    const seen = { asked: [], usage: [] };
    const deps = {
        resolveModel: async () => 'model-fast',
        scan: async () => ({ action: 'allow' }),
        restore: (text) => text,
        ask: async (modelId, messages, tool) => {
            seen.asked.push({ modelId, messages, tool });
            return { structured: { findings: [
                { key: 'scope', kind: 'rewrite', suggestion: 'We repair it as soon as possible.', reason: 'Written out in full.' },
                { key: 'price', kind: 'doubt', reason: 'Very low for this scope.' },
                { key: 'iban', kind: 'doubt', reason: 'Empty field: not looked at.' },
            ] }, usage: { input_tokens: 10 } };
        },
        logUsage: async (entry) => { seen.usage.push(entry); },
        contract,
        ...over,
    };
    return { review: makeFillReviewer(deps), seen };
}

test('the model is sent the filled-in fields as data, and its remarks are kept as the form shows them', async () => {
    const { review, seen } = kit();
    const out = await review(DOC, WHO);
    assert.equal(out.source, 'form');
    assert.equal(out.by, 'u1');
    assert.equal(out.checked, 3);
    assert.deepEqual(out.findings.map((f) => [f.key, f.kind]), [['scope', 'rewrite'], ['price', 'doubt']]);
    assert.equal(seen.asked[0].tool, REVIEW_TOOL);
    assert.equal(seen.asked[0].modelId, 'model-fast');
    const sent = JSON.parse(seen.asked[0].messages[1].content);
    assert.deepEqual(Object.keys(sent.values), ['client', 'scope', 'price'], 'only what is filled in goes out');
    assert.equal(sent.templateInstructions, 'Formal Dutch business tone.');
    assert.deepEqual(sent.fields.map((f) => f.key), ['client', 'scope', 'price']);
    assert.match(seen.asked[0].messages[0].content, /never invent/i);
    assert.equal(seen.usage.length, 1);
    assert.equal(seen.usage[0].modelId, 'model-fast');
});

test('nothing filled in: no model is asked', async () => {
    const { review, seen } = kit();
    const out = await review({ ...DOC, settings: { ...DOC.settings, sampleValues: {} } }, WHO);
    assert.deepEqual([out.checked, out.findings.length, seen.asked.length], [0, 0, 0]);
});

test('what the Privacy Shield masks goes out masked and comes back restored', async () => {
    const { review, seen } = kit({
        scan: async (messages) => ({ action: 'redact', redactedText: messages[1].content.split('Van Dijk').join('[PERSON_1]'), tokenMap: { '[PERSON_1]': 'Van Dijk' } }),
        restore: (text, map) => Object.entries(map).reduce((t, [token, real]) => t.split(token).join(real), text),
        ask: async (modelId, messages) => {
            seen.asked.push({ modelId, messages });
            return { structured: { findings: [{ key: 'client', kind: 'doubt', reason: '[PERSON_1] is a trade name, not a legal name.' }] } };
        },
    });
    const out = await review(DOC, WHO);
    assert.doesNotMatch(seen.asked[0].messages[1].content, /Van Dijk/);
    assert.equal(out.findings[0].reason, 'Van Dijk is a trade name, not a legal name.');
});

test('it refuses in words: no model, a privacy policy that blocks, an answer that is no check', async () => {
    await assert.rejects(kit({ resolveModel: async () => null }).review(DOC, WHO), (e) => e.status === 503 && e.errorClass === 'fill_review_no_model');
    await assert.rejects(kit({ scan: async () => ({ action: 'block' }) }).review(DOC, WHO), (e) => e.status === 422 && e.errorClass === 'fill_review_blocked');
    // The scan could not run at all: nothing goes out, and the reason given is that one.
    await assert.rejects(kit({ scan: async () => ({ action: 'block', scanStatus: 'failed' }) }).review(DOC, WHO), (e) => e.status === 503 && e.errorClass === 'fill_review_shield_unavailable');
    await assert.rejects(kit({ ask: async () => ({ structured: { nope: true } }) }).review(DOC, WHO), (e) => e.status === 502 && e.errorClass === 'fill_review_unusable');
});

test('the messages name the document and carry no empty field', () => {
    const { messages, checked } = reviewMessages(DOC, contract());
    assert.equal(checked, 3);
    assert.equal(JSON.parse(messages[1].content).document.name, 'Offer Van Dijk');
    assert.doesNotMatch(messages[1].content, /iban/);
});

test('a form cannot ask the person what may go out: "ask" becomes "mask", and the stricter policies stay as they are', () => {
    assert.deepEqual(shieldForCheck(null), {});
    assert.equal(shieldForCheck({ enabled: true, dlpEnabled: true, dlpMode: 'ask' }).dlpMode, 'auto_redact');
    assert.equal(shieldForCheck({ enabled: true, dlpEnabled: true }).dlpMode, 'auto_redact', 'asking is the default');
    assert.equal(shieldForCheck({ enabled: true, dlpEnabled: true, dlpMode: 'block' }).dlpMode, 'block');
    assert.equal(shieldForCheck({ enabled: true, dlpEnabled: true, dlpMode: 'auto_allow' }).dlpMode, 'auto_allow');
    // Every message is to be looked at by a person first: that cannot be done here, so the scan still says "ask" and the check is refused.
    assert.equal(shieldForCheck({ enabled: true, dlpEnabled: true, dlpMode: 'ask', dlpAlwaysReview: true }).dlpMode, 'ask');
    // A shield that is on scans what a document sends out, also where the chat's own scan is off.
    assert.deepEqual(shieldForCheck({ enabled: true, dlpEnabled: false }), { enabled: true, dlpEnabled: true, dlpMode: 'auto_redact', dlpScope: 'all' });
    const config = { enabled: true, dlpEnabled: true, dlpMode: 'ask' };
    shieldForCheck(config);
    assert.equal(config.dlpMode, 'ask', 'the organisation\'s own settings are not touched');
});

test('a scan that would have to ask the person refuses the check', async () => {
    await assert.rejects(kit({ scan: async () => ({ action: 'ask' }) }).review(DOC, WHO), (e) => e.status === 422 && e.errorClass === 'fill_review_blocked');
});
