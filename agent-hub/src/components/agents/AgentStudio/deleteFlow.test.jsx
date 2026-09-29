/**
 * Deleting an agent that something still uses — the whole round trip.
 *
 * THE REGRESSION THIS PINS. The server grew a gate: DELETE /agents/:id refuses
 * unless `?confirm=1` is present, whenever anything still uses the agent OR the
 * check could not answer. No client sent that parameter, so deleting a
 * published agent any colleague had ever chatted with simply failed, and the
 * dialog showed the raw JSON body on its error line. Both ENDS were fine — the
 * server refused correctly, the dialog posted correctly — and the hop between
 * them did not exist. That is the same shape as the bug one layer down, where
 * a simulation was written onto a context and read off a different one.
 *
 * So this test walks the hop: press Delete, get the 409, and prove the SECOND
 * press carries ?confirm=1. A textual assertion on either side would pass on
 * the broken version.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentStudio/deleteFlow.test.jsx
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const authFetch = vi.fn();
vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...a) => authFetch(...a),
    parseSaveError: vi.fn(async () => ({ message: 'save failed' })),
}));
vi.mock('../../../hooks/useTranslation', () => import('../../../test/useTranslationMock'));
// The editor panes are irrelevant here and drag half the builder in.
vi.mock('../AgentWizard/index', () => ({ default: () => <div data-testid="wizard" /> }));
vi.mock('../AgentWizard/BuilderSplit', () => ({ default: () => <div data-testid="split" /> }));
vi.mock('../AgentWizard/AgentEditorBootstrapContext', () => ({
    AgentEditorBootstrapProvider: ({ children }) => <>{children}</>,
    // Het overzicht leest categorieën en groepen uit dit contract.
    useAgentEditorBootstrap: () => ({
        categories: [],
        orgGroups: [{ id: 'g1', name: 'Sales team' }],
    }),
}));

import AgentStudio from './index';

// `can_edit: true` is geen decoratie: sinds A5 deel C toont de kaart de
// prullenbak alleen bij een EXPLICIETE true (`/agents/all` zet hem altijd;
// `/agents/system` niet, en zo'n rij hield hem daarvoor stilzwijgend).
const AGENT = { id: 'agent-1', name: 'Helpdesk', description: '', config: {}, can_edit: true };

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const conflict = (body) => ({
    ok: false,
    status: 409,
    json: async () => body,
    text: async () => JSON.stringify(body),
});

/** Press the row's delete button, then the red button in the dialog. */
async function openAndConfirm() {
    fireEvent.click(await screen.findByLabelText(/Delete: Helpdesk/i));
    fireEvent.click(screen.getByText('Delete'));
}

const deleteCalls = () => authFetch.mock.calls.filter(([, opt]) => opt && opt.method === 'DELETE');

beforeEach(() => {
    authFetch.mockReset();
    // The list load; every later call is set per test.
    authFetch.mockImplementation(async (url) => {
        if (String(url).includes('/agents/all') || String(url).includes('/agents/system')) return ok([AGENT]);
        return ok({ success: true });
    });
});
afterEach(cleanup);

describe('delete → 409 → delete anyway', () => {
    it('does NOT send confirm on the first press', async () => {
        render(<AgentStudio user={{ id: 'u1' }} />);
        await openAndConfirm();
        await waitFor(() => expect(deleteCalls().length).toBe(1));
        expect(String(deleteCalls()[0][0])).not.toContain('confirm');
    });

    it('shows what is in use instead of a raw error, and the second press carries ?confirm=1', async () => {
        const body = {
            error: 'This agent is still in use',
            code: 'in_use',
            rows: [{ kind: 'automation', id: 'a1', foreign: false }],
            counts: { automation: 3 },
            chat: { othersConversationCount: 12 },
            unchecked: [],
        };
        authFetch.mockImplementation(async (url, opt) => {
            if (opt && opt.method === 'DELETE') {
                return String(url).includes('confirm=1') ? ok({ success: true }) : conflict(body);
            }
            return ok([AGENT]);
        });

        render(<AgentStudio user={{ id: 'u1' }} />);
        await openAndConfirm();

        // The refusal became a readable dialog, not an error string.
        await screen.findByTestId('delete-blocked');
        expect(screen.getByText('Routines')).toBeTruthy();
        expect(screen.getByText('3')).toBeTruthy();
        expect(screen.getByText('12')).toBeTruthy();

        // THE HOP.
        fireEvent.click(screen.getByText('Delete anyway'));
        await waitFor(() => expect(deleteCalls().length).toBe(2));
        expect(String(deleteCalls()[1][0])).toContain('confirm=1');
    });

    it('a 409 whose body cannot be read says so, and does not claim the agent is in use', async () => {
        authFetch.mockImplementation(async (url, opt) => {
            if (opt && opt.method === 'DELETE') {
                if (String(url).includes('confirm=1')) return ok({ success: true });
                // An HTML error page, a proxy body — anything but JSON.
                return { ok: false, status: 409, json: async () => { throw new Error('not json'); }, text: async () => '<html>' };
            }
            return ok([AGENT]);
        });

        render(<AgentStudio user={{ id: 'u1' }} />);
        await openAndConfirm();

        await screen.findByTestId('delete-blocked');
        // Not "still in use" — nothing was found, only unanswered.
        expect(screen.queryByText('This agent is still in use')).toBeNull();
        expect(screen.getByText('Could not check what uses this agent')).toBeTruthy();
        expect(screen.getByTestId('delete-blocked-unreadable')).toBeTruthy();
        // The "could not be checked" line is present at all — which is the
        // point: an unreadable body must not render as an empty list. WHICH
        // kinds it names is asserted in deleteBlock.test.js, where the labels
        // are not at the mercy of the identity translator used here.
        expect(screen.getByTestId('delete-blocked-unchecked')).toBeTruthy();
        // The override still exists — the server already decided a human must
        // choose, and hiding the button would leave no path at all.
        expect(screen.getByText('Delete anyway')).toBeTruthy();
    });

    it('an unreadable chat count is stated, not shown as zero', async () => {
        authFetch.mockImplementation(async (url, opt) => {
            if (opt && opt.method === 'DELETE') {
                return conflict({ code: 'in_use', rows: [], counts: {}, chat: null, unchecked: ['app'] });
            }
            return ok([AGENT]);
        });
        render(<AgentStudio user={{ id: 'u1' }} />);
        await openAndConfirm();
        await screen.findByTestId('delete-blocked-chat-unknown');
        expect(screen.queryByTestId('delete-blocked-chat')).toBeNull();
    });

    it('cancelling clears the block, so the next delete starts unconfirmed again', async () => {
        authFetch.mockImplementation(async (url, opt) => {
            if (opt && opt.method === 'DELETE') {
                return String(url).includes('confirm=1')
                    ? ok({ success: true })
                    : conflict({ code: 'in_use', rows: [], counts: {}, chat: { othersConversationCount: 2 }, unchecked: [] });
            }
            return ok([AGENT]);
        });
        render(<AgentStudio user={{ id: 'u1' }} />);
        await openAndConfirm();
        await screen.findByTestId('delete-blocked');

        fireEvent.click(screen.getByText('Cancel'));
        await openAndConfirm();
        // Second run: the first press must be unconfirmed again, or a stale
        // block would turn an ordinary delete into a forced one.
        await waitFor(() => expect(deleteCalls().length).toBe(2));
        expect(String(deleteCalls()[1][0])).not.toContain('confirm');
    });
});

/**
 * De naden die het scherm zijn betekenis geven, en die geen van alle een eigen
 * test hadden: de deeplink, de groepsnamen, en de opt-in usage-parameter.
 */
describe('de naden van het overzicht', () => {
    it('/app/agent-wizard opent de wizard, niet het overzicht', async () => {
        // Zonder `startInWizard` landt die deeplink op het kaartraster en
        // betekent hij stilzwijgend iets anders dan hij zegt.
        render(<AgentStudio user={{ id: 'u1' }} startInWizard />);
        expect(await screen.findByTestId('wizard')).toBeTruthy();
        expect(screen.queryByTestId('agent-card')).toBeNull();
    });

    it('zonder die vlag is het overzicht de landing', async () => {
        render(<AgentStudio user={{ id: 'u1' }} />);
        expect(await screen.findByTestId('agent-card')).toBeTruthy();
        expect(screen.queryByTestId('wizard')).toBeNull();
    });

    it('vraagt de used-by-tellers op — dit scherm is de enige plek die ze toont', async () => {
        render(<AgentStudio user={{ id: 'u1' }} />);
        await screen.findByTestId('agent-card');
        const list = authFetch.mock.calls.map(([url]) => String(url)).find(u => u.includes('/agents/all'));
        expect(list).toContain('usage=1');
    });

    it('de metaregel noemt de GROEP bij naam, niet zijn uuid', async () => {
        authFetch.mockImplementation(async (url) => {
            if (String(url).includes('/agents/all')) {
                return ok([{ ...AGENT, is_published: 1, shared_groups: ['g1'] }]);
            }
            return ok({ success: true });
        });
        render(<AgentStudio user={{ id: 'u1' }} />);
        const card = await screen.findByTestId('agent-card');
        expect(card.textContent).toContain('Sales team');
        expect(card.textContent).not.toContain('g1');
    });
});
