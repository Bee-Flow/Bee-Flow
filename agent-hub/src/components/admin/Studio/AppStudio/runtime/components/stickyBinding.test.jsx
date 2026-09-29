import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import AppRenderer from '../AppRenderer';
import { dataCacheKey } from '../resolveBinding';

/**
 * A bound component must not BLANK while its next value loads.
 *
 * Every binding whose filter reads a selection re-keys the instant the
 * selection changes, so a component that renders a skeleton on `isLoading`
 * flashes a grey block on every click. useStickyBinding exists for exactly
 * that frame — it keeps the last value on screen — and most components already
 * used it. Two did not, and they sat one above the other at the top of a
 * detail pane: picking a different request drew a full-width grey bar across
 * the page before the new numbers arrived.
 *
 * Table-driven so the next component that resolves a scalar binding and
 * forgets to be sticky fails here rather than in front of a user.
 */

const SOURCE = { kind: 'aggregate', tableId: 'tbl_x', aggregates: [{ fn: 'count', as: 'n' }] };
const VALUE = { ...SOURCE, pick: { row: 'first', column: 'n' } };
const MAX = { ...SOURCE, pick: { row: 'first', column: 'total' } };

const KEY = dataCacheKey(SOURCE);

const loaded = { [KEY]: { status: 'success', result: [{ n: 3, total: 10 }], tableId: 'tbl_x' } };
const loading = { [KEY]: { status: 'loading', result: undefined, error: null, tableId: 'tbl_x' } };

// [type, props, what must still be readable once the next value is loading]
const CASES = [
    ['progress', { value: VALUE, max: MAX, format: 'fraction', label: 'Unpacking' }, '3 / 10'],
    [
        'stepper',
        { value: { ...SOURCE, pick: { row: 'first', column: 'stage' } }, steps: [{ value: 'a', label: 'Draft' }, { value: 'b', label: 'Sent' }] },
        'Sent',
    ],
];

const STEPPER_LOADED = { [KEY]: { status: 'success', result: [{ stage: 'b' }], tableId: 'tbl_x' } };

function defWith(type, props) {
    return {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_t',
        screens: [{
            id: 'scr_t', name: 'T', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [{
                id: 'sec_t', style: { padding: 4, gap: 3, background: 'none' },
                children: [{ id: 'cmp_x', type, visible: true, props, style: { span: 12 } }],
            }],
        }],
        actions: {},
    };
}

describe('a bound component whose next value is still loading', () => {
    it.each(CASES)('%s keeps what it was showing instead of flashing a skeleton', (type, props, visible) => {
        const first = type === 'stepper' ? STEPPER_LOADED : loaded;
        const { container, rerender } = render(
            <AppRenderer definition={defWith(type, props)} screenId="scr_t" mode="run" dataState={first} />,
        );
        expect(screen.getByText(visible)).toBeTruthy();

        rerender(
            <AppRenderer definition={defWith(type, props)} screenId="scr_t" mode="run" dataState={loading} />,
        );
        expect(container.querySelector('[data-app-skeleton="true"]')).toBeNull();
        expect(screen.getByText(visible)).toBeTruthy();
    });

    // The first load is the one time there is genuinely nothing to keep, and a
    // skeleton is the right answer there — sticky must not swallow it.
    it.each(CASES)('%s still shows a skeleton on a first-ever load', (type, props) => {
        const { container } = render(
            <AppRenderer definition={defWith(type, props)} screenId="scr_t" mode="run" dataState={loading} />,
        );
        expect(container.querySelector('[data-app-skeleton="true"]')).toBeTruthy();
    });
});
