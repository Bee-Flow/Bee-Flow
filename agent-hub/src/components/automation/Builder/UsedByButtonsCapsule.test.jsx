import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    authFetch: (...args) => authFetch(...args),
}));

import UsedByButtonsCapsule from './UsedByButtonsCapsule';

/**
 * "Used by 1 button": the capsule above the automation editor.
 *
 * Every assertion here concerns one line: THREE OUTCOMES THAT MUST NOT COINCIDE.
 *
 *   not yet in   → show nothing (no number that is about to change)
 *   failed       → "could not be checked", NEVER "used nowhere"
 *   empty        → "used nowhere", and only after a successful read
 *
 * That middle one is the entire reason this file exists. A failure that reads as "nobody
 * uses this" is precisely the sentence on which someone throws away an automation that
 * switches a button on in production. It is the same trap that W5 closed off at the 409 gate.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/automation/Builder/UsedByButtonsCapsule.test.jsx
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
        // The owner of the AUTOMATION (column `owner_user_id`), not of the app. The route filters
        // on that, against an automation that changed owner.
        automationOwner: 'u_owner',
        // Who may OPEN the app is said by the SERVER; the client does not derive it.
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
        // Only an automation that buttons actually run gets the strip (owner,
        // 2026-09-28: "No app button runs this automation yet" was noise under
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
        const user = userEvent.setup();
        authFetch.mockResolvedValue(ok({ usage: [row()] }));
        const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
        await user.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(screen.getByText('Expenses')).toBeTruthy();
        expect(screen.getByText('Submit claim')).toBeTruthy();
        const links = container.querySelectorAll('a');
        expect(links.length).toBe(1);
        expect(links[0].getAttribute('href')).toBe(`/app/studio/apps/${APP}`);
    });

    it('een actie zonder knop zegt dat met zoveel woorden', async () => {
        const user = userEvent.setup();
        authFetch.mockResolvedValue(ok({ usage: [row({ wired: false, label: null, nodeId: null })] }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        await user.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(screen.getByText('Not wired to a button yet')).toBeTruthy();
    });

    it('zonder canOpen is er een NAAM maar geen link — een 403 is erger dan geen link', async () => {
        const user = userEvent.setup();
        // The name may be shown: the row is already owner-filtered, so this viewer was allowed to
        // read it. The LINK is a second question, and its answer comes from the server. The moment
        // a second consumer_kind is added, or one path hands over an app, this is the difference
        // between a working link and a 403.
        authFetch.mockResolvedValue(ok({ usage: [row({ canOpen: false })] }));
        const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
        await user.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(screen.getByText('Expenses')).toBeTruthy();
        expect(container.querySelectorAll('a').length).toBe(0);
    });

    it('een ontbrekend canOpen (oudere server) linkt ook niet — onbekend versmalt', async () => {
        const user = userEvent.setup();
        const bare = row();
        delete bare.canOpen;
        authFetch.mockResolvedValue(ok({ usage: [bare] }));
        const { container } = render(<UsedByButtonsCapsule automationId={AID} />);
        await user.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(container.querySelectorAll('a').length).toBe(0);
    });

    it('een app zonder naam toont haar id — eerlijk, niet verzonnen', async () => {
        const user = userEvent.setup();
        authFetch.mockResolvedValue(ok({ usage: [row({ consumerTitle: null })] }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        await user.click(await screen.findByTestId('usedby-buttons-capsule'));
        expect(screen.getByText(APP)).toBeTruthy();
    });
});

describe('de vraag zelf', () => {
    it('vraagt de index om precies deze automation', async () => {
        authFetch.mockResolvedValue(ok({ usage: [row()] }));
        render(<UsedByButtonsCapsule automationId={AID} />);
        await screen.findByText('Used by 1 button');
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(authFetch.mock.calls[0][0]).toContain(`/api/automation/${AID}/usage`);
    });

    it('toont het antwoord van de VORIGE automatisering niet bij een wissel', async () => {
        // A number about the wrong automation is worse than no number.
        authFetch.mockResolvedValueOnce(ok({ usage: [row()] }));
        const { rerender } = render(<UsedByButtonsCapsule automationId={AID} />);
        expect(await screen.findByText('Used by 1 button')).toBeTruthy();

        authFetch.mockReturnValueOnce(new Promise(() => {}));   // het tweede antwoord blijft hangen
        rerender(<UsedByButtonsCapsule automationId="auto_2" />);
        expect(screen.queryByText('Used by 1 button')).toBeNull();
        expect(screen.queryByTestId('usedby-buttons-capsule')).toBeNull();
    });

    it('vraagt niets zonder automation-id', async () => {
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
