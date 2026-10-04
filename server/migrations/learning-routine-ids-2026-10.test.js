/**
 * learning-routine-ids-2026-10: a person's Learning Center progress follows
 * the lessons renamed from "routine" to "automation".
 *
 * Run: cd server && node --test migrations/learning-routine-ids-2026-10.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { renameIds, ID_MAP } = require('./learning-routine-ids-2026-10');

test('progress keyed by an old lesson id moves to the new id, other lessons stay', () => {
    const changed = { n: 0 };
    const out = renameIds({
        'routine-extra-triggers': { completedAt: '2026-09-01' },
        'getting-started': { completedAt: '2026-08-01' },
    }, changed);
    assert.deepEqual(out, {
        'automation-extra-triggers': { completedAt: '2026-09-01' },
        'getting-started': { completedAt: '2026-08-01' },
    });
    assert.equal(changed.n, 1);
});

test('ids inside lists and values follow too, and nothing that merely contains the word does', () => {
    const out = renameIds({ badges: ['badge-routine-master', 'badge-x'], note: 'my routine-extra-triggers notes', course: 'course-routines-production' });
    assert.deepEqual(out, { badges: ['badge-automation-master', 'badge-x'], note: 'my routine-extra-triggers notes', course: 'course-automations-production' });
});

test('when both spellings exist the new one wins', () => {
    const out = renameIds({ 'routine-shield-step': { completedAt: 'old' }, 'automation-shield-step': { completedAt: 'new' } });
    assert.deepEqual(out, { 'automation-shield-step': { completedAt: 'new' } });
});

test('a second pass changes nothing', () => {
    const once = renameIds({ 'routine-reusable-steps': {} });
    const changed = { n: 0 };
    assert.deepEqual(renameIds(once, changed), once);
    assert.equal(changed.n, 0);
});

test('every new id exists in the generated catalog, and no old one does', () => {
    const catalog = fs.readFileSync(path.join(__dirname, '..', 'learning', 'catalog.generated.js'), 'utf8');
    for (const [oldId, newId] of Object.entries(ID_MAP)) {
        assert.ok(!catalog.includes(`"${oldId}"`), `${oldId} is still in the catalog`);
        if (/^(course|badge|ex)-|^routine|^apps-/.test(oldId) && !/^(has|pick)-|dry-run|has-approval|writes-table|extra-trigger$|-kb$/.test(oldId)) {
            assert.ok(catalog.includes(`"${newId}"`), `${newId} is missing from the catalog`);
        }
    }
});
