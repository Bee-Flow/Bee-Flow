'use strict';

/**
 * appRefOwnerVerdict: under WHOSE name an automation is created that is made from an app button.
 *
 * The rule is not cosmetic. A `run_automation` action runs the automation AS THE OWNER of the app
 * (appStudio/actionExecutor/automationBridge.js refuses when the owners differ), so who owns the
 * new automation determines with whose rights it later runs. There are two ways to get that wrong:
 * under the clicker (the button is broken from the moment it is wired), or under the app owner
 * while someone ELSE clicks (then that someone has just written an automation that runs with
 * someone else's rights). Both are refused; only "the same person" goes through.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/appRefLookup.owner.test.js
 * Pure: no DB, no route, no session.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { appRefOwnerVerdict, OWNER_REFUSALS } = require('./appRefLookup');

const OWNER = 'user-owner';
const OTHER = 'user-other';
const APP = Object.freeze({ id: 'app-1', userId: OWNER, name: 'Expense claims' });

describe('de klikker IS de app-eigenaar', () => {
    test('gaat door, en noemt de eigenaar waaronder de automatisering hoort te landen', () => {
        const got = appRefOwnerVerdict({ app: APP, actorUserId: OWNER });
        assert.deepEqual(got, { ok: true, ownerId: OWNER });
    });

    test('de eigenaar komt van de APP-RIJ, niet van de klikker', () => {
        // The same value in the successful case, but it comes from the
        // only object that can give the answer. A route that uses this field
        // writes the rule down instead of accepting it.
        const got = appRefOwnerVerdict({ app: { ...APP, userId: OWNER }, actorUserId: OWNER });
        assert.equal(got.ownerId, APP.userId);
    });
});

describe('elke andere uitkomst is een weigering', () => {
    test('een andere eigenaar: geweigerd, met de reden erbij', () => {
        const got = appRefOwnerVerdict({ app: APP, actorUserId: OTHER });
        assert.equal(got.ok, false);
        assert.equal(got.code, 'owner_mismatch');
        assert.equal(got.message, OWNER_REFUSALS.owner_mismatch);
        assert.equal(got.ownerId, undefined, 'een weigering draagt geen eigenaar om alsnog te gebruiken');
    });

    test('geen app-rij — weg, of onleesbaar — is een weigering, geen gok', () => {
        // The caller turns a failed read into `app: null`. Both cases
        // arrive here as the same thing, and the answer is the same:
        // unknown narrows.
        const got = appRefOwnerVerdict({ app: null, actorUserId: OWNER });
        assert.equal(got.ok, false);
        assert.equal(got.code, 'app_unknown');
        assert.match(got.message, /could not be read/);
    });

    test('een app-rij zonder eigenaar wordt niet aan de klikker toegewezen', () => {
        for (const broken of [{ ...APP, userId: null }, { ...APP, userId: '' }, { id: 'app-1' }]) {
            const got = appRefOwnerVerdict({ app: broken, actorUserId: OWNER });
            assert.equal(got.ok, false, `userId=${JSON.stringify(broken.userId)} hoort te weigeren`);
            assert.equal(got.code, 'owner_unknown');
        }
    });

    test('een onbekende klikker is een weigering, niet "dan maar de eigenaar"', () => {
        for (const actor of [null, undefined, '', 42]) {
            const got = appRefOwnerVerdict({ app: APP, actorUserId: actor });
            assert.equal(got.ok, false, `actor=${JSON.stringify(actor)} hoort te weigeren`);
            assert.equal(got.code, 'actor_unknown');
        }
    });

    test('helemaal geen argumenten weigert ook', () => {
        assert.equal(appRefOwnerVerdict().ok, false);
        assert.equal(appRefOwnerVerdict({}).ok, false);
    });

    test('elke code heeft een zin die uitlegt waarom', () => {
        // "Refuses with an explanation" is the instruction. A code without a sentence is an
        // error message that is blank on screen.
        for (const [code, message] of Object.entries(OWNER_REFUSALS)) {
            assert.equal(typeof message, 'string', `${code} heeft geen zin`);
            assert.ok(message.trim().length > 20, `${code} legt niets uit: ${message}`);
        }
    });
});
