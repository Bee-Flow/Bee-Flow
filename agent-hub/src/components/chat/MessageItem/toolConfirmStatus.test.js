// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { confirmDecisionOf, confirmStatusOf } from './toolConfirmStatus';

/**
 * De stand van een vastgehouden call, en het verschil dat de kaart eerst
 * wegpoetste: een goedkeuring van de SERVER betekent dat de call gedraaid
 * heeft, een klik in DEZE SESSIE betekent dat hij bij het volgende bericht
 * gaat draaien. Allebei "approved", twee verschillende waarheden.
 */

const call = (over = {}) => ({
    callId: 'call_1', toolName: 'gmail_compose', effect: 'sends',
    argsKey: 'a'.repeat(32), status: 'pending', ...over,
});

describe('wie de stand zette', () => {
    it('de server: goedgekeurd betekent GEDRAAID', () => {
        expect(confirmDecisionOf(call({ status: 'approved' }))).toEqual({ status: 'approved', by: 'server' });
    });

    it('deze sessie: goedgekeurd betekent GAAT DRAAIEN', () => {
        const decided = { ['a'.repeat(32)]: 'approve' };
        expect(confirmDecisionOf(call(), decided)).toEqual({ status: 'approved', by: 'session' });
    });

    it('de server wint van een klik — hij weet wat er echt gebeurd is', () => {
        const decided = { ['a'.repeat(32)]: 'approve' };
        expect(confirmDecisionOf(call({ status: 'declined' }), decided))
            .toEqual({ status: 'declined', by: 'server' });
    });

    it('niets beslist: pending, en niemand die het zette', () => {
        expect(confirmDecisionOf(call())).toEqual({ status: 'pending', by: null });
        expect(confirmDecisionOf(call({ status: undefined }))).toEqual({ status: 'pending', by: null });
    });
});

describe('onbekend versmalt', () => {
    it('BIJT — een stand die we niet kennen wordt GEEN pending', () => {
        // 'pending' is zelf een bewering ("dit heeft niet gedraaid"). Bij een
        // stand die we niet kunnen lezen mogen we die niet doen.
        expect(confirmStatusOf(call({ status: 'ran_maybe' }))).toBe('unknown');
        expect(confirmStatusOf(call({ status: 'APPROVED' }))).toBe('unknown');
    });

    it('een onleesbare call is unknown, geen kaart met knoppen', () => {
        for (const bad of [null, undefined, 'nope', 42]) {
            expect(confirmDecisionOf(bad)).toEqual({ status: 'unknown', by: null });
        }
    });

    it('een beslissing zonder sleutel telt niet mee', () => {
        // De sleutel is naam-plus-argumenten. Zonder sleutel is er niets om
        // een klik aan te hangen, en dan is de call gewoon nog open.
        expect(confirmStatusOf(call({ argsKey: null }), { null: 'approve' })).toBe('pending');
        expect(confirmStatusOf(call({ argsKey: undefined }), { undefined: 'approve' })).toBe('pending');
    });

    it('een klik met een woord dat we niet kennen keurt niets goed', () => {
        expect(confirmStatusOf(call(), { ['a'.repeat(32)]: 'approve ' })).toBe('pending');
        expect(confirmStatusOf(call(), { ['a'.repeat(32)]: true })).toBe('pending');
    });
});

describe('BIJT — de sessie-aantekening hangt aan de KAART, niet aan de actie', () => {
    const ARGS = 'a'.repeat(32);

    it('leest op callId, want die is per ronde nieuw', () => {
        const call = { callId: 'call_1', argsKey: ARGS, status: 'pending' };
        expect(confirmDecisionOf(call, { call_1: 'approve' }))
            .toEqual({ status: 'approved', by: 'session' });
    });

    it('een LATERE kaart voor dezelfde actie is weer een open vraag', () => {
        // Op argsKey lezen liet een kaart in beurt 5 "You declined this"
        // zeggen op een klik uit beurt 2 — inclusief het weghalen van de
        // knoppen waarmee je dat had kunnen herzien.
        const later = { callId: 'call_9', argsKey: ARGS, status: 'pending' };
        expect(confirmDecisionOf(later, { call_1: 'decline' }))
            .toEqual({ status: 'pending', by: null });
    });

    it('een kaart zonder callId valt terug op argsKey', () => {
        const legacy = { argsKey: ARGS, status: 'pending' };
        expect(confirmDecisionOf(legacy, { [ARGS]: 'approve' }))
            .toEqual({ status: 'approved', by: 'session' });
    });

    it('de server houdt het laatste woord, wat er ook geklikt is', () => {
        const served = { callId: 'call_1', argsKey: ARGS, status: 'declined' };
        expect(confirmDecisionOf(served, { call_1: 'approve' }))
            .toEqual({ status: 'declined', by: 'server' });
    });
});
