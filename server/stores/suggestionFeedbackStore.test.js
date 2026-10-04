'use strict';

/**
 * automation_suggestion_feedback against a real Postgres (pglite), through
 * the store's own SQL. What is pinned: per-user scope, signature keys, the
 * snoozed/opened lifetimes, the reason codes, the template-only allow-list in
 * suggestion_json, Art. 17 erasure and the prune.
 *
 * Run: cd server && node --test stores/suggestionFeedbackStore.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { DDL, deriveScopeKey, toStoredSuggestion, makeSuggestionFeedbackStore } = require('./suggestionFeedbackStore');

const { pg, db } = pgliteDb();
const store = makeSuggestionFeedbackStore(db);

before(async () => { await pg.exec(DDL); await pg.exec(DDL); });
after(() => pg.close());

test('the scope is the user, never the organisation', () => {
    assert.strictEqual(deriveScopeKey({ organizationId: 'org1', userId: 'u1' }), 'user:u1');
    assert.strictEqual(deriveScopeKey({}), 'anon');
});

test('suggestion_json keeps only the allow-listed, template-safe fields', async () => {
    const row = await store.saveSuggestionFeedback({
        userId: 'u1', organizationId: 'org1', action: 'built', titleFingerprint: 'fp1',
        suggestion: {
            title: 'Weekly invoice to sheet',
            buildPrompt: 'Mail jan@example.com every Monday',
            description: 'from Jan Jansen',
            evidence: { sender: 'jan@example.com' },
            pattern: { kind: 'mail_template', signature: 'sig-1', apps: ['gmail', 'sheets'], template: 'Invoice <n> for <org>', draft: { x: 1 } },
        },
    });
    assert.deepStrictEqual(row.suggestion, {
        title: 'Weekly invoice to sheet', kind: 'mail_template', signature: 'sig-1',
        apps: ['gmail', 'sheets'], template: 'Invoice <n> for <org>',
    });
    const { rows } = await pg.query(`SELECT suggestion_json::text AS j FROM automation_suggestion_feedback WHERE id = $1`, [row.id]);
    assert.ok(!rows[0].j.includes('@'), 'an e-mail address reached the stored row');
    assert.ok(!rows[0].j.includes('Jansen'));
});

test('the client\'s echo is not trusted: a raw subject or an address in template or title is masked before it is stored', async () => {
    const row = await store.saveSuggestionFeedback({
        userId: 'u1', organizationId: 'org1', action: 'dismissed', titleFingerprint: 'fp-raw',
        suggestion: {
            title: 'Forward mail from billing@acme-supplies.example to acme-supplies.nl',
            pattern: { kind: 'mail_template', template: 'Factuur 4711 van pieter@acme-supplies.example via https://acme.example/x of acme-supplies.nl' },
        },
    });
    assert.strictEqual(row.suggestion.template, 'Factuur <n> van <email> via <url> of <domain>');
    assert.strictEqual(row.suggestion.title, 'Forward mail from an email address to a website');
    assert.strictEqual(row.title, 'Forward mail from an email address to a website');
    const { rows } = await pg.query(`SELECT suggestion_json::text AS j, title FROM automation_suggestion_feedback WHERE id = $1`, [row.id]);
    assert.doesNotMatch(rows[0].j + rows[0].title, /@|acme|4711|https?:/);
});

test('toStoredSuggestion returns null for nothing usable', () => {
    assert.strictEqual(toStoredSuggestion(null), null);
    assert.strictEqual(toStoredSuggestion({ buildPrompt: 'x' }), null);
});

test('one user\'s feedback never suppresses for a colleague in the same org', async () => {
    await store.saveSuggestionFeedback({ userId: 'ua', organizationId: 'org1', action: 'dismissed', titleFingerprint: 'fpx', suggestion: { title: 'Shared idea' } });
    assert.deepStrictEqual(await store.getRecentSuppressedTitles({ organizationId: 'org1', userId: 'ub' }), []);
    assert.deepStrictEqual(await store.getRecentSuppressedTitles({ organizationId: 'org1', userId: 'ua' }), ['Shared idea']);
});

test('a signature keys the row and is returned with action and reason code', async () => {
    const first = await store.saveSuggestionFeedback({ userId: 'us', action: 'dismissed', reasonCode: 'do_myself', signature: 'abc', suggestion: { title: 'T1' } });
    assert.strictEqual(first.id, 'user:us:sig:abc');
    const again = await store.saveSuggestionFeedback({ userId: 'us', action: 'dismissed', reasonCode: 'wrong_grouping', signature: 'abc', suggestion: { title: 'T1 reworded' } });
    assert.strictEqual(again.id, first.id, 'the same signature must update the same row');
    assert.deepStrictEqual(await store.getSuppressedSignatures({ userId: 'us' }), [
        { signature: 'abc', action: 'dismissed', reasonCode: 'wrong_grouping' },
    ]);
    assert.deepStrictEqual(await store.getSuppressedSignatures({ userId: 'other' }), []);
});

test('snoozed expires after the TTL and stamps snooze_until', async () => {
    const row = await store.saveSuggestionFeedback({ userId: 'uz', action: 'snoozed', signature: 'snz', suggestion: { title: 'Later' } });
    assert.ok(row.expiresAt && row.snoozeUntil);
    const days = (Date.parse(row.expiresAt) - Date.now()) / 86400_000;
    assert.ok(days > 29 && days <= 30.01, `expected ~30 days, got ${days}`);
    assert.strictEqual(row.snoozeUntil, row.expiresAt);
});

test('opened is never a suppression and never downgrades a built row', async () => {
    await store.saveSuggestionFeedback({ userId: 'uo', action: 'opened', signature: 'op', suggestion: { title: 'Clicked' } });
    assert.deepStrictEqual(await store.getSuppressedSignatures({ userId: 'uo' }), []);
    assert.deepStrictEqual(await store.getRecentSuppressedTitles({ userId: 'uo' }), []);

    await store.saveSuggestionFeedback({ userId: 'uo', action: 'built', signature: 'op' });
    const after = await store.saveSuggestionFeedback({ userId: 'uo', action: 'opened', signature: 'op' });
    assert.strictEqual(after.action, 'built');
    assert.strictEqual(after.expiresAt, null, 'built stays permanent');
    assert.strictEqual(after.title, 'Clicked', 'an update without a title keeps the stored one');
});

test('invalid action, invalid reason code and a missing key are rejected', async () => {
    await assert.rejects(store.saveSuggestionFeedback({ userId: 'u', action: 'nuked', signature: 's' }), /Invalid suggestion feedback action/);
    await assert.rejects(store.saveSuggestionFeedback({ userId: 'u', action: 'dismissed', reasonCode: 'meh', signature: 's' }), /reason code/);
    await assert.rejects(store.saveSuggestionFeedback({ userId: 'u', action: 'dismissed' }), /signature or titleFingerprint/);
});

test('purgeForUser erases every row of the user only', async () => {
    await store.saveSuggestionFeedback({ userId: 'gone', action: 'built', signature: 'g1' });
    await pg.query(`INSERT INTO automation_suggestion_feedback (id, user_id, organization_id, title_fingerprint, action)
                    VALUES ('org:o1:legacy', 'gone', 'o1', 'legacy', 'asked')`);
    await store.saveSuggestionFeedback({ userId: 'stays', action: 'built', signature: 'g1' });
    assert.strictEqual(await store.purgeForUser('gone'), 2);
    assert.strictEqual((await store.getSuppressedSignatures({ userId: 'stays' })).length, 1);
});

test('pruneExpired reaps lapsed rows and keeps permanent ones', async () => {
    await pg.query(`INSERT INTO automation_suggestion_feedback (id, user_id, title_fingerprint, action, expires_at)
                    VALUES ('user:p:old', 'p', 'old', 'dismissed', NOW() - interval '1 day')`);
    await store.saveSuggestionFeedback({ userId: 'p', action: 'built', signature: 'keep' });
    assert.strictEqual(await store.pruneExpired(), 1);
    assert.strictEqual((await store.getSuppressedSignatures({ userId: 'p' })).length, 1);
});
