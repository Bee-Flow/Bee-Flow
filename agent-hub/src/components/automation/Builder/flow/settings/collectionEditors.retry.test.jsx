// "If this fails" — the step-level retry row.
//
// The runner has read `step.retry = { max, backoffMs }` since §WS2.5
// (core/automationRunner/execution.js): it sleeps between attempts, records
// every attempt and stands back when a forEach already retried per item. No
// screen ever wrote the field, so the commonest recoverable failure in an
// integration routine — a timeout, a rate limit, a 503 — killed the run while
// the runner sat there able to survive it.
//
// Two things are pinned here beyond "the fields exist". First: the row writes
// the runner's shape exactly — `max` counts the EXTRA attempts, `backoffMs`
// is milliseconds even though the author picks seconds. Get either wrong and
// the row is decoration. Second: the row stays away from a step type whose
// draft does not round-trip `retry`, because a control buildPatch drops looks
// saved, saves nothing and is gone on the next open — this form has shipped
// that bug twice already (datatable's Iteration toggle, C12;
// integration_action's askOnce tick).
//
// The other half of that second promise — that every editor which CAN carry
// the row actually mounts it — is pinned in collectionEditors.retryMount.test.jsx,
// because the failure it guards against is a file that was never edited.

import { render, screen, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { RetrySection } from './collectionEditors';

/** A draft for a step type that round-trips `retry` (key present, unset). */
const OPTED_IN = { retry: null };

function setup(draft) {
    const set = vi.fn();
    render(createElement(RetrySection, { draft, set }));
    return { set };
}

describe('the "if this fails" row', () => {
    it('is not offered at all to a step type whose draft has no `retry` key', () => {
        // The C12 guard. `extractFormState`/`buildPatch` are per-type
        // allow-lists; until a type carries `retry` through both, offering the
        // control would promise a save that flushNow never sends.
        setup({ forEach: null });
        expect(screen.queryByText(/Try again if this step fails/i)).toBeNull();
    });

    it('is offered, switched off, once the draft carries the key', () => {
        setup(OPTED_IN);
        const tick = screen.getByRole('checkbox', { name: /Try again if this step fails/i });
        expect(tick.checked).toBe(false);
        // Nothing to configure until it is on.
        expect(screen.queryByRole('combobox', { name: 'Try again' })).toBeNull();
    });

    it('ticking it asks for two more tries, five seconds apart', () => {
        const { set } = setup(OPTED_IN);
        fireEvent.click(screen.getByRole('checkbox', { name: /Try again if this step fails/i }));
        expect(set).toHaveBeenCalledWith('retry', { max: 2, backoffMs: 5000 });
    });

    it('unticking it clears the field rather than leaving a zero behind', () => {
        // null is what buildPatch needs to null the key out on the step; a
        // `{ max: 0 }` left behind would persist as a config that does nothing.
        const { set } = setup({ retry: { max: 3, backoffMs: 2000 } });
        fireEvent.click(screen.getByRole('checkbox', { name: /Try again if this step fails/i }));
        expect(set).toHaveBeenCalledWith('retry', null);
    });

    it('reads `max: 0` as off — that is the runner\'s own "do not retry"', () => {
        setup({ retry: { max: 0, backoffMs: 5000 } });
        expect(screen.getByRole('checkbox', { name: /Try again if this step fails/i }).checked).toBe(false);
    });
});

describe('the two fields', () => {
    it('counts the EXTRA tries, the way the runner does', () => {
        // execution.js loops `for (i = 1; i <= retry.max; i++)` after the
        // first attempt has already failed, so "3 times" is max: 3 and four
        // attempts in total. Writing 3 as "two more" would quietly change the
        // meaning of every step an author copies from another.
        const { set } = setup({ retry: { max: 2, backoffMs: 5000 } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Try again' }), { target: { value: '3' } });
        expect(set).toHaveBeenCalledWith('retry', { max: 3, backoffMs: 5000 });
    });

    it('shows seconds and stores milliseconds', () => {
        const { set } = setup({ retry: { max: 2, backoffMs: 5000 } });
        const wait = screen.getByRole('combobox', { name: 'Wait before trying again' });
        expect(wait.value).toBe('5000');
        expect(screen.getByRole('option', { name: 'After 30 seconds' }).value).toBe('30000');
        fireEvent.change(wait, { target: { value: '30000' } });
        expect(set).toHaveBeenCalledWith('retry', { max: 2, backoffMs: 30000 });
    });

    it('offers trying again straight away, and says so in words', () => {
        setup({ retry: { max: 1, backoffMs: 0 } });
        expect(screen.getByRole('option', { name: 'Straight away' }).value).toBe('0');
    });

    it('keeps a stored value that is not on the list instead of snapping it', () => {
        // Same rule as PathField: opening a step is not consent to rewrite it.
        // An AI-built or hand-edited `backoffMs: 3000` stays 3000 and stays
        // visible; snapping it to the nearest offered value would show up as a
        // diff the author never made.
        const { set } = setup({ retry: { max: 4, backoffMs: 3000 } });
        expect(screen.getByRole('combobox', { name: 'Wait before trying again' }).value).toBe('3000');
        expect(screen.getByRole('option', { name: 'After 3 seconds' })).toBeTruthy();
        expect(screen.getByRole('combobox', { name: 'Try again' }).value).toBe('4');
        expect(screen.getByRole('option', { name: '4 times' })).toBeTruthy();
        expect(set).not.toHaveBeenCalled();
    });
});

describe('what the row says will happen', () => {
    it('answers the question an author actually has: what when the tries run out', () => {
        setup({ retry: { max: 2, backoffMs: 5000 } });
        expect(screen.getByText(/the step fails and the routine stops there/i)).toBeTruthy();
    });

    it('names the kind of failure retrying is for — and the kind it is not', () => {
        setup({ retry: { max: 2, backoffMs: 5000 } });
        expect(screen.getByText(/failures that pass on their own/i)).toBeTruthy();
        expect(screen.getByText(/wrong password or a missing field/i)).toBeTruthy();
    });

    it('adds up the waiting, because it is spent out of the run\'s own budget', () => {
        // A retry's sleep does NOT re-arm the run deadline the way a Wait
        // step's does, so two tries 30s apart is a minute of the five the run
        // gets.
        setup({ retry: { max: 2, backoffMs: 30000 } });
        expect(screen.getByText(/add up to 60s to this run/i)).toBeTruthy();
    });

    it('warns when the waiting alone could time the run out first', () => {
        setup({ retry: { max: 5, backoffMs: 60000 } });
        const line = screen.getByText(/add up to 300s to this run/i);
        expect(line.textContent).toMatch(/run the routine out of time/i);
        expect(line.className).toMatch(/amber/);
    });

    it('says nothing about waiting when there is none', () => {
        setup({ retry: { max: 3, backoffMs: 0 } });
        expect(screen.queryByText(/add up to/i)).toBeNull();
    });
});

describe('the waiting, when the step also runs once per item', () => {
    // The two rows sit one above the other in the same Advanced section and an
    // author reads them as one setting — so the sum has to be the one the
    // runner will actually pay. It is NOT tries × wait there: execution.js
    // hands a step with a `forEach.overRef` to execForEachStep and stands back
    // (§WS2.5, `err.foreachHandled`), and execFlow.js then sleeps between the
    // attempts of EACH row. Per-step arithmetic reported "10s" in calm grey
    // for a fan-out that would spend a thousand seconds waiting — understating
    // by the row count in exactly the case this line exists to warn about,
    // because a rate-limited integration is usually called once per row.
    const feOver = { overRef: 'steps.s1.output.rows', itemVar: 'item' };

    it('counts the wait once per row, not once per step', () => {
        setup({ retry: { max: 2, backoffMs: 5000 }, forEach: { ...feOver, maxIterations: 10 } });
        expect(screen.getByText(/add up to 100s across all 10 rows/i)).toBeTruthy();
    });

    it('warns on a default fan-out whose per-step sum looks harmless', () => {
        // 2 tries × 2s reads as 4s on a plain step. Over the 100 rows a
        // forEach runs by default it is 400s — past the 5-minute run budget
        // before the tries are even used up.
        setup({ retry: { max: 2, backoffMs: 2000 }, forEach: feOver });
        const line = screen.getByText(/add up to 400s across all 100 rows/i);
        expect(line.textContent).toMatch(/run the routine out of time/i);
        expect(line.className).toMatch(/amber/);
    });

    it('stops at the runner\'s own 1000-row ceiling', () => {
        // execFlow.js slices at Math.min(maxIterations || 100, 1000), so a
        // draft asking for 5000 rows still only waits on 1000 of them.
        setup({ retry: { max: 1, backoffMs: 2000 }, forEach: { ...feOver, maxIterations: 5000 } });
        expect(screen.getByText(/add up to 2000s across all 1000 rows/i)).toBeTruthy();
    });

    it('a half-filled list picker still reads as one step', () => {
        // execution.js dispatches per item only when `forEach.overRef` is set;
        // until then the step runs once, and the row must not invent 100 rows
        // of waiting for a loop the author has not finished setting up.
        setup({ retry: { max: 2, backoffMs: 30000 }, forEach: { overRef: '', itemVar: 'item' } });
        expect(screen.getByText(/add up to 60s to this run/i)).toBeTruthy();
        expect(screen.queryByText(/rows/i)).toBeNull();
    });
});
