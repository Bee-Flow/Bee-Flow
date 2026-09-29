// @vitest-environment node
/**
 * A code step's inputs can be set, and they survive the save.
 *
 * THE RUNNER HAS ALWAYS READ THEM: execCode resolves `step.inputs` before the
 * isolate exists, and the validator even tells the author to use them — "pass
 * the value in through `inputs`" is the hint on
 * `code.secret_keys_unsupported`. No screen could set one. So the advice was
 * to use a field the product gave you no way to fill, and the only route in
 * was the JSON tab.
 *
 * codeFields.jsx had shipped the table for exactly this, gated on a probe
 * (`codeInputsRoundTrip`) that ASKS whether formState carries `inputs` rather
 * than assuming it — because a control whose value buildPatch drops looks
 * saved, saves nothing and is gone on reopen. This pins the round trip the
 * probe is asking about.
 *
 * BOTH DIRECTIONS OR NEITHER, and that is not symmetry for its own sake:
 *  - extract without patch  → every edit is lost on save.
 *  - patch without extract  → every unrelated save ships `inputs: {}` and
 *                             WIPES the step's real inputs.
 * The second is the worse one and it has no error anywhere, which is why the
 * probe checks both.
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/flow/settings/actionEditors/codeFields.inputs.test.jsx
 */

import { describe, it, expect } from 'vitest';
import { extractFormState, buildPatch, deepEqual } from '../formState';

/** flushNow's actual test (SettingsForm.jsx:195), in one line. */
function wouldSend(step, draft) {
    return !deepEqual(buildPatch(step, draft), buildPatch(step, extractFormState(step)));
}

const CODE = { id: 's1', type: 'code', label: 'Tidy the rows', code: 'function main(inputs) { return inputs.n; }' };

describe('a code step round-trips its inputs', () => {
    it('opens with the inputs it was saved with', () => {
        const step = { ...CODE, inputs: { n: { kind: 'literal', value: '7' } } };
        expect(extractFormState(step).inputs).toEqual({ n: { kind: 'literal', value: '7' } });
    });

    it('opens with an empty map rather than undefined, so the table can render', () => {
        expect(extractFormState(CODE).inputs).toEqual({});
    });

    it('ADDING ONE ACTUALLY SENDS — the whole point', () => {
        const draft = { ...extractFormState(CODE), inputs: { rows: { kind: 'ref', path: 'steps.s0.output.rows' } } };
        expect(wouldSend(CODE, draft)).toBe(true);
        expect(buildPatch(CODE, draft).inputs).toEqual({ rows: { kind: 'ref', path: 'steps.s0.output.rows' } });
    });

    it('REMOVING THE LAST ONE SENDS TOO, instead of silently keeping it', () => {
        const step = { ...CODE, inputs: { n: { kind: 'literal', value: '7' } } };
        const draft = { ...extractFormState(step), inputs: {} };
        expect(wouldSend(step, draft)).toBe(true);
        expect(buildPatch(step, draft).inputs).toEqual({});
    });

    it('editing something ELSE does not touch the inputs it did not ask about', () => {
        // The half that would silently wipe a step: a patch that always ships
        // `inputs` from a draft that never carried them.
        const step = { ...CODE, inputs: { n: { kind: 'literal', value: '7' } } };
        const draft = { ...extractFormState(step), label: 'Renamed' };
        expect('inputs' in buildPatch(step, draft)).toBe(false);
    });

    it('the probe codeFields.jsx gates its table on now answers yes', () => {
        // Copied from codeFields.codeInputsRoundTrip — if this goes red the
        // table silently disappears from the editor again.
        //
        // Note the CHANGED draft. The probe used to ask with an unchanged one,
        // which buildPatch drops by design (it sends only what differs from
        // the step), so it answered "no round trip" no matter what formState
        // did — the gate would have stayed shut on the very day the round trip
        // landed. That is the bug this line is shaped around.
        const probe = { id: 'probe_code', type: 'code', code: '', inputs: { probe_key: { kind: 'literal', value: 'x' } } };
        const draft = extractFormState(probe);
        expect(draft?.inputs?.probe_key).toBeTruthy();
        const edited = { ...draft, inputs: { probe_key: { kind: 'literal', value: 'y' } } };
        expect(buildPatch(probe, edited)?.inputs?.probe_key?.value).toBe('y');
    });

    it('the probe says NO when only one half of the round trip exists', () => {
        // The guard against the worse direction: a buildPatch that forwards
        // inputs from a draft extractFormState never filled would ship
        // `inputs: {}` on every unrelated save and wipe the step's real ones.
        const halfDraft = { label: '', icon: '', code: '' };   // no `inputs` key
        const probe = { id: 'p', type: 'code', code: '', inputs: { k: { kind: 'literal', value: 'x' } } };
        expect(buildPatch(probe, halfDraft).inputs).toEqual({});
        // ...which is exactly why the probe checks the READ half first.
        expect('inputs' in extractFormState(probe)).toBe(true);
    });
});
