import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppForm from './AppForm';
import AppInputRelation from './AppInputRelation';
import { dataCacheKey } from '../resolveBinding';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';
import { CANDIDATE_LIMIT } from './comboBox';

/**
 * `input_relation.filter` — a formula, evaluated here.
 *
 * The spec has always declared this prop as `{ type: 'formula' }` and described
 * it as "a formula that narrows the choices". The component handed the string
 * to the records binding as though it were a filter ARRAY, the server answered
 * `filters must be an array`, and the read 500'd. So a filtered relation picker
 * listed nothing AND logged an error on every screen open — in an app that
 * validated clean. These tests exist so that cannot come back silently.
 */

const LINES = [
    { id: 'l1', basisnaam: 'mw2604-01-1100-001', thread_key: 'demo-thread-001' },
    { id: 'l2', basisnaam: 'mw2604-01-1100-002', thread_key: 'demo-thread-001' },
    { id: 'l3', basisnaam: 'other-part-900', thread_key: 'demo-thread-002' },
];

function renderRelation(props = {}, scope = {}) {
    const node = {
        id: 'cmp_rl',
        type: 'input_relation',
        props: { name: 'line', label: 'Projectregel', tableId: 'tbl_qiline', displayField: 'basisnaam', ...props },
        style: { span: 12 },
    };
    const formNode = {
        id: 'cmp_form', type: 'form', visible: true,
        props: { name: 'fileops', submitLabel: 'Save', showSubmit: false },
        style: { span: 12 },
        children: [node],
    };
    // The same key the fetch layer stores under — computed, not hand-written,
    // so a change to the binding shape shows up as a failing test rather than
    // as a test that quietly primes a cache nobody reads.
    const key = dataCacheKey({ kind: 'records', tableId: 'tbl_qiline', limit: CANDIDATE_LIMIT }) as string;
    const dataState = { [key]: { status: 'success', result: LINES } };

    const view = render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', dataState, scope }}>
            <AppForm node={formNode}><AppInputRelation node={node} /></AppForm>
        </RuntimeProvider>,
    );
    // The options live in a listbox the combobox only renders once focused.
    fireEvent.focus(view.container.querySelector('[role="combobox"]')!);
    return view;
}

/** What the open listbox actually offers. */
function optionText(container: HTMLElement) {
    return Array.from(container.querySelectorAll('[role="option"]')).map((el) => el.textContent).join(' | ');
}

describe('AppInputRelation filter', () => {
    it('offers every candidate when no filter is set', () => {
        const { container } = renderRelation();
        const text = optionText(container);
        expect(text).toContain('mw2604-01-1100-001');
        expect(text).toContain('other-part-900');
    });

    it('narrows the choices with the formula, against `item` and the scope', () => {
        const { container } = renderRelation(
            { filter: 'item.thread_key == vars.thread' },
            { vars: { thread: 'demo-thread-001' } },
        );
        const text = optionText(container);
        expect(text).toContain('mw2604-01-1100-001');
        expect(text).toContain('mw2604-01-1100-002');
        expect(text).not.toContain('other-part-900');
    });

    it('narrows to nothing when the formula cannot be evaluated', () => {
        // Offering rows the author meant to exclude is the failure nobody
        // notices; an empty picker is at least visible.
        const { container } = renderRelation(
            { filter: 'item.thread_key === ((( ' },
            { vars: { thread: 'demo-thread-001' } },
        );
        expect(optionText(container)).not.toContain('mw2604-01-1100-001');
    });

    it('never hands the formula to the server as a binding filter', () => {
        // The regression itself: a string in `binding.filter` becomes
        // `filters` on the wire and the query compiler refuses it with a 500.
        const seen = [];
        const node = {
            id: 'cmp_rl', type: 'input_relation',
            props: { name: 'line', label: 'L', tableId: 'tbl_qiline', filter: 'item.thread_key == vars.thread' },
            style: { span: 12 },
        };
        const key = dataCacheKey({ kind: 'records', tableId: 'tbl_qiline', limit: CANDIDATE_LIMIT }) as string;
        expect(key).not.toContain('item.thread_key');
        seen.push(key);
        render(
            <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', dataState: { [key]: { status: 'success', result: LINES } }, scope: { vars: { thread: 'demo-thread-001' } } }}>
                <AppForm node={{ id: 'f', type: 'form', visible: true, props: { name: 'fileops', showSubmit: false }, style: { span: 12 }, children: [node] }}>
                    <AppInputRelation node={node} />
                </AppForm>
            </RuntimeProvider>,
        );
        expect(seen[0]).toBe(`records:tbl_qiline:${JSON.stringify({ filter: null, limit: CANDIDATE_LIMIT, sort: null })}`);
    });
});
