/**
 * `describeRegenerateOutcome` — what the Android client says after "Opnieuw".
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────
 * POST /:id/regenerate-summary answers 200 ALSO when the elaboration of the
 * action items, decisions and questions has failed: the server then keeps the
 * OLD lists and reports that in `artifactsRegenerated: false`. The summary has
 * been refreshed, so nothing is visible on screen — that response field is the
 * only channel. The mutation here showed an unconditional green
 * "Summary rewritten", precisely the symptom ("nobody presses Opnieuw again")
 * that the server fix is supposed to close, only on the client that is not a
 * WebView wrapper.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/recording/model/regenerate.test.ts
 */

import { describeRegenerateOutcome, type RegenerateResult } from './regenerate';

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
        // `undefined` is not news. Only an explicit `false` is that.
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
