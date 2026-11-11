'use strict';

/**
 * A code step on a public page: the anonymous visitor's browser gets its kind, resultVar and
 * error handling, never its source or its inputs, and the anonymous step route lets it through
 * (its policy says public: 'step'). Driven by the corpus app that uses it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicAccess = require('./publicAccess');
const { publicStepRefusal } = require('../routes/studioAppPublicStepGate.mts');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'compat/corpus/v3-code-step-quote.json'), 'utf8'));

test('the public definition carries no code source and no input bindings', () => {
    const def = corpus.definition;
    const step = def.actions.act_cqquote.steps[0];
    assert.equal(step.kind, 'code');
    assert.ok(step.code.includes('function main'));
    const pub = publicAccess.buildPublicDefinition(def, publicAccess.resolvePublicSurface(def));
    const sent = JSON.stringify(pub);
    assert.ok(!sent.includes('function main'), 'the source reached the browser');
    assert.ok(!sent.includes('tbl_cqitem'), 'an input binding reached the browser');
    assert.ok(!sent.includes('timeoutMs'));
    assert.deepEqual(pub.actions.act_cqquote.steps[0], {
        kind: 'code', resultVar: 'quote',
        onError: { steps: [{ kind: 'toast', message: 'The quote could not be worked out.', tone: 'danger' }], stop: true },
    });
});

test('the step keeps its ordinal for the visitor, and the anonymous step route accepts the kind', () => {
    const def = corpus.definition;
    const pub = publicAccess.buildPublicDefinition(def, publicAccess.resolvePublicSurface(def));
    assert.deepEqual(pub.actions.act_cqquote.steps.map((s) => s.kind), def.actions.act_cqquote.steps.map((s) => s.kind));
    assert.equal(publicStepRefusal('code'), null);
});
