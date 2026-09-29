// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { alwaysSkipped, buildTestPayload, SKIP_REASONS } from './testPayload';

/**
 * Wat een testrun meeneemt — en waarom de lijst van wat er NIET in zit even
 * hard telt als de payload zelf.
 *
 * De oude testknop stuurde alleen de statische waarden mee. Alles wat aan een
 * formulierveld hing kwam als `undefined` aan, viel uit de JSON, en de run
 * begon met een lege trigger — zonder dat er iets over gezegd werd. Dat is
 * precies het geval waarin iemand met de helft van de invoer test en de
 * verkeerde conclusie trekt.
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
        // Een leeg tekstveld is niet hetzelfde als een veld dat er niet is.
        const { payload, skipped } = buildTestPayload({
            inputMapping: { subject: { kind: 'field', name: 'title' }, n: { kind: 'field', name: 'amount' } },
            formFields: FIELDS,
            formValues: { title: '', amount: null },
        });
        expect(payload).toEqual({ subject: '', n: null });
        expect(skipped).toEqual([]);
    });
});

describe('buildTestPayload — bestandsvelden gaan nooit mee, en dat wordt gezegd', () => {
    it('slaat een veld over dat een bestandsinvoer is', () => {
        const { payload, skipped } = buildTestPayload({
            inputMapping: { doc: { kind: 'field', name: 'upload' } },
            formFields: FIELDS,
            formValues: { upload: { kind: 'studio_attachment', fileId: 'f1' } },
        });
        expect(payload).toEqual({});
        expect(skipped).toEqual([{ param: 'doc', field: 'upload', reason: SKIP_REASONS.FILE }]);
    });

    it('slaat een parameter over die de routine als `file` declareert, ook zonder bestandsveld', () => {
        // De picker schrijft `{kind:'static', value:''}` als er geen
        // bestandsinvoer is om naar te wijzen. Die lege string als bestand
        // meesturen is erger dan hem overslaan: de stap faalt dan op iets
        // anders dan de echte reden.
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
        const { payload, skipped } = buildTestPayload({
            inputMapping: { subject: null, other: { kind: 'mystery' } },
            formFields: FIELDS,
            formValues: {},
        });
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
        // Het bestandsveld: altijd. Het tekstveld: hangt ervan af of het
        // formulier op dat moment op het scherm staat, dus dat hoort bij de
        // uitslag en niet bij de knop.
        expect(alwaysSkipped(args)).toEqual([{ param: 'doc', field: 'upload', reason: SKIP_REASONS.FILE }]);
    });

    it('is leeg als er niets is dat structureel wegvalt', () => {
        expect(alwaysSkipped({
            inputMapping: { subject: { kind: 'field', name: 'title' } },
            formFields: FIELDS,
        })).toEqual([]);
    });
});

// ── de UNIE van gedeclareerde parameters en mapping-regels ──────────────────
//
// Een parameter die de routine declareert maar die geen mapping-regel heeft is
// de drift-toestand die ContractDrift op het scherm al toont ("The routine also
// expects: + invoiceFile *"). Liep de lus alleen over `inputMapping`, dan reisde
// die parameter niet mee ÉN werd hij niet gemeld — de tester zag een run met een
// lege trigger-output en concludeerde dat de routine stuk was.

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
        const { payload, skipped } = buildTestPayload({ inputMapping, formFields, formValues, paramMeta });
        expect(payload).toEqual({ subject: 'Hallo' });
        const byParam = Object.fromEntries(skipped.map((s) => [s.param, s.reason]));
        expect(byParam.note).toBe(SKIP_REASONS.NO_MAPPING);
        // Het contract wint: een `file` blijft een FILE-overslag, ook zonder
        // regel — dat is de specifiekere reden en de fix is een andere.
        expect(byParam.invoiceFile).toBe(SKIP_REASONS.FILE);
    });

    it('staat onder de knop nog vóór er iemand op drukt', () => {
        const structural = alwaysSkipped({ inputMapping, formFields, paramMeta });
        expect(structural.map((s) => s.param).sort()).toEqual(['invoiceFile', 'note']);
    });

    it('zonder contract verandert er niets — dan is de mapping alles wat we weten', () => {
        const { payload, skipped } = buildTestPayload({ inputMapping, formFields, formValues, paramMeta: null });
        expect(payload).toEqual({ subject: 'Hallo' });
        expect(skipped).toEqual([]);
    });

    it('een mapping-regel voor een parameter die de routine NIET meer kent gaat gewoon mee', () => {
        // De andere kant van de unie. Wat er wél gemapt is blijft reizen: de
        // testroute doet geen contractcontrole, en wegfilteren zou de test iets
        // anders laten draaien dan de knop.
        const { payload } = buildTestPayload({
            inputMapping: { ...inputMapping, legacy: { kind: 'static', value: 7 } },
            formFields, formValues, paramMeta: { subject: { type: 'string', required: true } },
        });
        expect(payload).toEqual({ subject: 'Hallo', legacy: 7 });
    });
});
