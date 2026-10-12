import { fireEvent, render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import SolutionVersionsTab from './SolutionVersionsTab';

/**
 * De Versies-tab, in twee weergaven.
 *
 * Wat hier wordt vastgepind is de belofte uit de kop van de component: de
 * TEKSTLAAG mag omvallen, de DIFF niet. Een release waarvan het model geen enkele
 * zin schreef toont gewoon zijn rijen — dat is het exacte antwoord — met een
 * regel erbij die zegt waarom er geen woorden bij staan. Een lege tab op zo'n
 * versie zou de gebruiker leren dat er niets veranderd is.
 *
 * Daarnaast, en om dezelfde reden als op elk ander Oplossingsscherm: een
 * mislukte lees is geen lege geschiedenis.
 */

const ok = (releases) => ({ status: 'ok', data: { releases } });

/** Eén release waarin het model bij ELKE gewijzigde entiteit is omgevallen. */
const NO_SUMMARIES = {
    id: 'rel_2', version: 2, publishedAt: '2026-09-01T09:00:00Z',
    notes: {
        entities: [
            { kind: 'automation', entityId: 'aut_1', name: 'Nightly invoices', change: 'changed', text: null },
            { kind: 'app', entityId: 'app_1', name: 'Desk', change: 'changed', text: null },
            { kind: 'agent', entityId: 'agt_1', name: 'Helper', change: 'added', text: null },
            { kind: 'knowledge_base', entityId: 'kb_1', name: 'Handbook', change: 'unchanged', text: null },
        ],
        omitted: 0, textsDropped: false,
    },
};

const WITH_SUMMARIES = {
    id: 'rel_3', version: 3, publishedAt: '2026-09-05T09:00:00Z',
    notes: {
        entities: [
            { kind: 'app', entityId: 'app_1', name: 'Desk', change: 'changed', text: 'A second screen was added.' },
        ],
        omitted: 0, textsDropped: false,
    },
};

describe('knowing nothing versus having nothing', () => {
    it('a failed read says the history could not be read', () => {
        const { getByTestId, queryByTestId } = render(<SolutionVersionsTab remote={{ status: 'error', data: null }} />);
        expect(getByTestId('versions-unreadable')).toBeTruthy();
        expect(queryByTestId('versions-none')).toBeNull();
    });

    it('an empty list from a successful read says it has not been published yet', () => {
        const { getByTestId } = render(<SolutionVersionsTab remote={ok([])} />);
        expect(getByTestId('versions-none')).toBeTruthy();
    });

    it('while loading it says neither', () => {
        const { queryByTestId } = render(<SolutionVersionsTab remote={{ status: 'loading' }} />);
        expect(queryByTestId('versions-none')).toBeNull();
        expect(queryByTestId('versions-unreadable')).toBeNull();
    });
});

describe('what changed', () => {
    it('A VERSION WITH NO WRITTEN SUMMARIES STILL SHOWS THE WHOLE BOOLEAN DIFF', () => {
        const { getByTestId, getAllByTestId } = render(<SolutionVersionsTab remote={ok([NO_SUMMARIES])} />);
        // Vier rijen, verdeeld over de drie groepen — geen lege tab.
        expect(getAllByTestId('version-note-row').length).toBe(4);
        expect(getByTestId('version-group-changed').textContent).toMatch(/2 things changed/);
        expect(getByTestId('version-group-added').textContent).toMatch(/1 thing is new/);
        expect(getByTestId('version-group-unchanged').textContent).toMatch(/1 thing is unchanged/);
    });

    it('every row wears a chip with the word for what happened', () => {
        const { getAllByTestId } = render(<SolutionVersionsTab remote={ok([NO_SUMMARIES])} />);
        const chips = getAllByTestId('version-change-chip').map(c => c.textContent);
        expect(chips.sort()).toEqual(['Added', 'Changed', 'Changed', 'Unchanged']);
    });

    it('…and says, per row, that the line is the thing that is missing', () => {
        const { getAllByTestId } = render(<SolutionVersionsTab remote={ok([NO_SUMMARIES])} />);
        // Alleen op de twee GEWIJZIGDE rijen: een ongewijzigde rij mist geen
        // samenvatting, hij heeft geen nieuws.
        expect(getAllByTestId('version-note-nosummary').length).toBe(2);
    });

    it('a written line is shown where there is one', () => {
        const { getByText, queryByTestId } = render(<SolutionVersionsTab remote={ok([WITH_SUMMARIES])} />);
        expect(getByText('A second screen was added.')).toBeTruthy();
        expect(queryByTestId('version-note-nosummary')).toBeNull();
    });

    it('a version with NO recorded diff says so — not "nothing changed"', () => {
        const { getByTestId, queryByTestId } = render(
            <SolutionVersionsTab remote={ok([{ id: 'rel_1', version: 1, publishedAt: null, notes: null }])} />,
        );
        expect(getByTestId('version-unrecorded')).toBeTruthy();
        expect(queryByTestId('version-group-changed')).toBeNull();
    });

    it('names the two ways a note is thinner than the truth', () => {
        const { getByTestId } = render(<SolutionVersionsTab remote={ok([{
            id: 'r', version: 9, publishedAt: null,
            notes: {
                entities: [{ kind: 'app', entityId: 'a', name: 'Desk', change: 'changed', text: null }],
                omitted: 12, textsDropped: true,
            },
        }])} />);
        expect(getByTestId('version-texts-dropped')).toBeTruthy();
        expect(getByTestId('version-omitted').textContent).toMatch(/12 more entries/);
    });

    it('an entry whose change nobody recognises is counted out loud', () => {
        const { getByTestId } = render(<SolutionVersionsTab remote={ok([{
            id: 'r', version: 9, publishedAt: null,
            notes: { entities: [{ kind: 'app', entityId: 'a', name: 'Desk', change: 'sideways' }] },
        }])} />);
        expect(getByTestId('version-unreadable-rows').textContent).toMatch(/1 entry could not be placed/);
    });

    it('opens on the newest version, which is the one "what changed" means', () => {
        const { getByText, queryByText } = render(<SolutionVersionsTab remote={ok([WITH_SUMMARIES, NO_SUMMARIES])} />);
        expect(getByText('A second screen was added.')).toBeTruthy();
        expect(queryByText('Nightly invoices')).toBeNull();
    });
});

describe('all versions', () => {
    it('lists every publication with its own change count', () => {
        const { getByTestId, getAllByTestId } = render(<SolutionVersionsTab remote={ok([WITH_SUMMARIES, NO_SUMMARIES])} />);
        fireEvent.click(getByTestId('versions-view-all'));
        const rows = getAllByTestId('version-row');
        expect(rows.length).toBe(2);
        expect(rows[0].textContent).toMatch(/v3/);
        expect(rows[0].textContent).toMatch(/1 change/);
        // rel_2: twee gewijzigd + één toegevoegd = drie, het ongewijzigde telt niet.
        expect(rows[1].textContent).toMatch(/3 changes/);
    });

    it('a version with no recorded diff says "not recorded" in the list too', () => {
        const { getByTestId, getAllByTestId } = render(
            <SolutionVersionsTab remote={ok([{ id: 'r1', version: 1, publishedAt: null, notes: null }])} />,
        );
        fireEvent.click(getByTestId('versions-view-all'));
        expect(getAllByTestId('version-row')[0].textContent).toMatch(/not recorded/);
    });

    it('picking one opens it under "what changed"', () => {
        const { getByTestId, getAllByTestId, getByText } = render(
            <SolutionVersionsTab remote={ok([WITH_SUMMARIES, NO_SUMMARIES])} />,
        );
        fireEvent.click(getByTestId('versions-view-all'));
        fireEvent.click(getAllByTestId('version-row')[1]);
        expect(getByText('Nightly invoices')).toBeTruthy();
    });

    it('a release whose version could not be read says so rather than showing v0', () => {
        const { getByTestId, getAllByTestId } = render(
            <SolutionVersionsTab remote={ok([{ id: 'r1', version: 0, publishedAt: null, notes: { entities: [] } }])} />,
        );
        fireEvent.click(getByTestId('versions-view-all'));
        expect(getAllByTestId('version-row')[0].textContent).toMatch(/Version unknown/);
    });
});
