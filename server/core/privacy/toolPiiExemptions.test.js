/**
 * Per-app exceptions to the tool block lists (core/privacy/toolPiiExemptions.mts):
 * which list holds for one call, what a save may send, what the row keeps, and
 * the audit diff. The registry's attribution index is replaced through `_deps`
 * with a synthetic one: outlook and gmail own a tool each, outlook-readonly
 * lends its names to outlook.
 *
 * Run: cd server && node --test core/privacy/toolPiiExemptions.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ex = require('./toolPiiExemptions.mts');

const OWNER = { outlook_compose: 'outlook', gmail_compose: 'gmail' };
const ACTIONS = { outlook: ['outlook_compose'], gmail: ['gmail_compose'], 'outlook-readonly': ['outlook_compose'] };
const realIndex = ex._deps.appIndex;
test.beforeEach(() => {
    ex._deps.appIndex = () => ({
        appIdForTool: (name) => OWNER[name] || null,
        actionsOfApp: (app) => ACTIONS[app] || [],
        appDefersGrants: (app) => app === 'outlook-readonly',
    });
});
test.after(() => { ex._deps.appIndex = realIndex; });

const EXTERNAL = {
    blockCategories: ['Person', 'Email', 'InternationalBankingAccountNumber', 'ApiKeyOrSecret'],
    appExemptions: { outlook: ['Person', 'Email'] },
};

test('the exempt app loses only its own categories from the list', () => {
    assert.deepEqual(ex.effectiveBlockCategories(EXTERNAL, 'outlook_compose'), ['InternationalBankingAccountNumber', 'ApiKeyOrSecret']);
});

test('another app of the same class keeps the whole list', () => {
    assert.deepEqual(ex.effectiveBlockCategories(EXTERNAL, 'gmail_compose'), EXTERNAL.blockCategories);
});

test('a tool whose app is unknown gets no exception (fail closed)', () => {
    assert.deepEqual(ex.effectiveBlockCategories(EXTERNAL, 'notebook_write'), EXTERNAL.blockCategories);
    assert.deepEqual(ex.effectiveBlockCategories(EXTERNAL, undefined), EXTERNAL.blockCategories);
    ex._deps.appIndex = () => { throw new Error('registry unreadable'); };
    assert.deepEqual(ex.effectiveBlockCategories(EXTERNAL, 'outlook_compose'), EXTERNAL.blockCategories);
});

test('a class without exceptions hands back its own list, unchanged', () => {
    const plain = { blockCategories: ['Person'] };
    assert.equal(ex.effectiveBlockCategories(plain, 'outlook_compose'), plain.blockCategories);
    assert.deepEqual(ex.effectiveBlockCategories(undefined, 'outlook_compose'), []);
});

test('a hard category is never subtracted, even from a row that holds it as an exception', () => {
    const edited = { blockCategories: ['ApiKeyOrSecret', 'PassportNumber', 'DriversLicenseNumber', 'Email'], appExemptions: { outlook: ['ApiKeyOrSecret', 'PassportNumber', 'DriversLicenseNumber', 'Email'] } };
    assert.deepEqual(ex.effectiveBlockCategories(edited, 'outlook_compose'), ['ApiKeyOrSecret', 'PassportNumber', 'DriversLicenseNumber']);
    assert.deepEqual([...ex.HARD_BLOCKED_CATEGORIES].sort(), ['ApiKeyOrSecret', 'DriversLicenseNumber', 'PassportNumber']);
});

test('the save schema accepts a known app with known categories, an own type id included', () => {
    const r = ex.AppExemptionsSchema.safeParse({ outlook: ['Person', 'Email', 'cdt_0123456789'] });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test('the save schema refuses hard categories, unknown apps, unknown categories and too much', () => {
    const messages = (v) => {
        const r = ex.AppExemptionsSchema.safeParse(v);
        assert.equal(r.success, false);
        return r.error.issues.map(i => i.message).join(' | ');
    };
    assert.match(messages({ outlook: ['ApiKeyOrSecret'] }), /never be released/);
    assert.match(messages({ outlook: ['PassportNumber'] }), /never be released/);
    assert.match(messages({ 'not-an-app': ['Person'] }), /not an app/);
    assert.match(messages({ 'outlook-readonly': ['Person'] }), /not an app/);
    assert.match(messages({ outlook: ['Nonsense'] }), /not a kind of personal data/);
    assert.match(messages({ outlook: ['Person'], gmail: 'Person' }), /appExemptions is/);
    const many = Object.fromEntries(Array.from({ length: ex.MAX_EXEMPT_APPS_PER_CLASS + 1 }, (_, i) => [`app-${i}`, ['Person']]));
    assert.match(messages(many), /at most 50 apps/);
    assert.match(messages({ outlook: Array(ex.MAX_EXEMPT_CATEGORIES_PER_APP + 1).fill('Person') }), /at most 64/);
});

test('the stored form keeps only blocked, non-hard categories and drops empty entries', () => {
    assert.deepEqual(
        ex.normaliseAppExemptions({ outlook: ['Person', 'Medication', 'ApiKeyOrSecret', 'Person'], gmail: ['Medication'], x: 'Person' }, ['Person', 'ApiKeyOrSecret']),
        { outlook: ['Person'] },
    );
    assert.equal(ex.normaliseAppExemptions({ outlook: ['Person'] }, []), null);
    assert.equal(ex.normaliseAppExemptions(undefined, ['Person']), null);
    assert.equal(ex.normaliseAppExemptions(['Person'], ['Person']), null);
});

test('the audit diff names class, app and category keys, nothing else', () => {
    const before = { external: { appExemptions: { outlook: ['Person'] } } };
    const after = { external: { appExemptions: { outlook: ['Email'], gmail: ['Person'] } }, internal: {} };
    assert.deepEqual(ex.exemptionChanges(before, after), [
        { toolClass: 'external', appId: 'gmail', added: ['Person'], removed: [] },
        { toolClass: 'external', appId: 'outlook', added: ['Email'], removed: ['Person'] },
    ]);
    assert.deepEqual(ex.exemptionChanges(after, after), []);
    assert.deepEqual(ex.exemptionChanges(null, undefined), []);
});
