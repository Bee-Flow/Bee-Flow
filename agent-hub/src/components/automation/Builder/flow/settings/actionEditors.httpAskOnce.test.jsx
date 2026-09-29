import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { HttpRequestFields } from './actionEditors';
import { extractFormState, buildPatch, deepEqual, FOREACH_FORM_TYPES } from './formState';

/**
 * "Ask this service only once per run" on an http_request step.
 *
 * Two of the three states here are REFUSALS in the runtime
 * (core/automationRunner/httpCache.js), not preferences: a write method, and an
 * SSRF guard the author switched off. Neither ever reuses anything. So the tick
 * is disabled AND says why — a step that silently never reuses anything looks
 * exactly like a slow step, and nobody would ever find out which.
 *
 * The disabled reason is computed by the CALLER now: AskOnceRow used to read
 * `action.askOnceable` out of builderCatalog, which meant only an
 * integration_action could ever render it, and http_request has no catalog
 * entry at all.
 */

function renderFields(draft = {}) {
    const set = vi.fn();
    render(
        <HttpRequestFields
            draft={{ url: 'https://api.example.com/rates', method: 'GET', headers: {}, ...draft }}
            set={set}
            groups={[]}
        />,
    );
    return { set };
}

const toggle = () => screen.getByRole('checkbox', { name: /ask this service only once per run/i });
// Idempotent: AccordionSection persists open/closed per user via scopedStorage,
// so a blind click would CLOSE the band for a later test in the same file.
const openAdvanced = () => {
    if (screen.queryByRole('checkbox', { name: /ask this service only once per run/i })) return;
    const band = screen.queryByRole('button', { name: /advanced/i });
    if (band) fireEvent.click(band);
};

beforeEach(() => cleanup());

describe('the tick is offered on an http_request', () => {
    it('renders, enabled and unticked, on a GET with the guard on', () => {
        renderFields();
        openAdvanced();
        expect(toggle().checked).toBe(false);
        expect(toggle().disabled).toBe(false);
    });

    it('ticking it asks for the plain per-run reuse', () => {
        const { set } = renderFields();
        openAdvanced();
        fireEvent.click(toggle());
        expect(set).toHaveBeenCalledWith('askOnce', true);
    });

    it('is ENABLED on a write method, and says what a hit would cost', () => {
        // The method no longer gates the tick: a great many look-up APIs are
        // POST by design (DataForSEO, GraphQL, Elasticsearch) because the query
        // does not fit in a URL, and refusing those refused the very calls a
        // cache is for. The author is the only one who knows whether their POST
        // searches or creates, so they get the control AND the caution.
        renderFields({ method: 'POST', body: '{}' });
        openAdvanced();
        expect(toggle().disabled).toBe(false);
        expect(screen.getByText(/not promised to be a look-up/i)).toBeTruthy();
    });

    it('every write method is offered, and each names its own method in the caution', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            cleanup();
            renderFields({ method, body: '{}' });
            openAdvanced();
            expect(toggle().disabled, method).toBe(false);
            // The sentence names the METHOD, so "a DELETE is not promised to be
            // a look-up" reads as the warning it is rather than as boilerplate.
            expect(screen.getByText(new RegExp(`A ${method} is not promised`, 'i')), method).toBeTruthy();
        }
    });

    it('a GET carries no caution — there is nothing to warn about', () => {
        renderFields({ method: 'GET' });
        openAdvanced();
        expect(toggle().disabled).toBe(false);
        expect(screen.queryByText(/not promised to be a look-up/i)).toBeNull();
    });

    it('is disabled while private targets are allowed', () => {
        // No fetch happens on a hit, so the SSRF guard's refusal never fires —
        // replaying such an answer after a reviewer ticks the box back on
        // launders it past a control they believe is in force.
        renderFields({ blockPrivateTargets: false });
        openAdvanced();
        expect(toggle().disabled).toBe(true);
        expect(screen.getByText(/Not while private targets are allowed/i)).toBeTruthy();
    });

    it('offers "keep it for later runs" only once the first tick is on', () => {
        renderFields();
        openAdvanced();
        expect(screen.queryByRole('checkbox', { name: /keep the answer for later runs/i })).toBeNull();
        cleanup();
        renderFields({ askOnce: true });
        openAdvanced();
        expect(screen.getByRole('checkbox', { name: /keep the answer for later runs/i })).toBeTruthy();
    });

    it('the word "cache" never appears — "reuse" is already overloaded four ways here', () => {
        renderFields({ askOnce: true });
        openAdvanced();
        expect(screen.queryByText(/cache/i)).toBeNull();
    });
});

describe('forEach round-trips on an http_request', () => {
    // The runner has always honoured it (executeStepWithIteration) and the
    // builder has always accepted it; only the validator disagreed, so
    // builder_update_step took a field builder_finalize then hard-rejected —
    // on precisely the "one API call per row" shape the cache exists for.
    const httpStep = (over = {}) => ({
        id: 'h1', type: 'http_request', url: 'https://api.example.com/x', method: 'GET', ...over,
    });
    // NodeDetailView merges the patch into the step, then the whole definition
    // is JSON.stringify'd for the PUT.
    const afterSave = (step, patch) => JSON.parse(JSON.stringify({ ...step, ...patch, id: step.id }));

    it('is declared as a forEach form type', () => {
        expect(FOREACH_FORM_TYPES.has('http_request')).toBe(true);
    });

    it('an existing forEach survives an unrelated save rather than being dropped', () => {
        const forEach = { overRef: 'trigger.output.rows', itemVar: 'row', maxIterations: 100 };
        const step = httpStep({ forEach });
        const draft = extractFormState(step);
        expect(draft.forEach).toEqual(forEach);
        const patch = buildPatch(step, { ...draft, timeoutMs: 20_000 });
        expect(extractFormState(afterSave(step, patch)).forEach).toEqual(forEach);
    });

    it('turning it on builds a patch the form would actually send', () => {
        const step = httpStep();
        const baseline = extractFormState(step);
        expect(baseline.forEach).toBeNull();
        const draft = { ...baseline, forEach: { overRef: 'trigger.output.rows', itemVar: 'row' } };
        // Exactly the comparison SettingsForm.flushNow makes before deciding
        // there is nothing to send.
        expect(deepEqual(buildPatch(step, draft), buildPatch(step, baseline))).toBe(false);
        expect(buildPatch(step, draft).forEach.overRef).toBe('trigger.output.rows');
    });

    it('turning it off clears the key instead of leaving a stale one', () => {
        const step = httpStep({ forEach: { overRef: 'trigger.output.rows', itemVar: 'row', maxIterations: 100 } });
        const patch = buildPatch(step, { ...extractFormState(step), forEach: null });
        expect(patch.forEach).toBeNull();
    });
});
