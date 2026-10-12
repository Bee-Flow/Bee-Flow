import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "May use" when a list did not come back.
 *
 * The failure this file exists for is the one that looks like success: a read
 * that fell over resolving to an empty array, and a picker then telling
 * somebody their organisation has no automations, no knowledge bases, no apps.
 * Every claim on this card is either about a list that ARRIVED or it is not
 * made, and the three answers — not read yet / could not read / read and
 * empty — get three different sentences.
 *
 * The apps half carries the same rule the other way round: with no answer
 * about what the org has connected, the catalog NARROWS to the platform
 * built-ins. An unknown gate must never offer more than a known one.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

// The integration-status hook is module-cached, so it is driven from here
// rather than through fetch: one test's success would otherwise be every
// later test's answer. The hook's own contract is pinned next to its source
// (hooks/useIntegrationStatus.test.jsx).
const { appStatus } = vi.hoisted(() => ({ appStatus: { integrationStatus: {}, unavailable: false } }));
vi.mock('../../../../hooks/useIntegrationStatus', () => ({
    useIntegrationStatus: () => appStatus,
    invalidateIntegrationStatus: () => {},
}));

import CanUseCard from './CanUseCard';
import SkillDetail from './SkillDetail';
import useSkillPickerData from './useSkillPickerData';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const dead = (status = 500) => ({ ok: false, status, json: async () => ({}) });

/** Every list answers; override one path per test. */
function routeFetch(overrides = {}) {
    fetchMock.mockImplementation(async (url) => {
        for (const [fragment, answer] of Object.entries(overrides)) {
            if (String(url).includes(fragment)) return typeof answer === 'function' ? answer() : answer;
        }
        if (String(url).includes('/auth/groups')) return ok([]);
        if (String(url).includes('/api/automation')) return ok({ automations: [] });
        if (String(url).includes('/api/kb')) return ok([]);
        if (String(url).includes('/api/datatables')) return ok({ datatables: [] });
        return ok({});
    });
}

function card(props = {}) {
    return render(
        <CanUseCard
            enabledIntegrations={[]}
            allowedAutomationIds={[]}
            knowledgeBaseIds={[]}
            dynamicActivation={false}
            automations={[]}
            knowledgeBases={[]}
            onChange={() => {}}
            {...props}
        />,
    );
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    appStatus.integrationStatus = {};
    appStatus.unavailable = false;
    routeFetch();
});

describe('the picker lists', () => {
    it('names a automations list it could not read instead of reporting an empty one', async () => {
        routeFetch({ '/api/automation': dead(500) });
        const { result } = renderHook(() => useSkillPickerData(true));

        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.unavailable).toContain('automations');
        expect(result.current.unavailable).not.toContain('kbs');
        expect(result.current.automations).toEqual([]);
    });

    /**
     * A refusal is a fine reason to offer nothing and a terrible reason to
     * tell somebody their organisation has nothing.
     */
    it('counts a refused read as unread too', async () => {
        routeFetch({ '/api/kb': dead(403) });
        const { result } = renderHook(() => useSkillPickerData(true));

        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.unavailable).toContain('kbs');
    });

    it('counts a 200 that is not a list as unread — an answer nobody can parse is not an answer', async () => {
        routeFetch({ '/api/datatables': ok({ error: 'nope' }) });
        const { result } = renderHook(() => useSkillPickerData(true));

        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.unavailable).toContain('tables');
        expect(result.current.datatables).toEqual([]);
    });

    it('claims nothing before the first answer', () => {
        const { result } = renderHook(() => useSkillPickerData(true));
        expect(result.current.loaded).toBe(false);
        expect(result.current.unavailable).toEqual([]);
    });

    /**
     * Two contracts in one read: the knowledge bases are asked for in the
     * AGENT context, and only an `agent_call` automation is offered — "may use"
     * means "offered as a tool", and the runtime dispatches nothing else.
     */
    it('asks the knowledge bases for the agent context and offers only agent_call automations', async () => {
        routeFetch({
            '/api/automation': ok({
                automations: [
                    { id: 'a1', title: 'Callable', triggerKind: 'agent_call' },
                    { id: 'a2', title: 'Nightly', triggerKind: 'schedule' },
                    { id: 'a3', title: 'Unknown trigger' },
                ],
            }),
        });
        const { result } = renderHook(() => useSkillPickerData(true));

        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.automations.map(a => a.id)).toEqual(['a1']);
        expect(result.current.unavailable).toEqual([]);
        const asked = fetchMock.mock.calls.map(([url]) => String(url));
        expect(asked.some(u => u.includes('/api/kb?context=agent'))).toBe(true);
    });
});

describe('"may use" — a list that could not be read', () => {
    it('does not say “nothing to link” about a list it never read, and names the list', () => {
        card({ listStatus: { loaded: true, unavailable: ['automations'] } });
        fireEvent.click(screen.getByTestId('skill-grant-add'));

        expect(screen.queryByTestId('skill-grant-none')).toBeNull();
        expect(screen.getByTestId('skill-grant-menu-gap')).toBeTruthy();
        expect(screen.getByTestId('skill-grant-gap').textContent).toContain('automations');
    });

    it('claims nothing at all before the lists arrive', () => {
        card({ listStatus: { loaded: false, unavailable: [] } });
        fireEvent.click(screen.getByTestId('skill-grant-add'));

        expect(screen.getByTestId('skill-grant-loading')).toBeTruthy();
        expect(screen.queryByTestId('skill-grant-none')).toBeNull();
        expect(screen.queryByTestId('skill-grant-gap')).toBeNull();
    });

    /**
     * The other half of the pair. Over-correcting into "we could not read
     * this" for an org that genuinely has no agent-callable automation would
     * hide the one sentence that tells the author how to get one.
     */
    it('still says “nothing to link”, with the reason, when the lists arrived empty', () => {
        card({ listStatus: { loaded: true, unavailable: [] } });
        fireEvent.click(screen.getByTestId('skill-grant-add'));

        expect(screen.getByTestId('skill-grant-none').textContent).toMatch(/an agent calls it/);
        expect(screen.queryByTestId('skill-grant-menu-gap')).toBeNull();
        expect(screen.queryByTestId('skill-grant-gap')).toBeNull();
    });

    /** A gap in a list this menu does not offer is not this menu's sentence. */
    it('leaves the groups and datatables gaps to the screens that show them', () => {
        card({ listStatus: { loaded: true, unavailable: ['groups', 'tables'] } });
        fireEvent.click(screen.getByTestId('skill-grant-add'));

        expect(screen.getByTestId('skill-grant-none')).toBeTruthy();
        expect(screen.queryByTestId('skill-grant-gap')).toBeNull();
    });

    it('keeps a grant it cannot name, and explains the id instead of dropping the pill', () => {
        card({
            allowedAutomationIds: ['aut_7'],
            listStatus: { loaded: true, unavailable: ['automations'] },
        });
        expect(screen.getByTestId('skill-grant').textContent).toContain('aut_7');
        expect(screen.getByTestId('skill-grant-gap')).toBeTruthy();
    });
});

describe('"may use" — the apps half', () => {
    /**
     * `{}` is a real settings payload AND what a broken read used to hand
     * over, and `filterAvailableIntegrations` reads it as "no org gate to
     * apply" — so an unreadable status offered MORE apps than a healthy one.
     * Unknown narrows: built-ins only, and the card says why the list is short.
     */
    it('offers only the platform built-in when it could not check what the org has connected', () => {
        appStatus.unavailable = true;
        card({ listStatus: { loaded: true, unavailable: [] } });

        expect(screen.getByTestId('skill-grant-gap').textContent).toContain('apps');
        fireEvent.click(screen.getByTestId('skill-grant-add'));
        fireEvent.click(screen.getByRole('menuitem', { name: /Browse apps/ }));

        expect(screen.getAllByText('Agent Search').length).toBeGreaterThan(0);
        expect(screen.queryByRole('button', { name: /Browse Web/ })).toBeNull();
    });

    it('offers the catalog normally when the same payload came back from a read that worked', () => {
        appStatus.integrationStatus = {};
        appStatus.unavailable = false;
        card({ listStatus: { loaded: true, unavailable: [] } });

        expect(screen.queryByTestId('skill-grant-gap')).toBeNull();
        fireEvent.click(screen.getByTestId('skill-grant-add'));
        fireEvent.click(screen.getByRole('menuitem', { name: /Browse apps/ }));

        expect(screen.getByRole('button', { name: /Browse Web/ })).toBeTruthy();
    });

    it('names both gaps in one sentence when neither the apps nor the automations came back', () => {
        appStatus.unavailable = true;
        card({ listStatus: { loaded: true, unavailable: ['automations', 'kbs'] } });

        const note = screen.getByTestId('skill-grant-gap').textContent;
        expect(note).toContain('apps');
        expect(note).toContain('automations');
        expect(note).toContain('knowledge bases');
    });

    /**
     * The OTHER unknown. `unavailable` covers the read that failed; before the
     * first answer `integrationStatus` is simply null, and
     * `filterAvailableIntegrations` reads null as "no org gate to apply" and
     * hands back the whole catalog — so the first navigation of a session
     * offered apps the org has never connected, and the runtime refuses them
     * later. Unknown narrows in BOTH shapes or it narrows in neither.
     */
    it('narrows the catalog before the status has answered at all, not just after it failed', () => {
        appStatus.integrationStatus = null;
        appStatus.unavailable = false;
        card({ listStatus: { loaded: true, unavailable: [] } });

        fireEvent.click(screen.getByTestId('skill-grant-add'));
        fireEvent.click(screen.getByRole('menuitem', { name: /Browse apps/ }));

        expect(screen.getAllByText('Agent Search').length).toBeGreaterThan(0);
        expect(screen.queryByRole('button', { name: /Browse Web/ })).toBeNull();
        // …and it is NOT reported as a gap: nothing failed, the answer is
        // merely not here yet.
        expect(screen.queryByTestId('skill-grant-gap')).toBeNull();
    });
});

/**
 * ── THE JOIN ────────────────────────────────────────────────────────
 * Everything above drives the card and the hook SEPARATELY: the card is handed
 * a `listStatus` by hand, the hook is read on its own. The one line that
 * connects them lives in SkillDetail, and deleting it (measured) left all
 * thirteen card tests and all five hook tests green while the product went back
 * to saying "nothing else to link" about a automations list that 500'd. So the
 * wiring is exercised end to end, from a failing endpoint to the sentence.
 */
describe('the detail wires the hook to the screens that make the claims', () => {
    const SKILL = {
        id: 'sk1',
        name: 'Explain a quote',
        canEdit: true,
        steps: [{ id: 's1', text: 'Look it up', refs: [] }],
        rulesV2: [],
        examplesV2: [],
    };

    const detail = () => render(<SkillDetail skill={SKILL} canManage onBack={() => {}} />);

    it('carries a failed automations read into BOTH the may-use card and the step reference menu', async () => {
        routeFetch({ '/api/automation': dead(500) });
        detail();

        // The card's own note, off the hook rather than off a hand-made prop.
        await waitFor(() => expect(screen.getByTestId('skill-grant-gap').textContent).toContain('automations'));

        // …and the step editor's menu, which used to say "Nothing to reference
        // yet." over the very same failed read.
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.getByTestId('skill-ref-unread').textContent).toMatch(/Automations/);
        expect(screen.queryByTestId('skill-ref-none')).toBeNull();
    });

    it('asks again when the note offers to, and drops the note once the read works', async () => {
        let fail = true;
        routeFetch({ '/api/automation': () => (fail ? dead(500) : ok({ automations: [] })) });
        detail();

        await waitFor(() => expect(screen.getByTestId('skill-grant-gap')).toBeTruthy());
        fail = false;
        fireEvent.click(screen.getByTestId('skill-grant-retry'));
        await waitFor(() => expect(screen.queryByTestId('skill-grant-gap')).toBeNull());
    });

    it('does not tell the capsule that the organisation has no groups when it could not read them', async () => {
        routeFetch({ '/auth/groups': dead(500) });
        detail();

        // Wait for the four reads to land — the groups gap is not the card's
        // sentence, so the card stays silent here on purpose.
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        await waitFor(() => expect(screen.getByTestId('skill-ref-none')).toBeTruthy());
        expect(screen.queryByTestId('skill-grant-gap'), 'a groups gap is not the may-use card\'s sentence').toBeNull();

        // Open the audience capsule; the group section is where the claim was.
        fireEvent.click(screen.getByTestId('visibility-capsule'));
        const note = await screen.findByTestId('visibility-groups-unreadable');
        expect(note.getAttribute('role')).toBe('status');
        expect(screen.queryByText(/No groups in this organisation yet/)).toBeNull();
    });

    it('says nothing at all about the lists while they are still on the wire', () => {
        routeFetch();
        detail();
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.getByTestId('skill-ref-loading')).toBeTruthy();
        expect(screen.queryByTestId('skill-ref-none')).toBeNull();
        expect(screen.queryByTestId('skill-grant-gap')).toBeNull();
    });
});
