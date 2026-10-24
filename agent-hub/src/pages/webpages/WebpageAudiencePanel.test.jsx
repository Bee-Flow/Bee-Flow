import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WebpageAudiencePanel — "Who sees the page, and the address".
 *
 * `authFetch` supplies the contract of GET /api/webpages/:id/audience (server: core/webpages/webpagePublicAudience.js). `AudienceRows` is mocked: that component has its own test in components/shared, and here only THAT the three internal rows get the same handlers as the capsule counts.
 *
 * What is fixed here is what the screen may claim and what it may DO:
 *
 *   - the column choice is ASKED FOR, starts EMPTY on a page that was never public, and whatever is not ticked does not go along in the request;
 *   - "Public" is a switch beside the three rows, not a fourth round;
 *   - the screen itself says that tables there are read-only and that the Agent block does not run there;
 *   - the address stays shown when public is switched off.
 */

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

vi.mock('../../components/shared/AudienceRows', () => ({
    default: ({ disabled, onSetPersonal }) => (
        <div data-testid="audience-rows" data-disabled={String(!!disabled)} data-has-handler={String(!!onSetPersonal)} />
    ),
}));

import WebpageAudiencePanel, {
    initialColumnChoice, countChosenColumns, countPublicColumns, otherLinksNotice,
} from './WebpageAudiencePanel';

const MODEL = {
    internal: { mode: 'personal', isPublished: false, sharedGroups: [], organizationId: null },
    public: {
        on: false, shareId: null, accessMode: 'unlisted', hasPassword: false,
        allowedEmails: [], expiresAt: null, viewCount: 0, lastViewedAt: null,
        tablesReadOnly: true, agentRuns: false,
        aiKnown: true, aiRuns: false, aiGroundsOnPage: false,
    },
    address: null,
    columnGate: {
        tables: [{
            datatableId: 'tbl_1', label: 'Prijzen', columns: ['naam', 'prijs', 'inkoop'],
            publicColumns: [], mode: 'readwrite', publicMode: 'read', share: false,
        }],
        anyBound: true,
        sharingCount: 0,
    },
    shareCount: 0,
    solution: null,
};

function response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function model(over = {}) {
    return { ...JSON.parse(JSON.stringify(MODEL)), ...over };
}

beforeEach(() => { authFetch.mockReset(); });

describe('WebpageAudiencePanel', () => {
    it('renders the three shared rows with the same handlers the capsule uses', async () => {
        authFetch.mockResolvedValue(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" page={{ isPublished: false }} onSetPersonal={() => {}} />);

        const rows = await screen.findByTestId('audience-rows');
        expect(rows.getAttribute('data-has-handler')).toBe('true');
        expect(rows.getAttribute('data-disabled')).toBe('false');
    });

    it('disables the three rows when no write handler was passed down', async () => {
        authFetch.mockResolvedValue(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" page={{ isPublished: false }} />);
        expect((await screen.findByTestId('audience-rows')).getAttribute('data-disabled')).toBe('true');
    });

    it('says out loud that a public page is read-only and never runs the agent', async () => {
        authFetch.mockResolvedValue(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        expect(await screen.findByText(/Table blocks are read-only here/)).toBeInTheDocument();
        expect(screen.getByText(/An agent block never runs on a public share/)).toBeInTheDocument();
        expect(screen.getByText(/snapshot without scripts/)).toBeInTheDocument();
    });

    it('says that public AI is off when it is off', async () => {
        authFetch.mockResolvedValue(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        expect(await screen.findByTestId('public-ai')).toHaveTextContent(/cannot use the AI on this page/);
        expect(screen.queryByTestId('public-ai-change')).not.toBeInTheDocument();
    });

    it('says that anonymous readers spend the AI budget when public AI is ON', async () => {
        // The switch that costs money: bridge_grants.ai.publicEnabled places a REAL
        // beeflowAI bridge in the public document (server: routes/publicViewer.js →
        // publicShareBridge.js). There is no other screen in the editor that shows
        // it, so staying silent here would let the owner conclude that no AI runs
        // publicly.
        authFetch.mockResolvedValue(response(model({
            public: { ...MODEL.public, on: true, aiRuns: true, aiGroundsOnPage: true },
        })));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        expect(await screen.findByTestId('public-ai'))
            .toHaveTextContent(/charged to your AI budget/);
        expect(screen.getByTestId('public-ai-grounded'))
            .toHaveTextContent(/sources can reach outside readers/);
        // A warning you cannot act on is a half warning: changing it is possible only
        // from the page's own AI chat.
        expect(screen.getByTestId('public-ai-change')).toHaveTextContent(/AI chat/);
        // En de staart van de Agent-zin ("blijft leeg") is dan ONWAAR.
        expect(screen.queryByText(/stays blank for outside readers/)).not.toBeInTheDocument();
        expect(screen.getByText(/it does answer outside readers/)).toBeInTheDocument();
    });

    it('claims nothing about public AI when the switch could not be read', async () => {
        // An older server (or a failed read) does not send the three ai fields at all.
        // That is "not read", not "off".
        const zonderAi = { ...MODEL.public };
        delete zonderAi.aiKnown;
        delete zonderAi.aiRuns;
        delete zonderAi.aiGroundsOnPage;
        authFetch.mockResolvedValue(response(model({ public: zonderAi })));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        expect(await screen.findByTestId('public-ai')).toHaveTextContent(/could not be read/);
        expect(screen.queryByText(/cannot use the AI on this page/)).not.toBeInTheDocument();
    });

    it('asks which columns may go out, with nothing ticked to begin with', async () => {
        authFetch.mockResolvedValue(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByTestId('public-toggle'));

        expect(await screen.findByText('What may leave this page?')).toBeInTheDocument();
        expect(screen.getByText('Prijzen')).toBeInTheDocument();
        for (const key of ['naam', 'prijs', 'inkoop']) {
            expect(screen.getByLabelText(key).checked).toBe(false);
        }
        expect(screen.getByText('Nothing from your tables goes out.')).toBeInTheDocument();
        // Nothing published yet: only the GET has been done.
        expect(authFetch).toHaveBeenCalledTimes(1);
    });

    it('sends ONLY the ticked columns, and the unticked ones not at all', async () => {
        authFetch.mockResolvedValueOnce(response(model()));
        authFetch.mockResolvedValueOnce(response(model({ public: { ...MODEL.public, on: true } })));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByTestId('public-toggle'));
        fireEvent.click(await screen.findByLabelText('naam'));
        fireEvent.click(screen.getByTestId('gate-confirm'));

        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
        const [url, init] = authFetch.mock.calls[1];
        expect(url).toBe('https://host.example/api/webpages/wp1/audience/public');
        expect(init.method).toBe('PUT');
        const body = JSON.parse(init.body);
        expect(body.on).toBe(true);
        expect(body.publicColumns).toEqual({ tbl_1: ['naam'] });
    });

    it('publishes straight away when there is no table to ask about', async () => {
        const noTables = model({ columnGate: { tables: [], anyBound: false, sharingCount: 0 } });
        authFetch.mockResolvedValueOnce(response(noTables));
        authFetch.mockResolvedValueOnce(response({ ...noTables, public: { ...MODEL.public, on: true } }));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByTestId('public-toggle'));

        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
        expect(JSON.parse(authFetch.mock.calls[1][1].body).publicColumns).toEqual({});
        expect(screen.queryByText('What may leave this page?')).not.toBeInTheDocument();
    });

    it('an already-public page can still reach the gate, opened on its CURRENT choice', async () => {
        authFetch.mockResolvedValue(response(model({
            public: { ...MODEL.public, on: true },
            columnGate: {
                tables: [{ ...MODEL.columnGate.tables[0], publicColumns: ['naam'], share: true }],
                anyBound: true, sharingCount: 1,
            },
        })));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByTestId('public-columns'));
        expect(await screen.findByText('What may leave this page?')).toBeInTheDocument();
        expect(screen.getByLabelText('naam').checked).toBe(true);
        expect(screen.getByLabelText('inkoop').checked).toBe(false);
    });

    it('"Apply" under All options keeps the column choice instead of wiping it', async () => {
        // The pitfall: `publicColumns` ALWAYS goes along in the request, and the server
        // reads a missing table as zero columns. Whoever only adjusts the expiry date
        // must not, unnoticed, empty the public table with it.
        authFetch.mockResolvedValueOnce(response(model({
            public: { ...MODEL.public, on: true },
            columnGate: {
                tables: [{ ...MODEL.columnGate.tables[0], publicColumns: ['naam', 'prijs'], share: true }],
                anyBound: true, sharingCount: 1,
            },
        })));
        authFetch.mockResolvedValueOnce(response(model({ public: { ...MODEL.public, on: true } })));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByTestId('address-options-toggle'));
        fireEvent.click(screen.getByTestId('address-options-save'));

        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
        expect(JSON.parse(authFetch.mock.calls[1][1].body).publicColumns)
            .toEqual({ tbl_1: ['naam', 'prijs'] });
    });

    it('shows the address, and says it stays reserved while Public is off', async () => {
        authFetch.mockResolvedValue(response(model({
            address: { slug: 'prijzen-k3f9x2mq7bd4', path: '/w/prijzen-k3f9x2mq7bd4', url: 'https://beeflow.example/w/prijzen-k3f9x2mq7bd4' },
        })));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        expect((await screen.findByTestId('address-value')).textContent)
            .toBe('https://beeflow.example/w/prijzen-k3f9x2mq7bd4');
        expect(screen.getByText(/The address stays reserved while Public is off/)).toBeInTheDocument();
        // The address is not a label but a key; the screen says where it comes from and
        // that renaming does not move it.
        expect(screen.getByText(/the rest is random so the address cannot be guessed/)).toBeInTheDocument();
        expect(screen.getByText(/Renaming the page does not move it/)).toBeInTheDocument();
    });

    it('does not pretend there is an address before there is one', async () => {
        authFetch.mockResolvedValue(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" />);
        expect(await screen.findByText(/gets its address the first time you make it public/)).toBeInTheDocument();
        expect(screen.queryByTestId('address-value')).not.toBeInTheDocument();
    });

    it('keeps password and email under "All options", and warns that changing them replaces the link', async () => {
        authFetch.mockResolvedValue(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        expect(screen.queryByText(/Only these email addresses/)).not.toBeInTheDocument();
        fireEvent.click(await screen.findByTestId('address-options-toggle'));
        fireEvent.click(screen.getByLabelText('Only these email addresses'));

        expect(screen.getByText(/Email addresses, one per line/)).toBeInTheDocument();
        expect(screen.getByText(/replaces the underlying link/)).toBeInTheDocument();
        expect(screen.getByText(/The address itself stays the same/)).toBeInTheDocument();
    });

    it('turning Public off sends on:false and nothing else', async () => {
        authFetch.mockResolvedValueOnce(response(model({ public: { ...MODEL.public, on: true } })));
        authFetch.mockResolvedValueOnce(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByText('Turn off'));
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
        expect(JSON.parse(authFetch.mock.calls[1][1].body)).toEqual({ on: false });
    });

    it('names the solution this page belongs to', async () => {
        authFetch.mockResolvedValue(response(model({ solution: { id: 'p1', name: 'Offertes' } })));
        render(<WebpageAudiencePanel webpageId="wp1" />);
        expect(await screen.findByText('Part of solution Offertes')).toBeInTheDocument();
    });

    it('counts the columns that leave, in singular and in plural', async () => {
        const gate = (publicColumns) => ({
            columnGate: {
                tables: [
                    { datatableId: 'a', columns: ['x', 'z'], publicColumns, share: publicColumns.length > 0, publicMode: 'read' },
                    { datatableId: 'b', columns: ['y'], publicColumns: [], share: false, publicMode: 'read' },
                ],
                anyBound: true, sharingCount: publicColumns.length > 0 ? 1 : 0,
            },
        });
        authFetch.mockResolvedValue(response(model(gate(['x']))));
        const one = render(<WebpageAudiencePanel webpageId="wp1" />);
        expect(await screen.findByText('One column from a bound table appears on the public page.')).toBeInTheDocument();
        one.unmount();

        authFetch.mockResolvedValue(response(model(gate(['x', 'z']))));
        const many = render(<WebpageAudiencePanel webpageId="wp1" />);
        expect(await screen.findByText('2 columns from bound tables appear on the public page.')).toBeInTheDocument();
        many.unmount();

        authFetch.mockResolvedValue(response(model(gate([]))));
        render(<WebpageAudiencePanel webpageId="wp1" />);
        expect(await screen.findByText('No column from a bound table appears on the public page.')).toBeInTheDocument();
    });

    it('the ticked-column counter is singular for one and plural for more', async () => {
        authFetch.mockResolvedValue(response(model()));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByTestId('public-toggle'));
        fireEvent.click(await screen.findByLabelText('naam'));
        expect(screen.getByText('One column goes out.')).toBeInTheDocument();
        fireEvent.click(screen.getByLabelText('prijs'));
        expect(screen.getByText('2 columns go out.')).toBeInTheDocument();
    });

    it('mentions the other share links without calling them the address', async () => {
        // Public ON: then one of the three is the address, and the other two stand
        // beside it. With public OFF none of the three is the address any longer — that
        // state gets its own sentence, below.
        authFetch.mockResolvedValue(response(model({
            public: { ...MODEL.public, on: true }, shareCount: 3,
        })));
        render(<WebpageAudiencePanel webpageId="wp1" />);
        expect(await screen.findByText(/There are 3 external links on this page in total/)).toBeInTheDocument();
        expect(screen.getByText(/Only this one is the address/)).toBeInTheDocument();
    });

    it('shows the server\'s refusal instead of pretending the page went public', async () => {
        authFetch.mockResolvedValueOnce(response(model({ columnGate: { tables: [], anyBound: false, sharingCount: 0 } })));
        authFetch.mockResolvedValueOnce(response({ error: 'Password must be at least 6 characters' }, false, 400));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByTestId('public-toggle'));
        expect((await screen.findByTestId('audience-save-error')).textContent)
            .toBe('Password must be at least 6 characters');
        expect(screen.getByText('Make public')).toBeInTheDocument();
    });

    it('a non-owner gets a sentence, and no request is made at all', async () => {
        render(<WebpageAudiencePanel webpageId="wp1" readOnly />);
        expect(screen.getByText(/Only the page owner can change who can see this page/)).toBeInTheDocument();
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('an unreadable share reads as "could not be checked", never as "Off"', async () => {
        authFetch.mockResolvedValue(response(model({
            public: { ...MODEL.public, on: false, known: false },
        })));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        expect(await screen.findByText('Could not be checked')).toBeInTheDocument();
        expect(screen.queryByText('Off')).not.toBeInTheDocument();
        expect(screen.queryByTestId('public-toggle')).not.toBeInTheDocument();
        expect(screen.getByText(/nothing is claimed here and nothing can be changed/)).toBeInTheDocument();
    });

    it('says out loud that a leftover share link keeps serving after Public goes off', async () => {
        // Page with two live shares: the canonical one and a loose one. On on:false the
        // server withdraws only the canonical one, so shareCount drops from 2 to 1 —
        // precisely the threshold at which the old sentence disappeared.
        authFetch.mockResolvedValueOnce(response(model({
            public: { ...MODEL.public, on: true }, shareCount: 2, shareCountKnown: true,
            address: { slug: 'p-k3f9x2mq7bd4', path: '/w/p-k3f9x2mq7bd4', url: null },
        })));
        authFetch.mockResolvedValueOnce(response(model({
            shareCount: 1, shareCountKnown: true,
            address: { slug: 'p-k3f9x2mq7bd4', path: '/w/p-k3f9x2mq7bd4', url: null },
        })));
        render(<WebpageAudiencePanel webpageId="wp1" />);

        fireEvent.click(await screen.findByText('Turn off'));
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));

        expect(await screen.findByTestId('other-links-while-off')).toHaveTextContent(
            /Public is off, but one external link still serves a snapshot of this page/);
        expect(screen.getByTestId('other-links-while-off')).toHaveTextContent(/not the address/);
    });

    it('an unreadable share list is not read as "nothing is open any more"', async () => {
        authFetch.mockResolvedValue(response(model({ shareCount: 0, shareCountKnown: false })));
        render(<WebpageAudiencePanel webpageId="wp1" />);
        expect(await screen.findByTestId('other-links-unknown')).toHaveTextContent(
            /could not be checked/);
        expect(screen.queryByTestId('other-links-while-off')).not.toBeInTheDocument();
    });

    it('a failed load reads as "could not load", never as "not public"', async () => {
        authFetch.mockResolvedValue(response({ error: 'boom' }, false, 500));
        render(<WebpageAudiencePanel webpageId="wp1" />);
        expect(await screen.findByText('Could not load who can see this page.')).toBeInTheDocument();
        expect(screen.queryByTestId('public-toggle')).not.toBeInTheDocument();
    });
});

describe('initialColumnChoice / countChosenColumns', () => {
    it('starts empty for a page that was never public', () => {
        expect(initialColumnChoice({ tables: [{ datatableId: 't1', publicColumns: ['bsn'] }] }, false))
            .toEqual({ t1: [] });
    });

    it('starts from the current state for a page that is already public', () => {
        expect(initialColumnChoice({ tables: [{ datatableId: 't1', publicColumns: ['naam'] }] }, true))
            .toEqual({ t1: ['naam'] });
    });

    it('counts nothing for an absent or empty choice', () => {
        expect(countChosenColumns(null)).toBe(0);
        expect(countChosenColumns({ a: [], b: ['x', 'y'] })).toBe(2);
    });

    it('countPublicColumns survives a model that never arrived', () => {
        expect(countPublicColumns(null)).toBe(0);
        expect(countPublicColumns({ tables: [{ publicColumns: ['a'] }, {}] })).toBe(1);
    });
});

describe('otherLinksNotice', () => {
    const m = (over) => ({ public: { on: false, known: true }, shareCount: 0, shareCountKnown: true, ...over });

    it('mentions the others only when one of them IS the address', () => {
        expect(otherLinksNotice(m({ public: { on: true, known: true }, shareCount: 3 }))).toBe('while_on');
        expect(otherLinksNotice(m({ public: { on: true, known: true }, shareCount: 1 }))).toBe('none');
    });

    it('warns for a SINGLE leftover link once Public is off — the threshold flips', () => {
        expect(otherLinksNotice(m({ shareCount: 1 }))).toBe('while_off');
        expect(otherLinksNotice(m({ shareCount: 4 }))).toBe('while_off');
        expect(otherLinksNotice(m({ shareCount: 0 }))).toBe('none');
    });

    it('never turns an unreadable count into "nothing is open"', () => {
        expect(otherLinksNotice(m({ shareCount: 0, shareCountKnown: false }))).toBe('unknown');
    });

    it('claims nothing at all while the public state itself is unknown', () => {
        expect(otherLinksNotice(m({ public: { on: false, known: false }, shareCount: 2 }))).toBe('none');
    });

    it('survives a model that never arrived', () => {
        expect(otherLinksNotice(null)).toBe('none');
        expect(otherLinksNotice({})).toBe('none');
    });
});
