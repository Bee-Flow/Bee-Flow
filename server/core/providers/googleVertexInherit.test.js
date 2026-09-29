/**
 * Unit — Vertex inherits chat/stream/generateImage from GoogleProvider (H9).
 * Proves the overrides are gone (same function reference as the base), that
 * createClient stays overridden, and the cache gate differs. DB-free — the
 * @google/genai SDK is only required lazily inside the methods, not at load.
 * Run: node --test core/providers/googleVertexInherit.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const GoogleProvider = require('./google');
const GoogleVertexProvider = require('./googleVertex');

const g = new GoogleProvider();
const v = new GoogleVertexProvider();

test('Vertex no longer overrides chat/stream/generateImage (inherits the base)', () => {
    assert.strictEqual(v.chat, g.chat, 'chat is the inherited base method');
    assert.strictEqual(v.stream, g.stream, 'stream is the inherited base method');
    assert.strictEqual(v.generateImage, g.generateImage, 'generateImage is the inherited base method');
});

test('Vertex still overrides createClient (options-aware auth)', () => {
    assert.notStrictEqual(v.createClient, g.createClient, 'createClient is Vertex-specific');
});

test('Vertex keeps its own listModels and generateMusic', () => {
    assert.notStrictEqual(v.listModels, g.listModels);
    assert.notStrictEqual(v.generateMusic, g.generateMusic);
});

test('context-cache gate: Google supports it, Vertex does not', () => {
    assert.strictEqual(g._supportsExplicitCache(), true);
    assert.strictEqual(v._supportsExplicitCache(), false);
});
