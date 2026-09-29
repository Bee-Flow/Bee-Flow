/**
 * What an app-publication row must and must not carry, plus a sweep over the
 * routes that change who can reach an app.
 *
 * The sweep is the part that keeps working: publishing was unaudited not
 * because anyone decided against it but because nothing said the route needed
 * it, and the same is true of the next exposure-changing route somebody adds.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rows = [];
const STORE = require.resolve('../stores/userStore.js');
require.cache[STORE] = {
    id: STORE, filename: STORE, loaded: true,
    exports: {
        logAccessAudit: async (action, targetType, targetId, changedBy, oldValues, newValues, organizationId) => {
            rows.push({ action, targetType, targetId, changedBy, oldValues, newValues, organizationId });
        },
    },
};

const audit = require('./publicationAudit');
test.after(() => { delete require.cache[STORE]; });
test.beforeEach(() => { rows.length = 0; });

const APP = { id: 'app_1', name: 'Expense claims', userId: 'usr_owner', organizationId: 'org_7' };

test('a publish records who could see it, in a word', () => {
    // The group ids answer "exactly who"; the word answers the question an
    // incident review actually opens with.
    assert.strictEqual(audit.audienceOf(true, []), 'organisation');
    assert.strictEqual(audit.audienceOf(true, ['grp_a']), 'groups');
    assert.strictEqual(audit.audienceOf(true, null), 'organisation');
    assert.strictEqual(audit.audienceOf(false, ['grp_a']), 'nobody', 'unpublished is not an audience');
});

test('publishing and unpublishing are different actions, not a flag', async () => {
    await audit.auditPublishChange({ app: APP, actorId: 'usr_owner', isPublished: true, sharedGroups: ['grp_a'], publishedVersion: 4 });
    await audit.auditPublishChange({ app: APP, actorId: 'usr_owner', isPublished: false, sharedGroups: [] });

    const [pub, unpub] = rows;
    assert.strictEqual(pub.action, 'studio_app_published');
    assert.strictEqual(unpub.action, 'studio_app_unpublished');
    // A query for "what went live in October" must not have to read a payload
    // field to find out whether a row is a publish.
    assert.notStrictEqual(pub.action, unpub.action);

    assert.strictEqual(pub.targetType, 'studio_app');
    assert.strictEqual(pub.targetId, 'app_1');
    assert.strictEqual(pub.organizationId, 'org_7');
    assert.strictEqual(pub.changedBy, 'usr_owner');
    assert.strictEqual(pub.newValues.ownerId, 'usr_owner');
    assert.strictEqual(pub.newValues.audience, 'groups');
    assert.deepStrictEqual(pub.newValues.sharedGroups, ['grp_a']);
    assert.strictEqual(pub.newValues.publishedVersion, 4);
});

test('a public-page row never carries the token', async () => {
    // The token IS the credential — anyone holding it opens the page. Writing
    // it into a table org admins read and support exports would hand back the
    // exact thing revoking is meant to take away.
    const token = 'pub_9f3c1ad277e84b0e93aa10cc4d2f6b81';
    await audit.auditPublicPage({ app: APP, actorId: 'usr_owner', token, created: true });

    const serialized = JSON.stringify(rows[0]);
    assert.ok(!serialized.includes(token), 'the public-page token reached the audit row');
    assert.strictEqual(rows[0].action, 'studio_app_public_page_created');
    // A prefix lines the row up against a URL somebody shows you, and opens
    // nothing on its own.
    assert.strictEqual(rows[0].newValues.tokenPrefix, 'pub_9f…');
    assert.ok(!serialized.includes('9f3c1ad2'), 'the prefix is long enough to be usable as a credential');
    assert.strictEqual(rows[0].newValues.reachableWithoutAccount, true);
});

test('revoking is recorded as its own action', async () => {
    await audit.auditPublicPage({ app: APP, actorId: 'usr_admin', token: 'pub_abc123def', created: false });
    assert.strictEqual(rows[0].action, 'studio_app_public_page_revoked');
    assert.strictEqual(rows[0].changedBy, 'usr_admin', 'who revoked it is the point of the row');
});

test('no row carries the app definition', async () => {
    // An audit trail that copies what it audits becomes a second place the data
    // lives, with different access rules and no retention story.
    const withContent = {
        ...APP,
        definition: { screens: [{ id: 's1', title: 'Salaries', components: [{ text: 'CONFIDENTIAL' }] }] },
        publishedDefinition: { screens: [] },
        builderSession: { chat: 'SECRET-BUILDER-CHAT' },
    };
    await audit.auditPublishChange({ app: withContent, actorId: 'usr_owner', isPublished: true, sharedGroups: [] });
    const serialized = JSON.stringify(rows[0]);
    assert.ok(!serialized.includes('CONFIDENTIAL'));
    assert.ok(!serialized.includes('SECRET-BUILDER-CHAT'));
    assert.ok(!serialized.includes('screens'));
    // The name is deliberately kept — without it the row is an opaque id.
    assert.strictEqual(rows[0].newValues.appName, 'Expense claims');
});

test('a broken audit store never fails a publish', async () => {
    const store = require('../stores/userStore');
    const original = store.logAccessAudit;
    store.logAccessAudit = async () => { throw new Error('audit table is gone'); };
    try {
        await audit.auditPublishChange({ app: APP, actorId: 'u', isPublished: true, sharedGroups: [] });
        await audit.auditPublicPage({ app: APP, actorId: 'u', token: 't', created: true });
        await audit.auditNextcloudMenu({ app: APP, actorId: 'u', enabled: true });
    } finally {
        store.logAccessAudit = original;
    }
});

test('every route that changes who can reach an app writes a row', () => {
    // studioApps.js is the only place publication state changes. The four
    // routes below are the ones that move an app between audiences; a fifth
    // would need adding here and in publicationAudit.js, and this fails naming
    // it rather than shipping an unlogged exposure change.
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/studioApps.js'), 'utf8');

    const EXPOSURE_ROUTES = [
        ["router.patch('/:id/publish'", 'auditPublishChange', 'publishing to the org or to groups'],
        ["router.post('/:id/public-pages'", 'auditPublicPage', 'minting an internet-reachable URL'],
        ["router.delete('/:id/public-pages/:token'", 'auditPublicPage', 'revoking that URL'],
        ["router.patch('/:id/nextcloud-menu'", 'auditNextcloudMenu', 'surfacing the app in the NC menu'],
    ];

    for (const [decl, call, why] of EXPOSURE_ROUTES) {
        const at = src.indexOf(decl);
        assert.ok(at > -1, `${decl} is gone — if the route moved, move this check with it`);
        // The handler runs to the next top-level router declaration.
        const next = src.indexOf('\nrouter.', at + 1);
        const body = src.slice(at, next === -1 ? src.length : next);
        assert.ok(
            body.includes(call),
            `the route that handles ${why} (${decl}) does not call publicationAudit.${call}. `
            + 'Changing who can reach an app is an access-control event and needs a row.',
        );
    }

    // And the module is required, not re-implemented per route.
    assert.match(src, /require\('\.\.\/appStudio\/publicationAudit'\)/);
});
