'use strict';

/**
 * Compat corpus: every stored app passes every definition gate (definitionGate.mts and the
 * stage-prepare gate built on it) with the verdict ok or warn, never refuse, and comes out
 * byte for byte as it went in. A refusal here is a stored app that no longer installs,
 * upgrades, deploys or restores.
 *
 * Run: cd server && node --test appStudio/compat/gates.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { corpusNames, readCorpus } = require('./corpus.mts');
const { gateDefinition } = require('../definitionGate.mts');
const { gateReleaseApps } = require('../../projects/appDefinitionGate.mts');

for (const name of corpusNames()) {
    test(`${name}: passes the definition gate`, () => {
        const { definition } = readCorpus(name);
        const before = JSON.stringify(definition);
        const gate = gateDefinition(definition);
        assert.ok(gate.verdict === 'ok' || gate.verdict === 'warn', `${name}: ${gate.verdict} ${JSON.stringify(gate.errors)}`);
        assert.equal(gate.refused, null);
        assert.equal(JSON.stringify(definition), before, `${name}: the gate changed the definition`);
    });

    test(`${name}: does not block a stage deployment`, () => {
        const { definition } = readCorpus(name);
        const before = JSON.stringify(definition);
        const out = gateReleaseApps([{ ref: 'app_1', kind: 'app', entity: { definition } }]);
        assert.deepEqual(out.blocking, []);
        for (const f of out.warnings) assert.equal(f.severity, 'warning');
        assert.equal(JSON.stringify(definition), before);
    });
}
