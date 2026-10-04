/**
 * describeAppRef — the three answers a back-pointer can have, per viewer.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/appRefLookup.test.js
 * Pure — no DB, no route, no session.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { describeAppRef, nodeOwnText } = require('./appRefLookup');

const OWNER = 'user-owner';
const OTHER = 'user-other';

const APP = Object.freeze({
    id: 'app-1',
    userId: OWNER,
    name: '  Expense claims  ',
    definition: {
        screens: [
            {
                id: 'scr_dash01',
                name: 'Dashboard',
                sections: [{
                    id: 'sec_main01',
                    children: [
                        { id: 'cmp_btn123', type: 'button', props: { label: 'Submit claim' } },
                        { id: 'cmp_card01', type: 'card', props: { title: 'Totals' }, children: [
                            { id: 'cmp_deep01', type: 'button', props: { label: 'Nested' } },
                        ] },
                        { id: 'cmp_bare01', type: 'button', props: {} },
                    ],
                }],
            },
            { id: 'scr_othr01', name: 'Archive', sections: [{ id: 'sec_arch01', children: [] }] },
        ],
    },
});

const REF = Object.freeze({ appId: 'app-1', screenId: 'scr_dash01', nodeId: 'cmp_btn123' });

describe('the viewer owns the app', () => {
    test('names all three, and says the link will open', () => {
        const got = describeAppRef({ app: APP, ref: REF, viewerUserId: OWNER });
        assert.equal(got.status, 'ok');
        assert.equal(got.appName, 'Expense claims'); // trimmed
        assert.equal(got.screenName, 'Dashboard');
        assert.equal(got.nodeLabel, 'Submit claim');
        assert.equal(got.canOpen, true);
    });

    test('finds a button nested inside a container', () => {
        const got = describeAppRef({ app: APP, ref: { ...REF, nodeId: 'cmp_deep01' }, viewerUserId: OWNER });
        assert.equal(got.status, 'ok');
        assert.equal(got.nodeLabel, 'Nested');
    });

    test('a button with no text of its own resolves, but is not given an invented name', () => {
        const got = describeAppRef({ app: APP, ref: { ...REF, nodeId: 'cmp_bare01' }, viewerUserId: OWNER });
        assert.equal(got.status, 'ok');
        assert.equal(got.nodeLabel, null);
    });
});

describe('the pointer no longer points anywhere', () => {
    test('no app row at all → app_missing, no names, no link', () => {
        const got = describeAppRef({ app: null, ref: REF, viewerUserId: OWNER });
        assert.equal(got.status, 'app_missing');
        assert.equal(got.appName, null);
        assert.equal(got.canOpen, false);
        // The ids still come back: the card shows them, which is the only
        // honest thing left to say about an automation that still fires.
        assert.equal(got.appId, 'app-1');
        assert.equal(got.screenId, 'scr_dash01');
    });

    test('screen deleted → screen_missing, the app is still named and still openable', () => {
        const got = describeAppRef({ app: APP, ref: { ...REF, screenId: 'scr_gone01' }, viewerUserId: OWNER });
        assert.equal(got.status, 'screen_missing');
        assert.equal(got.appName, 'Expense claims');
        assert.equal(got.screenName, null);
        assert.equal(got.canOpen, true);
    });

    test('button deleted → node_missing, app and screen still named', () => {
        const got = describeAppRef({ app: APP, ref: { ...REF, nodeId: 'cmp_gone01' }, viewerUserId: OWNER });
        assert.equal(got.status, 'node_missing');
        assert.equal(got.screenName, 'Dashboard');
        assert.equal(got.nodeLabel, null);
    });

    test('button MOVED to another screen is node_missing, not ok', () => {
        // The breadcrumb would otherwise read "Expense claims › Archive ›
        // Submit claim" for a button that is not on Archive at all. A wrong
        // breadcrumb is worse than one that admits the button is not there.
        const got = describeAppRef({ app: APP, ref: { appId: 'app-1', screenId: 'scr_othr01', nodeId: 'cmp_btn123' }, viewerUserId: OWNER });
        assert.equal(got.status, 'node_missing');
        assert.equal(got.screenName, 'Archive');
    });
});

describe('the viewer does not own the app — unknown narrows', () => {
    test('another user gets ids only: no name, no link, no reason', () => {
        const got = describeAppRef({ app: APP, ref: REF, viewerUserId: OTHER });
        assert.equal(got.status, 'restricted');
        assert.equal(got.appName, null);
        assert.equal(got.screenName, null);
        assert.equal(got.nodeLabel, null);
        assert.equal(got.canOpen, false);
        assert.equal(got.appId, 'app-1');
    });

    test('no session at all is refused the same way', () => {
        assert.equal(describeAppRef({ app: APP, ref: REF, viewerUserId: null }).status, 'restricted');
        assert.equal(describeAppRef({ app: APP, ref: REF }).status, 'restricted');
    });

    test('a non-owner cannot tell a deleted screen from an intact one', () => {
        // Both answers are the same word. Distinguishing them would leak the
        // shape of someone else's app one probe at a time.
        const intact = describeAppRef({ app: APP, ref: REF, viewerUserId: OTHER });
        const gone = describeAppRef({ app: APP, ref: { ...REF, screenId: 'scr_gone01' }, viewerUserId: OTHER });
        assert.equal(intact.status, 'restricted');
        assert.equal(gone.status, 'restricted');
    });
});

describe('edges', () => {
    test('a ref with no node level resolves down to the screen', () => {
        const got = describeAppRef({ app: APP, ref: { appId: 'app-1', screenId: 'scr_dash01' }, viewerUserId: OWNER });
        assert.equal(got.status, 'ok');
        assert.equal(got.nodeId, null);
        assert.equal(got.nodeLabel, null);
    });

    test('an app with no name and a screen with no name yield nulls, never empty strings', () => {
        const app = { ...APP, name: '   ', definition: { screens: [{ id: 'scr_dash01', name: '', sections: [] }] } };
        const got = describeAppRef({ app, ref: { appId: 'app-1', screenId: 'scr_dash01' }, viewerUserId: OWNER });
        assert.equal(got.appName, null);
        assert.equal(got.screenName, null);
    });

    test('nodeOwnText reads the naming props in inspector order', () => {
        assert.equal(nodeOwnText({ props: { label: 'L', title: 'T', text: 'X' } }), 'L');
        assert.equal(nodeOwnText({ props: { title: 'T', text: 'X' } }), 'T');
        assert.equal(nodeOwnText({ props: { heading: 'H' } }), 'H');
        assert.equal(nodeOwnText({ props: { label: '   ' } }), null);
        assert.equal(nodeOwnText(null), null);
    });
});
