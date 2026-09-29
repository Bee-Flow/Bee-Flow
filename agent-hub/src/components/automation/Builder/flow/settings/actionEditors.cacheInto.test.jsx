import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { HttpRequestFields } from './actionEditors';
import { extractFormState, buildPatch } from './formState';

/**
 * "Remember answers in a table" on an http_request step.
 *
 * The VISIBLE half of reusing an answer, and a SEPARATE tick from "ask this
 * service only once per run" — they are separate promises and either can be on
 * alone.
 *
 * Two things here are the feature rather than decoration:
 *
 *   THE PICKER IS NARROWED. Only a table provisioned for this can hold these
 *   answers: the runner writes eight columns by name, so pointing the tick at
 *   an ordinary table would fail once, at run time, at 3am. With none to pick,
 *   the tick is disabled and says where to make one — a tick with nowhere to
 *   put the answers is a setting that reads as configured and does nothing.
 *
 *   THE HELP TEXT IS THE ONLY PLACE THE TRADE IS VISIBLE. Both tiers make the
 *   second call disappear; the difference is that these rows are plain text
 *   colleagues with access to the table can read and export. Nobody would guess
 *   that from the behaviour, so the control says it, and every option carries
 *   the table's audience.
 */

const MANAGED = {
    id: 'tbl_answers', name: 'Keyword answers', key: 'keyword_answers',
    managedKind: 'http_cache', canWrite: true, scope: 'org', columns: [],
};
const ORDINARY = {
    id: 'tbl_customers', name: 'Customers', key: 'customers',
    managedKind: null, canWrite: true, scope: 'org', columns: [],
};

function renderFields(draft = {}, datatables = [MANAGED]) {
    const set = vi.fn();
    render(
        <HttpRequestFields
            draft={{ url: 'https://api.example.com/rates', method: 'GET', headers: {}, ...draft }}
            set={set}
            groups={[]}
            catalog={{ datatables }}
        />,
    );
    return { set };
}

const toggle = () => screen.getByRole('checkbox', { name: /remember answers in a table/i });
// AccordionSection persists open/closed per user, so a blind click would CLOSE
// the band for a later test in the same file.
const openAdvanced = () => {
    if (screen.queryByRole('checkbox', { name: /remember answers in a table/i })) return;
    const band = screen.queryByRole('button', { name: /advanced/i });
    if (band) fireEvent.click(band);
};

beforeEach(() => cleanup());

describe('the tick', () => {
    it('is offered, unticked, when there is a table to keep answers in', () => {
        renderFields();
        openAdvanced();
        expect(toggle().checked).toBe(false);
        expect(toggle().disabled).toBe(false);
    });

    it('is disabled with nowhere to put the answers, and says where to make one', () => {
        renderFields({}, []);
        openAdvanced();
        expect(toggle().disabled).toBe(true);
        expect(screen.getByText(/Make an answers table first/i)).toBeTruthy();
    });

    it('ticking it picks the table and the default window', () => {
        const { set } = renderFields();
        openAdvanced();
        fireEvent.click(toggle());
        expect(set).toHaveBeenCalledWith('cacheInto', { datatableId: 'tbl_answers', maxAgeDays: 30 });
    });

    it('unticking it clears the field rather than leaving a table behind', () => {
        const { set } = renderFields({ cacheInto: { datatableId: 'tbl_answers', maxAgeDays: 30 } });
        openAdvanced();
        fireEvent.click(toggle());
        expect(set).toHaveBeenCalledWith('cacheInto', undefined);
    });

    it('is ENABLED on a write method, with the caution rather than a refusal', () => {
        // The method stopped gating this tick when POST-as-look-up was allowed
        // in (DataForSEO, GraphQL, Elasticsearch). What replaces the refusal is
        // a sentence, because only the author knows which kind of POST this is.
        renderFields({ method: 'POST', body: '{}' });
        openAdvanced();
        expect(toggle().disabled).toBe(false);
        expect(screen.getByText(/not promised to be a look-up/i)).toBeTruthy();
    });

    it('keeps its OWN wording for the one refusal that remains', () => {
        // Two controls whose disabled reasons read identically leave the author
        // unable to tell which one is being explained. The SSRF refusal stays:
        // no fetch happens on a hit, so the guard's refusal never fires.
        renderFields({ blockPrivateTargets: false });
        openAdvanced();
        expect(toggle().disabled).toBe(true);
        expect(screen.getByText(/Nothing is kept while private targets are allowed/i)).toBeTruthy();
    });
});

describe('the picker', () => {
    it('offers only tables provisioned for this, and names each audience', () => {
        renderFields({ cacheInto: { datatableId: 'tbl_answers', maxAgeDays: 30 } }, [MANAGED, ORDINARY]);
        openAdvanced();
        const options = [...screen.getByRole('combobox', { name: /which table/i }).options];
        expect(options.map(o => o.value)).toEqual(['tbl_answers']);
        expect(options[0].textContent).toMatch(/everyone in the organisation/i);
    });

    it('keeps a table the step names but this account can no longer reach', () => {
        // Silently re-pointing the step at a different table is worse than
        // showing that the one it names is gone.
        renderFields({ cacheInto: { datatableId: 'tbl_gone', maxAgeDays: 30 } });
        openAdvanced();
        const select = screen.getByRole('combobox', { name: /which table/i });
        expect(select.value).toBe('tbl_gone');
        expect(screen.getByText(/no longer reach/i)).toBeTruthy();
    });

    it('changing the window keeps the table it was pointed at', () => {
        const { set } = renderFields({ cacheInto: { datatableId: 'tbl_answers', maxAgeDays: 30 } });
        openAdvanced();
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
        expect(set).toHaveBeenCalledWith('cacheInto', { datatableId: 'tbl_answers', maxAgeDays: 7 });
    });

    it('says that the rows are readable and exportable by everyone with access', () => {
        renderFields({ cacheInto: { datatableId: 'tbl_answers', maxAgeDays: 30 } });
        openAdvanced();
        expect(screen.getByText(/read and\s+export them/i)).toBeTruthy();
    });
});

describe('the field survives a round trip', () => {
    const step = {
        id: 'h1', type: 'http_request', url: 'https://api.example.com/rates', method: 'GET',
        cacheInto: { datatableId: 'tbl_answers', maxAgeDays: 14 },
    };

    it('an unrelated save does not strip it', () => {
        // buildPatch sends only what CHANGED, so "survived" means the key is
        // absent — not present-and-equal. Present-and-undefined is the shape
        // that would delete the setting, and that is what this rules out.
        const draft = extractFormState(step);
        expect(draft.cacheInto).toEqual({ datatableId: 'tbl_answers', maxAgeDays: 14 });
        const patch = buildPatch(step, { ...draft, timeoutMs: 20000 });
        expect('cacheInto' in patch).toBe(false);
        expect(patch.timeoutMs).toBe(20000);
    });

    it('changing only the window sends only the new window', () => {
        const draft = extractFormState(step);
        const patch = buildPatch(step, { ...draft, cacheInto: { datatableId: 'tbl_answers', maxAgeDays: 7 } });
        expect(patch.cacheInto).toEqual({ datatableId: 'tbl_answers', maxAgeDays: 7 });
    });

    it('unticking clears the key rather than leaving a fourth spelling of off', () => {
        const draft = extractFormState(step);
        const patch = buildPatch(step, { ...draft, cacheInto: undefined });
        expect('cacheInto' in patch).toBe(true);
        expect(patch.cacheInto).toBeUndefined();
    });

    it('a table-less object is off, not a half-configured setting', () => {
        const draft = extractFormState({ ...step, cacheInto: { maxAgeDays: 30 } });
        expect(draft.cacheInto).toBeUndefined();
    });

    it('a step that never had one is left byte-identical', () => {
        const plain = { id: 'h2', type: 'http_request', url: 'https://x.test/', method: 'GET' };
        const patch = buildPatch(plain, extractFormState(plain));
        expect('cacheInto' in patch).toBe(false);
    });
});
