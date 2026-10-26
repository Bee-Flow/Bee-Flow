// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { alwaysSkipped, buildTestPayload, SKIP_REASONS } from './testPayload';
import { stub } from '@/test/mocks';

/**
 * What a test run takes along — and why the list of what is NOT in it counts
 * just as much as the payload itself.
 *
 * The old test button sent only the static values. Anything hooked to a form
 * field came through as `undefined`, fell out of the JSON, and the run began
 * with an empty trigger — without anything being said about it. That is exactly
 * the case in which someone tests with half the input and draws the wrong
 * conclusion.
 */

const FIELDS = [
    { name: 'title', type: 'input_text', multiple: false },
    { name: 'amount', type: 'input_number', multiple: false },
    { name: 'upload', type: 'input_file', multiple: false },
];

describe('buildTestPayload — wat er wél in gaat', () => {
    it('neemt de ACTUELE waarde van het scherm, niet de standaardwaarde uit de definitie', () => {
        const { payload, skipped } = buildTestPayload({
            inputMapping: { subject: { kind: 'field', name: 'title' } },
            formFields: FIELDS,
            formValues: { title: 'Getypt in het scherm' },
        });
        expect(payload).toEqual({ subject: 'Getypt in het scherm' });
        expect(skipped).toEqual([]);
    });

    it('houdt statische waarden gewoon overeind naast de veldwaarden', () => {
        const { payload } = buildTestPayload({
            inputMapping: {
                subject: { kind: 'field', name: 'title' },
                source: { kind: 'static', value: 'app' },
            },
            formFields: FIELDS,
            formValues: { title: 'Hallo' },
        });
        expect(payload).toEqual({ subject: 'Hallo', source: 'app' });
    });

    it('stuurt een LEGE waarde als lege waarde mee — dat is een antwoord, geen gat', () => {
        // An empty text field is not the same as a field that does not exist.
        const { payload, skipped } = buildTestPayload(stub<Parameters<typeof buildTestPayload>[0]>({
            inputMapping: { subject: { kind: 'field', name: 'title' }, n: { kind: 'field', name: 'amount' } },
            formFields: FIELDS,
            formValues: { title: '', amount: null },
        }));
        expect(payload).toEqual({ subject: '', n: null });
        expect(skipped).toEqual([]);
    });
});

describe('buildTestPayload — bestandsvelden gaan nooit mee, en dat wordt gezegd', () => {
    it('slaat een veld over dat een bestandsinvoer is', () => {
        const { payload, skipped } = buildTestPayload(stub<Parameters<typeof buildTestPayload>[0]>({
            inputMapping: { doc: { kind: 'field', name: 'upload' } },
            formFields: FIELDS,
            formValues: { upload: { kind: 'studio_attachment', fileId: 'f1' } },
        }));
        expect(payload).toEqual({});
        expect(skipped).toEqual([{ param: 'doc', field: 'upload', reason: SKIP_REASONS.FILE }]);
    });

    it('slaat een parameter over die de automatisering als `file` declareert, ook zonder bestandsveld', () => {
        // The picker writes `{kind:'static', value:''}` when there is no
        // file input to point to. Sending that empty string along as a file is
        // worse than skipping it: the step then fails on something other
        // than the real reason.
        const { payload, skipped } = buildTestPayload({
            inputMapping: { doc: { kind: 'static', value: '' } },
            formFields: FIELDS,
            paramMeta: { doc: { type: 'file', required: true } },
        });
        expect(payload).toEqual({});
        expect(skipped).toEqual([{ param: 'doc', field: null, reason: SKIP_REASONS.FILE }]);
    });
});

describe('buildTestPayload — onbekend versmalt', () => {
    it('verzint niets als het formulier niet op het scherm staat', () => {
        const { payload, skipped } = buildTestPayload({
            inputMapping: { subject: { kind: 'field', name: 'title' } },
            formFields: FIELDS,
            formValues: null,
        });
        expect(payload).toEqual({});
        expect(skipped).toEqual([{ param: 'subject', field: 'title', reason: SKIP_REASONS.NO_SCREEN }]);
    });

    it('verzint niets voor een veld dat het formulier niet (meer) heeft', () => {
        const { payload, skipped } = buildTestPayload({
            inputMapping: { subject: { kind: 'field', name: 'renamed' } },
            formFields: FIELDS,
            formValues: { title: 'Hallo' },
        });
        expect(payload).toEqual({});
        expect(skipped).toEqual([{ param: 'subject', field: 'renamed', reason: SKIP_REASONS.NO_VALUE }]);
    });

    it('meldt een parameter zonder bruikbare mapping in plaats van hem te laten verdwijnen', () => {
        const { payload, skipped } = buildTestPayload(stub<Parameters<typeof buildTestPayload>[0]>({
            inputMapping: { subject: null, other: { kind: 'mystery' } },
            formFields: FIELDS,
            formValues: {},
        }));
        expect(payload).toEqual({});
        expect(skipped.map((s) => [s.param, s.reason])).toEqual([
            ['subject', SKIP_REASONS.UNMAPPED],
            ['other', SKIP_REASONS.UNMAPPED],
        ]);
    });

    it('een lege mapping levert een lege payload en geen enkele klacht', () => {
        expect(buildTestPayload()).toEqual({ payload: {}, skipped: [] });
        expect(buildTestPayload({ inputMapping: {}, formValues: {} })).toEqual({ payload: {}, skipped: [] });
    });
});

describe('alwaysSkipped — wat er onder de knop kan staan vóór de klik', () => {
    it('noemt alleen wat structureel nooit mee kan, niet wat van het moment afhangt', () => {
        const args = {
            inputMapping: {
                doc: { kind: 'field', name: 'upload' },
                subject: { kind: 'field', name: 'title' },
                source: { kind: 'static', value: 'app' },
            },
            formFields: FIELDS,
        };
        // The file field: always. The text field: depends on whether the
        // form is on screen at that moment, so that belongs in the outcome and
        // not with the button.
        expect(alwaysSkipped(stub<Parameters<typeof alwaysSkipped>[0]>(args))).toEqual([{ param: 'doc', field: 'upload', reason: SKIP_REASONS.FILE }]);
    });

    it('is leeg als er niets is dat structureel wegvalt', () => {
        expect(alwaysSkipped({
            inputMapping: { subject: { kind: 'field', name: 'title' } },
            formFields: FIELDS,
        })).toEqual([]);
    });
});

// ── the UNION of declared parameters and mapping rules ──────────────────
//
// A parameter that the automation declares but that has no mapping rule is the
// drift state that ContractDrift already shows on screen (“The automation also
// expects: + invoiceFile *”). If the loop only ran over `inputMapping`, that
// parameter neither travelled along NOR was it reported — the tester saw a run with an
// empty trigger output and concluded the automation was broken.

describe('een gedeclareerde parameter zonder mapping-regel', () => {
    const paramMeta = {
        subject: { type: 'string', required: true },
        invoiceFile: { type: 'file', required: true },
        note: { type: 'string', required: false },
    };
    const inputMapping = { subject: { kind: 'field', name: 'title' } };
    const formFields = [{ name: 'title', type: 'input_text' }];
    const formValues = { title: 'Hallo' };

    it('reist niet mee, maar wordt wel gemeld', () => {
        const { payload, skipped } = buildTestPayload(stub<Parameters<typeof buildTestPayload>[0]>({ inputMapping, formFields, formValues, paramMeta }));
        expect(payload).toEqual({ subject: 'Hallo' });
        const byParam = Object.fromEntries(skipped.map((s) => [s.param, s.reason]));
        expect(byParam.note).toBe(SKIP_REASONS.NO_MAPPING);
        // The contract wins: a `file` remains a FILE skip, even without
        // a rule — that is the more specific reason, and the fix is a different one.
        expect(byParam.invoiceFile).toBe(SKIP_REASONS.FILE);
    });

    it('staat onder de knop nog vóór er iemand op drukt', () => {
        const structural = alwaysSkipped(stub<Parameters<typeof alwaysSkipped>[0]>({ inputMapping, formFields, paramMeta }));
        expect(structural.map((s) => s.param).sort()).toEqual(['invoiceFile', 'note']);
    });

    it('zonder contract verandert er niets — dan is de mapping alles wat we weten', () => {
        const { payload, skipped } = buildTestPayload(stub<Parameters<typeof buildTestPayload>[0]>({ inputMapping, formFields, formValues, paramMeta: null }));
        expect(payload).toEqual({ subject: 'Hallo' });
        expect(skipped).toEqual([]);
    });

    it('een mapping-regel voor een parameter die de automatisering NIET meer kent gaat gewoon mee', () => {
        // The other side of the union. What IS mapped keeps travelling: the
        // test route does no contract check, and filtering it out would make the test
        // run something different from the button.
        const { payload } = buildTestPayload(stub<Parameters<typeof buildTestPayload>[0]>({
            inputMapping: { ...inputMapping, legacy: { kind: 'static', value: 7 } },
            formFields, formValues, paramMeta: { subject: { type: 'string', required: true } },
        }));
        expect(payload).toEqual({ subject: 'Hallo', legacy: 7 });
    });
});
