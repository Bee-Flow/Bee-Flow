import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SourcePanel from './SourcePanel';

/**
 * The two strings the table takeover shows — the "Fields" way back, and the
 * "nothing captured yet" line inside OutputView — were the last hardcoded
 * English in this panel.
 *
 * Hardcoded English and translated English render the same, so each is
 * asserted twice: once on the shipped English, and once with a Dutch
 * dictionary switched in over the REAL useTranslation. Only a key can change
 * what the second render says.
 */
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

/** One step whose output was never captured: the table opens on nothing. */
const EMPTY_GROUP = {
    id: 's1',
    label: 'Gmail search',
    kind: 'integration_action',
    basePath: 'steps.s1.output',
    sample: null,
    fields: [],
};

const NL = {
    'routines.mapping.fields': 'Velden',
    'routines.mapping.no_data_yet': 'Nog geen data — draai de vorige stap om die vast te leggen.',
};

/** Render, then take the table takeover — where both strings live. */
const openTable = (label) => {
    render(<SourcePanel groups={[EMPTY_GROUP]} previewSample={null} onPick={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(label));
};

beforeEach(() => { cleanup(); transOverride.current = null; });

describe('SourcePanel i18n — the table takeover', () => {
    it('shows the English way back and the English empty line', () => {
        openTable('Open Gmail search as a table');
        expect(screen.getByRole('button', { name: /Fields/ })).toBeTruthy();
        expect(screen.getByText('No data yet — run the upstream step to capture it.')).toBeTruthy();
    });

    it('translates the way back, so it is not hardcoded English', () => {
        transOverride.current = NL;
        openTable('Open Gmail search as a table');
        expect(screen.getByRole('button', { name: /Velden/ })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Fields$/ })).toBeNull();
    });

    it('translates the empty line, so it is not hardcoded English either', () => {
        transOverride.current = NL;
        openTable('Open Gmail search as a table');
        expect(screen.getByText('Nog geen data — draai de vorige stap om die vast te leggen.')).toBeTruthy();
        expect(screen.queryByText('No data yet — run the upstream step to capture it.')).toBeNull();
    });

    it('the way back really goes back — the key did not replace the behaviour', () => {
        transOverride.current = NL;
        openTable('Open Gmail search as a table');
        fireEvent.click(screen.getByRole('button', { name: /Velden/ }));
        expect(screen.getByLabelText('Search fields')).toBeTruthy();
    });
});
