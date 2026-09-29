import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import DatatableFields from './datatableEditors';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

/**
 * The Datatable step with nothing to pick from.
 *
 * This empty state used to read "An administrator creates them in Studio →
 * Datatables", with no link — a locked door with somebody else's name on it,
 * and the server has never agreed with it. POST /api/datatables gates the
 * ORGANISATION scope on `manage_datatables` and nothing else
 * (server/routes/datatables/tables.js); a personal table is open to any signed-in
 * account. So the copy sent a person to a colleague who could not help them
 * either, about a table they were free to make themselves.
 *
 * What is pinned here is therefore both halves of the fix, because either one
 * alone brings the dead end back: the copy must not attribute the work to an
 * administrator, and there must be a link to walk through. The exact
 * permission stays reachable for the power user — demoted to the tooltip, not
 * deleted — so the administrator this gets forwarded to has the string to
 * grant.
 */
const CATALOG = { datatables: [], datatableOps: [] };

function renderEmpty() {
    render(
        <VariablePickerProvider groups={[]} previewSample={{}} stepLabelById={new Map()}>
            <DatatableFields
                draft={{ op: 'find_rows' }}
                set={() => {}}
                groups={[]}
                catalog={CATALOG}
            />
        </VariablePickerProvider>,
    );
}

describe('the Datatable step with no tables yet', () => {
    beforeEach(cleanup);

    it('does not tell the author an administrator has to do it', () => {
        renderEmpty();
        expect(screen.queryByText(/an administrator creates them/i)).toBeNull();
        expect(screen.getByText(/you can make one yourself/i)).toBeInTheDocument();
    });

    it('offers a working way in, in a new tab so the unsaved canvas survives', () => {
        renderEmpty();
        const link = screen.getByRole('link', { name: /Studio . Datatables/ });
        expect(link).toHaveAttribute('href', '/app/studio/datatables');
        expect(link).toHaveAttribute('target', '_blank');
    });

    it('names the permission in words and keeps the exact one in the tooltip', () => {
        renderEmpty();
        // The sentence a non-technical author reads...
        expect(screen.getByText(/a permission an administrator grants/i)).toBeInTheDocument();
        // ...over the string the administrator actually has to grant.
        expect(screen.getByTitle('manage_datatables')).toBeInTheDocument();
    });
});
