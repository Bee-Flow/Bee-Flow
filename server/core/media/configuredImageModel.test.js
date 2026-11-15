/**
 * Run: cd server && node --test core/media/configuredImageModel.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { HttpError } = require('../http/errors');
const { assertConfiguredImageModel } = require('./configuredImageModel.mts');

const MODELS = [{ id: 'gemini-3.1-flash-image-preview' }, { id: 'azure/icons-deploy' }];
const refusal = (fn) => { try { fn(); } catch (err) { return err; } return null; };

test('nothing configured is a 503, whatever the request names', () => {
    for (const model of [undefined, null, '', 'azure/icons-deploy']) {
        const err = refusal(() => assertConfiguredImageModel([], model));
        assert.ok(err instanceof HttpError, String(model));
        assert.strictEqual(err.status, 503);
        assert.strictEqual(err.code, 'image_generation_unavailable');
    }
});

test('a model that is not configured is a 400', () => {
    for (const model of ['azure/not-deployed', 'gemini-3-pro-preview', 'AZURE/icons-deploy']) {
        const err = refusal(() => assertConfiguredImageModel(MODELS, model));
        assert.ok(err instanceof HttpError, model);
        assert.strictEqual(err.status, 400);
        assert.strictEqual(err.code, 'image_model_unknown');
    }
});

test('a configured model, or none, passes', () => {
    assert.strictEqual(refusal(() => assertConfiguredImageModel(MODELS, 'azure/icons-deploy')), null);
    assert.strictEqual(refusal(() => assertConfiguredImageModel(MODELS, 'gemini-3.1-flash-image-preview')), null);
    assert.strictEqual(refusal(() => assertConfiguredImageModel(MODELS, undefined)), null);
});
