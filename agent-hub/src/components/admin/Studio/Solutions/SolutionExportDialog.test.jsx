import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));

import SolutionExportDialog from './SolutionExportDialog';

/**
 * The export dialog's own claim — not the Blueprint tab's, which has its own
 * nine pinned cases.
 *
 * "Whoever installs it has to supply …" is drawn entirely from
 * `completeness.requires`, so an empty dialog is what BOTH "nothing needs
 * supplying" and "the checks never ran" look like. SolutionDetail deliberately
 * drops the previous answer when the completeness fetch fails, which makes
 * `completeness === null` the common case rather than the rare one — and that
 * was the one state that used to show no caveat at all.
 */

const REQUIRES = {
    items: [{ kind: 'datatable', stepId: 's1', datatableKey: 'invoices', automationTitle: 'Nightly' }],
};

const open = (completeness) => render(
    <SolutionExportDialog
        open
        onClose={() => {}}
        projectId="p1"
        projectName="Invoice desk"
        role="owner"
        completeness={completeness}
    />,
);

describe('what the preview is worth', () => {
    it('says the checks never ran when there is no answer at all', () => {
        const { getByTestId, queryByTestId } = open(null);
        expect(getByTestId('solution-export-unchecked')).toBeTruthy();
        expect(queryByTestId('solution-requires-preview')).toBeNull();
    });

    it('says the list may be short when part of the Solution could not be read', () => {
        const { getByTestId } = open({ complete: false, requires: REQUIRES });
        expect(getByTestId('solution-export-incomplete')).toBeTruthy();
        expect(getByTestId('solution-requires-preview')).toBeTruthy();
    });

    it('an answer carrying no verdict is not treated as a clean one', () => {
        // A payload off a cache, or from a server that predates the field.
        const { getByTestId } = open({ requires: REQUIRES });
        expect(getByTestId('solution-export-incomplete')).toBeTruthy();
    });

    it('stays silent only when the server said it read the whole Solution', () => {
        const { queryByTestId, getByText } = open({ complete: true, requires: REQUIRES });
        expect(queryByTestId('solution-export-unchecked')).toBeNull();
        expect(queryByTestId('solution-export-incomplete')).toBeNull();
        // And the list itself still names the step and the author's own key.
        expect(getByText('a table for "invoices" · step s1 · in Nightly')).toBeTruthy();
    });
});
