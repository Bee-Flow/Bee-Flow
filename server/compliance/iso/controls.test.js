'use strict';

/**
 * ISO control catalogue — a control whose only checks read an external
 * connector sits in the 'connector' bucket ('auto' means verifiable from Bee
 * Flow's own DB/config). A.6.5 stays 'auto': the project-orphaned-content
 * check verifies it from the database, next to the AFAS connector check.
 *
 * Run: cd server && node --test compliance/iso/controls.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CONTROLS } = require('./controls');

const bucketOf = (ref) => CONTROLS.find(c => c.ref === ref)?.bucket;

test('mail security and identity hygiene are connector-verified controls', () => {
    assert.equal(bucketOf('A.5.14'), 'connector', 'only the mail-security DNS probe checks it');
    assert.equal(bucketOf('A.5.16'), 'connector', 'only the Google/Entra connectors check it');
});

test('A.6.5 keeps a check from the own database, so it stays auto', () => {
    assert.equal(bucketOf('A.6.5'), 'auto');
});
