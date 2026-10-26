// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { confirmDecisionOf, confirmStatusOf } from './toolConfirmStatus';
import { stub, malformed } from '@/test/mocks';

/**
 * The status of a held call, and the difference that the card first glossed over.
 * An approval from the SERVER means the call HAS RUN. A click in THIS SESSION
 * means it WILL RUN with the next message. Both say "approved", but they are two
 * different truths.
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
        // 'pending' is itself a claim ("this has not run"). For a status we cannot
        // read, we may not make that claim.
        expect(confirmStatusOf(call({ status: 'ran_maybe' }))).toBe('unknown');
        expect(confirmStatusOf(call({ status: 'APPROVED' }))).toBe('unknown');
    });

    it('een onleesbare call is unknown, geen kaart met knoppen', () => {
        for (const bad of [null, undefined, 'nope', 42]) {
            expect(confirmDecisionOf(malformed<Parameters<typeof confirmDecisionOf>[0]>(bad))).toEqual({ status: 'unknown', by: null });
        }
    });

    it('een beslissing zonder sleutel telt niet mee', () => {
        // The key is name-plus-arguments. Without a key there is nothing to attach a
        // click to, and then the call is simply still open.
        expect(confirmStatusOf(call({ argsKey: null }), { null: 'approve' })).toBe('pending');
        expect(confirmStatusOf(call({ argsKey: undefined }), { undefined: 'approve' })).toBe('pending');
    });

    it('een klik met een woord dat we niet kennen keurt niets goed', () => {
        expect(confirmStatusOf(call(), { ['a'.repeat(32)]: 'approve ' })).toBe('pending');
        expect(confirmStatusOf(call(), stub<Parameters<typeof confirmStatusOf>[1]>({ ['a'.repeat(32)]: true }))).toBe('pending');
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
        // Reading by argsKey let a card in turn 5 say "You declined this" on a click
        // from turn 2, including removing the buttons with which you could have
        // revised it.
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
