'use strict';

/**
 * Regression: the Nextcloud file.new trigger must fire when a file APPEARS in
 * the watched folder — including files MOVED / COPIED / RENAMED in, not just
 * fresh uploads. Nextcloud reports a move as `file_changed` (+ "moved … to"
 * subject), so the file.new detector reads the subject for arrivals while
 * leaving plain in-place edits to file.changed only.
 *
 * Run: node --test automation/triggerBus.ncfilenew.test.js
 */

const { test } = require('node:test');
const assert = require('assert');
const { _ncNormaliseActivity } = require('./triggerBus');

const norm = (row) => _ncNormaliseActivity(row, {});

test('fresh upload (file_created) → file.new', () => {
    const p = norm({ id: 1, type: 'file_created', subject: 'You created Invoice.pdf', object_name: '/Invoices/test/Invoice.pdf', objectName: '/Invoices/test/Invoice.pdf' });
    assert.strictEqual(p._isFileCreated, true);
});

test('file MOVED into the folder (file_changed, "moved … to") → file.new', () => {
    const p = norm({ id: 2, type: 'file_changed', subject: 'You moved Invoices/Factuur_255066638.pdf to Invoices/test', objectName: '/Invoices/test/Factuur_255066638.pdf' });
    assert.strictEqual(p._isFileCreated, true, 'a moved-in file is a new arrival → file.new');
});

test('Dutch move subject ("verplaatst") → file.new', () => {
    const p = norm({ id: 3, type: 'file_changed', subject: 'Je hebt Factuur.pdf verplaatst naar Invoices/test', objectName: '/Invoices/test/Factuur.pdf' });
    assert.strictEqual(p._isFileCreated, true);
});

test('copied / restored / renamed → file.new', () => {
    assert.strictEqual(norm({ id: 4, type: 'file_changed', subject: 'You copied X.pdf', objectName: '/Invoices/test/X.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 5, type: 'file_restored', subject: 'You restored X.pdf', objectName: '/Invoices/test/X.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 6, type: 'file_changed', subject: 'You renamed A.pdf to B.pdf', objectName: '/Invoices/test/B.pdf' })._isFileCreated, true);
});

test('plain in-place EDIT (file_changed, "changed") is NOT file.new', () => {
    const p = norm({ id: 7, type: 'file_changed', subject: 'You changed Invoice.pdf', objectName: '/Invoices/test/Invoice.pdf' });
    assert.strictEqual(p._isFileCreated, false, 'an edit must stay file.changed only');
    assert.strictEqual(p._isFileChanged, true);
});

test('path + name + extension are normalised from objectName', () => {
    const p = norm({ id: 8, type: 'file_created', subject: 'created', objectName: '/Invoices/test/Factuur.pdf' });
    assert.strictEqual(p.path, '/Invoices/test/Factuur.pdf');
    assert.strictEqual(p.name, 'Factuur.pdf');
    assert.strictEqual(p.extension, 'pdf');
});

console.log('✓ triggerBus.ncfilenew.test.js — all assertions passed');
