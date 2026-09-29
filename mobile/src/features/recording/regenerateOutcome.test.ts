/**
 * `describeRegenerateOutcome` — wat de Android-client na "Opnieuw" zegt.
 *
 * ── WAAROM DIT BESTAAT ──────────────────────────────────────────────
 * POST /:id/regenerate-summary antwoordt 200 óók als het uitwerken van de
 * actiepunten, besluiten en vragen is omgevallen: de server bewaart dan de
 * OUDE lijsten en meldt dat in `artifactsRegenerated: false`. De samenvatting
 * is wél vernieuwd, dus aan het scherm is niets te zien — dat antwoordveld is
 * het enige kanaal. De mutatie hier toonde onvoorwaardelijk een groene
 * "Summary rewritten", precies het symptoom ("niemand drukt nog eens op
 * Opnieuw") dat de serverfix heet te dichten, alleen op de client die geen
 * WebView-wrapper is.
 *
 * Draaien: cd mobile && ./node_modules/.bin/jest src/features/recording/regenerateOutcome.test.ts
 */

import { describeRegenerateOutcome, type RegenerateResult } from './api';

const OK: RegenerateResult = {
    summary: 'Verse samenvatting',
    actionItems: [{ text: 'Offerte sturen' }],
    decisions: [{ text: 'Plan A' }],
    questions: [{ text: 'Wie regelt de zaal?' }],
    chapters: [],
    speakers: [],
    artifactsRegenerated: true,
};

describe('describeRegenerateOutcome', () => {
    it('een volledig geslaagde regeneratie is groen', () => {
        expect(describeRegenerateOutcome(OK)).toEqual({ kind: 'success', message: 'Summary rewritten' });
    });

    it('een MISLUKTE artefactpass is geen succes', () => {
        const outcome = describeRegenerateOutcome({ ...OK, artifactsRegenerated: false });
        expect(outcome.kind).toBe('warning');
        expect(outcome.message).toMatch(/kept/i);
        expect(outcome.message).not.toBe('Summary rewritten');
    });

    it('een oudere server zonder het veld beweert niets — dat blijft groen', () => {
        // `undefined` is geen nieuws. Alleen een expliciete `false` is dat.
        const { artifactsRegenerated, ...withoutField } = OK;
        expect(describeRegenerateOutcome(withoutField as RegenerateResult).kind).toBe('success');
    });

    it('bewaarde punten die de verse pass niet meer vond worden gemeld', () => {
        const outcome = describeRegenerateOutcome({
            ...OK,
            actionItems: [
                { text: 'Offerte sturen' },
                { text: 'Contract tekenen', done: true, orphaned: true },
                { text: 'Notulen delen', orphaned: true },
            ],
        });
        expect(outcome.kind).toBe('warning');
        expect(outcome.message).toContain('2 action item(s)');
    });

    it('de mislukte pass wint van de wees-melding — die zegt meer', () => {
        const outcome = describeRegenerateOutcome({
            ...OK,
            artifactsRegenerated: false,
            actionItems: [{ text: 'Contract tekenen', orphaned: true }],
        });
        expect(outcome.message).toMatch(/failed/i);
    });

    it('geen antwoord is geen succes', () => {
        expect(describeRegenerateOutcome(null).kind).toBe('warning');
    });

    it('een antwoord zonder lijst valt niet om', () => {
        const outcome = describeRegenerateOutcome({ ...OK, actionItems: undefined as unknown as [] });
        expect(outcome.kind).toBe('success');
    });
});
