import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    authFetch: (...args) => authFetch(...args),
}));

import UsedByButtonsCapsule from './UsedByButtonsCapsule';

/**
 * "Gebruikt door 1 knop" — de capsule boven de routine-editor.
 *
 * Elke assertie hier gaat over één regel: DRIE UITSLAGEN DIE NIET MOGEN
 * SAMENVALLEN.
 *
 *   nog niet binnen  → niets tonen (geen aantal dat zo meteen verandert)
 *   mislukt          → "kon niet worden gecontroleerd", NOOIT "nergens gebruikt"
 *   leeg             → "nergens gebruikt", en alleen na een geslaagde lees
 *
 * Die middelste is de hele reden dat dit bestand bestaat. Een storing die als
 * "niemand gebruikt dit" leest, is precies de zin waarop iemand een routine
 * weggooit die een knop in productie aanzet — dezelfde val die W5 bij de
 * 409-poort dichtzette.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/components/automation/Builder/UsedByButtonsCapsule.test.jsx
 */

const authFetch = vi.fn();
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status = 500) => ({ ok: false, status, text: async () => 'usage_unavailable' });

const AID = 'auto_1';
const APP = '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7';

function row(over = {}) {
    return {
        automationId: AID,
        consumerKind: 'app',
        consumerId: APP,
        consumerTitle: 'Expenses',
        // De eigenaar van de ROUTINE (kolom `owner_user_id`), niet van de app —
        // de route filtert daarop tegen een routine die van eigenaar wisselde.
        automationOwner: 'u_owner',
        // Wie de APP mag openen zegt de SERVER; de client leidt het niet af.
        canOpen: true,
        refId: 'act:act_aaaa',
        actionId: 'act_aaaa',
        screenId: 'scr_dash01',
        nodeId: 'cmp_btn123',
        label: 'Submit claim',
        wired: true,
        organizationId: null,
        updatedAt: '2026-09-08T10:00:00.000Z',
        ...over,
    };
}

beforeEach(() => { cleanup(); authFetch.mockReset(); });
afterEach(cleanup);

describe('de drie uitslagen', () => {
    it('toont NIETS zolang het antwoord niet binnen is', () => {
        authFetch.mockReturnValue(new Promise(() => {}));   // blijft hangen
        const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
        expect(container.textContent).toBe('');
    });

    it('toont niets bij een mislukte lees, een lege lijst of een body zonder lijst', async () => {
        // Only a routine that buttons actually run gets the strip (owner,
        // 2026-09-28: "No app button runs this routine yet" was noise under
        // every header). The delete path keeps its own 409 check.
        for (const answer of [fail(500), ok({ error: 'nope' }), ok({ usage: [] }), ok({ usage: [], complete: false })]) {
            cleanup();
            authFetch.mockReset();
            authFetch.mockResolvedValue(answer);
            const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
            await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(container.textContent).toBe(''));
        }
    });

    it('toont ook niets als het netwerk helemaal niets teruggeeft', async () => {
        authFetch.mockRejectedValue(new Error('offline'));
        const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
        expect(container.textContent).toBe('');
    });
});

describe('het aantal', () => {
    it('is enkelvoud bij één knop', async () => {
        authFetch.mockResolvedValue(ok({ usage: [row()] }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        expect(await screen.findByText('Used by 1 button')).toBeTruthy();
    });

    it('is meervoud bij meer — nooit "button(s)"', async () => {
        authFetch.mockResolvedValue(ok({
            usage: [row(), row({ refId: 'act:act_bbbb', actionId: 'act_bbbb', label: 'Approve' })],
        }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        const chip = await screen.findByTestId('usedby-buttons-capsule');
        expect(chip.textContent).toContain('Used by 2 buttons');
        expect(chip.textContent).not.toContain('(s)');
    });
});

describe('de lijst', () => {
    it('klapt open en noemt app › knop, met een link naar de app', async () => {
        authFetch.mockResolvedValue(ok({ usage: [row()] }));
        const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
        fireEvent.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(screen.getByText('Expenses')).toBeTruthy();
        expect(screen.getByText('Submit claim')).toBeTruthy();
        const links = container.querySelectorAll('a');
        expect(links.length).toBe(1);
        expect(links[0].getAttribute('href')).toBe(`/app/studio/apps/${APP}`);
    });

    it('een actie zonder knop zegt dat met zoveel woorden', async () => {
        authFetch.mockResolvedValue(ok({ usage: [row({ wired: false, label: null, nodeId: null })] }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        fireEvent.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(screen.getByText('Not wired to a button yet')).toBeTruthy();
    });

    it('zonder canOpen is er een NAAM maar geen link — een 403 is erger dan geen link', async () => {
        // De naam mag: de rij is al eigenaar-gefilterd, dus deze kijker mocht
        // hem lezen. De LINK is een tweede vraag, en het antwoord komt van de
        // server. Zodra er een tweede consumer_kind bijkomt of één pad een app
        // overdraagt, is dit het verschil tussen een werkende link en een 403.
        authFetch.mockResolvedValue(ok({ usage: [row({ canOpen: false })] }));
        const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
        fireEvent.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(screen.getByText('Expenses')).toBeTruthy();
        expect(container.querySelectorAll('a').length).toBe(0);
    });

    it('een ontbrekend canOpen (oudere server) linkt ook niet — onbekend versmalt', async () => {
        const bare = row();
        delete bare.canOpen;
        authFetch.mockResolvedValue(ok({ usage: [bare] }));
        const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
        fireEvent.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(container.querySelectorAll('a').length).toBe(0);
    });

    it('een app zonder naam toont haar id — eerlijk, niet verzonnen', async () => {
        authFetch.mockResolvedValue(ok({ usage: [row({ consumerTitle: null })] }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        fireEvent.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(screen.getByText(APP)).toBeTruthy();
    });
});

describe('de vraag zelf', () => {
    it('vraagt de index om precies deze routine', async () => {
        authFetch.mockResolvedValue(ok({ usage: [row()] }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        await screen.findByText('Used by 1 button');
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(authFetch.mock.calls[0][0]).toContain(`/api/automation/${AID}/usage`);
    });

    it('toont het antwoord van de VORIGE routine niet bij een wissel', async () => {
        // Een getal dat over de verkeerde routine gaat is erger dan geen getal.
        authFetch.mockResolvedValueOnce(ok({ usage: [row()] }));
        const { rerender } = render(<UsedByButtonsCapsule automationId={AID} />);
        expect(await screen.findByText('Used by 1 button')).toBeTruthy();

        authFetch.mockReturnValueOnce(new Promise(() => {}));   // het tweede antwoord blijft hangen
        rerender(<UsedByButtonsCapsule automationId="auto_2" />);
        expect(screen.queryByText('Used by 1 button')).toBeNull();
        expect(screen.queryByTestId('usedby-buttons-capsule')).toBeNull();
    });

    it('vraagt niets zonder routine-id', async () => {
        const { container } = render(<UsedByButtonsCapsule automationId={null} />);
        await waitFor(() => expect(authFetch).not.toHaveBeenCalled());
        expect(container.textContent).toBe('');
    });
});

describe('een index die nog niet compleet is', () => {
    it('knoppen die hij AL kent, toont hij gewoon: die bestaan echt', async () => {
        authFetch.mockResolvedValue(ok({ usage: [row()], complete: false }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        expect((await screen.findByTestId('usedby-buttons-capsule')).textContent).toContain('Used by 1 button');
    });
});
