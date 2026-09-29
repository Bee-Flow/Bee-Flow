'use strict';

/**
 * appRefOwnerVerdict — onder WIENS naam een routine ontstaat die vanuit een
 * app-knop wordt gemaakt.
 *
 * De regel is niet cosmetisch. Een `run_automation`-actie draait de routine
 * ALS DE EIGENAAR van de app (appStudio/actionExecutor/automationBridge.js
 * weigert bij ongelijke eigenaars), dus wie de nieuwe routine bezit bepaalt
 * met wiens rechten hij straks draait. Twee manieren om dat fout te doen:
 * onder de klikker (de knop is stuk vanaf het moment dat hij bedraad wordt) of
 * onder de app-eigenaar terwijl iemand ánders klikt (dan heeft die iemand
 * zojuist een routine geschreven die met andermans rechten draait). Allebei
 * weigeren; alleen "dezelfde persoon" gaat door.
 *
 * Draaien: cd server && node --test --test-reporter=tap appStudio/appRefLookup.owner.test.js
 * Puur — geen DB, geen route, geen sessie.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { appRefOwnerVerdict, OWNER_REFUSALS } = require('./appRefLookup');

const OWNER = 'user-owner';
const OTHER = 'user-other';
const APP = Object.freeze({ id: 'app-1', userId: OWNER, name: 'Expense claims' });

describe('de klikker IS de app-eigenaar', () => {
    test('gaat door, en noemt de eigenaar waaronder de routine hoort te landen', () => {
        const got = appRefOwnerVerdict({ app: APP, actorUserId: OWNER });
        assert.deepEqual(got, { ok: true, ownerId: OWNER });
    });

    test('de eigenaar komt van de APP-RIJ, niet van de klikker', () => {
        // Dezelfde waarde in het geslaagde geval — maar hij komt uit het
        // enige object dat het antwoord kán geven. Een route die dit veld
        // gebruikt schrijft de regel op in plaats van hem aan te nemen.
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
        // De aanroeper zet een mislukte lees om in `app: null`. Beide gevallen
        // komen hier als hetzelfde binnen, en het antwoord is hetzelfde:
        // onbekend versmalt.
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
        // "Weigert met uitleg" is de opdracht. Een code zonder zin is een
        // foutmelding die op het scherm leeg is.
        for (const [code, message] of Object.entries(OWNER_REFUSALS)) {
            assert.equal(typeof message, 'string', `${code} heeft geen zin`);
            assert.ok(message.trim().length > 20, `${code} legt niets uit: ${message}`);
        }
    });
});
