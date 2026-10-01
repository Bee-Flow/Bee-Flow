/**
 * REGRESSION (M1 left open, confirmed bug "Missing ref/expr values and expr
 * errors are silent; only templates produce run warnings"): the runner now
 * writes the warnings it collected to the run row, and this banner is where
 * the run view shows them.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import RunWarningsBanner, { runWarnings, runWarningText, type RunWarning } from './RunWarningsBanner';

// As the server's runWarnings.js stores them: { code, params, text }.
const w = (code: string, params: RunWarning['params'], text = `server text for ${code}`): RunWarning => ({ code, params, text });

describe('RunWarningsBanner', () => {
    it('shows nothing for a run without warnings, or an older run row', () => {
        const { container, rerender } = render(<RunWarningsBanner run={{ warnings: [] }} />);
        expect(container).toBeEmptyDOMElement();
        rerender(<RunWarningsBanner run={{}} />);
        expect(container).toBeEmptyDOMElement();
        rerender(<RunWarningsBanner run={null} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('counts the warnings, and lists them on request, worded by code', async () => {
        const warnings = [
            w('pick_missing', { input: 'to', label: 'E-mail van klant', path: 'steps.s.output.e' }),
            w('template_missing', { path: 'steps.s1.output.total' }),
        ];
        render(<RunWarningsBanner run={{ warnings }} />);
        expect(screen.getByText('This run finished with 2 warning(s)')).toBeInTheDocument();
        const first = 'input "to": "E-mail van klant" was empty';
        expect(screen.queryByText(first)).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Show' }));
        expect(screen.getByText(first)).toBeInTheDocument();
        expect(screen.getByText('{{steps.s1.output.total}} resolved to nothing')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
        expect(screen.queryByText(first)).not.toBeInTheDocument();
    });

    it('reads only structured warnings off the run row', () => {
        const ok = w('guard_unwired', { step: 'g' });
        expect(runWarnings({ warnings: [ok, '', 3, null, 'a sentence', { params: {} }, { code: 'x', params: [1], text: 7 }] }))
            .toEqual([ok, { code: 'x', params: {}, text: '' }]);
        expect(runWarnings({ warnings: 'not a list' })).toEqual([]);
    });
});

describe('runWarningText', () => {
    // Records the key it was asked for, so the test sees the translation is looked up by code.
    const keys: string[] = [];
    const t: TranslateFn = (key, fallback, params) => {
        keys.push(key);
        const text = typeof fallback === 'string' ? fallback : key;
        const p = (typeof fallback === 'object' ? fallback : params) || {};
        return text.replace(/\{(\w+)\}/g, (_, k) => String((p as Record<string, unknown>)[k] ?? ''));
    };

    it('words every server code the way the server English does', () => {
        const cases: [RunWarning, string][] = [
            [w('ref_missing', { input: 't', path: 'steps.a.output.total' }), 'input "t": steps.a.output.total resolved to nothing'],
            [w('expr_missing', { input: 'm', expr: 'steps.a.output.nope' }), 'input "m": expression "steps.a.output.nope" resolved to nothing'],
            [w('expr_error', { expr: 'join(x', message: 'Unexpected end' }), 'expression "join(x" failed: Unexpected end'],
            [w('mapping_invalid', { kind: 'compose', path: '' }), 'a compose binding is not valid and gave no value'],
            [w('mapping_invalid', { kind: 'pick', path: 'steps.s.output.x' }), 'a pick binding on steps.s.output.x is not valid and gave no value'],
            [w('pick_missing_required', { input: 'tel', label: 'Telefoon' }), 'input "tel": "Telefoon" was empty, and the step needs it'],
            [w('pick_many_for_one', { path: 'steps.s.output.rows.e', count: 2 }), 'steps.s.output.rows.e held 2 values; only the first was used'],
            [w('pick_holes_dropped', { path: 'p', count: 2 }), 'p: 2 item(s) without this field were left out'],
            [w('pick_parse_failed', { input: 'n', path: 'p', as: 'yesno' }), 'input "n": p could not be read as a yes or no'],
            [w('pick_each_outside_repeat', { label: 'L', path: 'p' }), '"L" reads the current item, but this step does not repeat over that list'],
            [w('pick_missing', {}), 'a mapped value was empty'],
            [w('branch_no_edge', { stepType: 'switch', step: 'sw', branch: 'case:vip' }), 'switch sw routed to "case:vip" but no edge carries that branch — downstream steps did not run'],
            [w('guard_unwired', { step: 'g1' }), 'guard g1 found personal data but nothing is wired to its "personal data" branch — no alert was sent'],
            [w('app_effect_ignored', { step: 'r1', field: 'toast', reason: 'there is no message to show' }), 'return_to_app r1: ignored "toast" — there is no message to show'],
            [w('more', { count: 7 }), '…and 7 more warning(s)'],
        ];
        for (const [warning, english] of cases) expect(runWarningText(t, warning)).toBe(english);
        expect(keys).toContain('mapping.run_warning.pick_missing');
        expect(keys).toContain('mapping.run_warning.on_input');
    });

    it('shows the server English for a code this build does not know', () => {
        expect(runWarningText(t, w('something_new', { step: 'x' }, 'Something new happened'))).toBe('Something new happened');
    });
});
