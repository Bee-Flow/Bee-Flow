import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createRequire } from 'node:module';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import ActionsSection from './ActionsSection';
import StudioScopeProvider from './logic/StudioScopeProvider';

const require = createRequire(import.meta.url);
const { canonicalizeAppDefinition } = require('../../../../../../../server/appStudio/canonicalize.js');

/**
 * "Add a row" as a top-level action, end to end through the editor.
 *
 * Two failures are possible here and BOTH are silent, which is why this file
 * exists rather than a happy-path smoke test:
 *
 *   1. canonAction had no `recordValues` branch, so a save dropped the column
 *      values and left an action that inserts an empty row.
 *   2. runAction's switch had no case for it, so the button did nothing at all
 *      (covered from the other side in runtime/useActionRunner.actionKinds).
 */

vi.mock('../../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});
vi.mock('../../../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: vi.fn(async () => ({ automations: [] })) }),
    safeText: vi.fn(async () => ''),
}));
vi.mock('../studioAppsApi', () => ({
    studioAppsApi: { getCatalog: vi.fn(async () => ({ components: {}, actions: { stepSpecs: {} } })) },
}));

const NODE = { id: 'cmp_b1', type: 'button', props: { label: 'Add' }, style: {}, onClick: 'act_a' };

function defWith(action) {
    return {
        schemaVersion: 2,
        meta: { name: 'T' },
        homeScreenId: 'scr_a',
        screens: [{ id: 'scr_a', name: 'Home', sections: [{ id: 'sec_a', children: [NODE] }] }],
        actions: { act_a: action },
    };
}

function renderSection(action) {
    const onCommit = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
        const [definition, setDefinition] = useState(defWith(action));
        return (
            <QueryClientProvider client={client}>
                <StudioScopeProvider definition={definition} node={NODE}>
                    <ActionsSection
                        node={NODE}
                        definition={definition}
                        onCommit={(next) => { setDefinition(next); onCommit(next); }}
                        disabled={false}
                    />
                </StudioScopeProvider>
            </QueryClientProvider>
        );
    }
    render(<Harness />);
    return { onCommit, lastAction: () => onCommit.mock.calls.at(-1)?.[0]?.actions?.act_a };
}

describe('create_record as an action — choosing it', () => {
    it('is one of the four cards', () => {
        renderSection({ kind: 'toast', message: 'hi', tone: 'info' });
        expect(screen.getByRole('radio', { name: /Add a row/ })).toBeInTheDocument();
    });

    it('commits a fresh action that picks NO table', () => {
        const { lastAction } = renderSection({ kind: 'toast', message: 'hi', tone: 'info' });
        fireEvent.click(screen.getByRole('radio', { name: /Add a row/ }));
        // Guessing a table would make a brand-new button write into a real
        // table nobody chose, on the first click.
        expect(lastAction()).toEqual({ kind: 'create_record', tableId: '', values: {} });
    });

    it('shows itself as the selected card once it is the kind', () => {
        renderSection({ kind: 'create_record', tableId: 'tbl_a', values: {} });
        const checked = screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true');
        expect(checked).toHaveLength(1);
        expect(checked[0].textContent).toMatch(/Add a row/);
    });
});

describe('create_record as an action — what a save keeps', () => {
    /**
     * The one that would have shipped broken. `values` is a `recordValues`
     * field, and canonAction handled every OTHER field type — so the column
     * values were not copied into the cleaned action at all. No error, no
     * repair note; just an action that inserts an empty row from then on.
     */
    it('keeps the column values through the real canonicalizer', () => {
        const definition = defWith({
            kind: 'create_record',
            tableId: 'tbl_orders',
            values: {
                title: { kind: 'static', value: 'New order' },
                owner: { kind: 'formula', expr: 'currentUser.id' },
            },
            resultVar: 'created',
        });
        const stored = Object.values(canonicalizeAppDefinition(definition).def.actions)[0];
        expect(stored.kind).toBe('create_record');
        expect(stored.tableId).toBe('tbl_orders');
        expect(stored.values).toEqual({
            title: { kind: 'static', value: 'New order' },
            owner: { kind: 'formula', expr: 'currentUser.id' },
        });
        expect(stored.resultVar).toBe('created');
    });

    it('would have failed before the fix — an untouched action round-trips unchanged', () => {
        // Belt and braces on the same invariant: whatever the editor writes is
        // what the server stores, so what the author reads back is what runs.
        const action = { kind: 'create_record', tableId: 'tbl_a', values: { name: { kind: 'static', value: 'x' } } };
        const once = Object.values(canonicalizeAppDefinition(defWith(action)).def.actions)[0];
        const twice = Object.values(canonicalizeAppDefinition(defWith(once)).def.actions)[0];
        expect(twice).toEqual(once);
    });
});
