/**
 * modelSupportsVision — resolved through the stored provider's adapter.
 *
 * The regression this pins down was invisible from the outside: a hand-copied
 * regex here listed `claude-sonnet-4` and a bare `claude-5`, so the model this
 * product ships with, `claude-sonnet-5`, matched neither. App Studio then told
 * the extractor the model was blind, every uploaded photo was reduced to its
 * OCR text, and the model answered — accurately, for what it was handed — that
 * it saw an empty background.
 *
 * A name list cannot be kept honest by hand, so the assertion here is about
 * WHERE the answer comes from, not about which names are on a list.
 *
 * Run: node --test appStudio/aiRuntime.vision.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const providerStub = { byModel: {} };
stub('../core/aiAgent', {
    getProviderForModel: async (modelId) => {
        const cfg = providerStub.byModel[modelId];
        if (!cfg) throw new Error(`Model "${modelId}" not found in any configured provider.`);
        return cfg;
    },
    getAIConfig: async () => null,
});

const { modelSupportsVision } = require('./aiRuntime');

test('a Claude 5 model served by the Claude provider can see', async () => {
    providerStub.byModel = { 'claude-sonnet-5': { providerType: 'claude' } };
    assert.strictEqual(await modelSupportsVision('claude-sonnet-5'), true);
});

test('the adapter is the authority, not this file', async () => {
    // Same model id, different stored provider. A claude-named model served
    // from a generic OpenAI-compatible runtime is a different API, and the
    // name alone can never tell you that — which is the whole reason the
    // regex that used to answer this question was wrong.
    providerStub.byModel = { 'claude-sonnet-5': { providerType: 'claude' } };
    const viaClaude = await modelSupportsVision('claude-sonnet-5');
    providerStub.byModel = { 'claude-sonnet-5': { providerType: 'mistral' } };
    const viaMistral = await modelSupportsVision('claude-sonnet-5');
    assert.strictEqual(viaClaude, true);
    assert.strictEqual(viaMistral, false, 'the Mistral adapter answers for its own API');
});

test('a model in no configured provider falls back to the name, and fails OPEN', async () => {
    // Unlike native documents, guessing "cannot see" is the expensive mistake:
    // it blinds the model on a task that may be entirely visual.
    providerStub.byModel = {};
    assert.strictEqual(await modelSupportsVision('claude-opus-5'), true);
    assert.strictEqual(await modelSupportsVision('claude-sonnet-5'), true);
    assert.strictEqual(await modelSupportsVision('claude-haiku-4-5-20251001'), true);
    assert.strictEqual(await modelSupportsVision('gpt-5'), true);
    assert.strictEqual(await modelSupportsVision('gemini-3-pro'), true);
});

test('nothing at all is still no', async () => {
    providerStub.byModel = {};
    assert.strictEqual(await modelSupportsVision(''), false);
    assert.strictEqual(await modelSupportsVision(null), false);
    assert.strictEqual(await modelSupportsVision('some-text-only-model'), false);
});

// ── documentMode:'images' with a blind model ─────────────────────────
//
// The other half of the same failure, and the more expensive one: when the
// model could not see, `images` degraded SILENTLY to the PDF's text layer. On a
// technical drawing that layer is dense enough that no "insufficient text"
// heuristic fires, so the model answered confidently about a plate somebody was
// going to cut — without ever having looked at it. Whole orders came back with
// every material and thickness empty and a green toast.

const { extractDocuments } = require('./aiRuntime');

const APP = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };
const DOC = [{ kind: 'studio_attachment', fileId: 'f-1', name: 'MW2604-01-3025-001.pdf', mime: 'application/pdf' }];

test('images + a model that cannot see is REFUSED, not quietly downgraded', async () => {
    await assert.rejects(
        () => extractDocuments(APP, DOC, { modelSupportsVision: false, documentMode: 'images' }),
        (err) => {
            assert.strictEqual(err.status, 400);
            assert.strictEqual(err.code, 'vision_required');
            assert.match(err.message, /cannot read images/i);
            return true;
        },
    );
});

test('auto still degrades — that is the author saying they do not mind', async () => {
    // The distinction is the whole design: `images` is a requirement ("the
    // answer is IN the picture"), `auto` is a preference.
    await assert.doesNotReject(() => extractDocuments(APP, [], { modelSupportsVision: false, documentMode: 'auto' }));
    await assert.doesNotReject(() => extractDocuments(APP, [], { modelSupportsVision: false, documentMode: 'text' }));
});

test('images with a seeing model is fine', async () => {
    await assert.doesNotReject(() => extractDocuments(APP, [], { modelSupportsVision: true, documentMode: 'images' }));
});
