import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import UsedByTab, {
    adaptDatatableUsageRow, adaptUsageRows, countByKind, isForeignRow, kindLabelFor,
    usageHref, usageKind,
} from './UsedByTab';

/**
 * The three behavioural rules DatatablesStudio.hygiene.test.jsx pins for the
 * datatables tab, lifted to the shared table so they hold for EVERY kind:
 *   1. your own item navigates in-app (a button → onNavigate(path));
 *   2. a colleague's item is plain text that says whose it is — no button,
 *      no <a href> that full-reloads the SPA into nothing;
 *   3. the list is fetched once — that one lives in useUsage.test.js; here
 *      the tab is a pure renderer of `rows` and never fetches.
 * Plus: loading/empty states, the summary pills, `lastLabel` over time,
 * the per-kind role header, and the legacy-shape adapter.
 */

const ROW = (over = {}) => ({
    kind: 'automation', id: 'a1', title: 'Nightly sync', role: 'read', ownerId: 'u1', ...over,
});

describe('UsedByTab — the navigation rule', () => {
    it('navigates in-app for an item this account owns', () => {
        const onNavigate = vi.fn();
        render(<UsedByTab rows={[ROW()]} currentUserId="u1" onNavigate={onNavigate} />);
        fireEvent.click(screen.getByRole('button', { name: 'Nightly sync' }));
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/a1');
    });

    it("renders a colleague's item as plain text — usage is org-wide, the item is not", () => {
        const onNavigate = vi.fn();
        render(<UsedByTab rows={[ROW({ ownerId: 'u9' })]} currentUserId="u1" onNavigate={onNavigate} />);
        expect(screen.getByText('Nightly sync')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Nightly sync' })).toBeNull();
        expect(screen.queryByRole('link', { name: /Nightly sync/ })).toBeNull();
        expect(screen.getByText(/someone else/i)).toBeInTheDocument();
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('an item with no owner (org-scoped) is navigable', () => {
        const onNavigate = vi.fn();
        render(<UsedByTab rows={[{ kind: 'agent', id: 'ag1', title: 'Quote assistant', role: 'read', ownerId: null }]} currentUserId="u1" onNavigate={onNavigate} />);
        fireEvent.click(screen.getByRole('button', { name: 'Quote assistant' }));
        expect(onNavigate).toHaveBeenCalledWith('studio/agents/ag1');
        expect(screen.queryByText(/someone else/i)).toBeNull();
    });

    it('an explicit href wins over the kind default, and a kind without a page is plain text', () => {
        const onNavigate = vi.fn();
        render(<UsedByTab rows={[
            { kind: 'app', id: 'p1', title: 'Portal', role: 'read', href: 'studio/apps/p1?screen=s2' },
            { kind: 'chat', id: 'c1', title: 'Chat', role: 'chat' },
        ]} currentUserId="u1" onNavigate={onNavigate} />);
        fireEvent.click(screen.getByRole('button', { name: 'Portal' }));
        expect(onNavigate).toHaveBeenCalledWith('studio/apps/p1?screen=s2');
        expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
    });

    it('without onNavigate nothing is a button, even your own item', () => {
        render(<UsedByTab rows={[ROW()]} currentUserId="u1" />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.getByText('Nightly sync')).toBeInTheDocument();
    });

    it('a null title on a colleague’s item still says whose it is', () => {
        render(<UsedByTab rows={[ROW({ title: null, ownerId: 'u9' })]} currentUserId="u1" />);
        expect(screen.getByText(/someone else/i)).toBeInTheDocument();
        expect(screen.queryByRole('button')).toBeNull();
    });
});

describe('UsedByTab — loading and empty', () => {
    it('rows === null is loading, not empty', () => {
        render(<UsedByTab rows={null} />);
        expect(screen.getByTestId('usage-loading')).toBeInTheDocument();
        expect(screen.queryByText(/nothing uses this/i)).toBeNull();
        expect(screen.queryByRole('table')).toBeNull();
    });

    it('an empty list shows the dashed "not used by anything" pill and the empty text', () => {
        render(<UsedByTab rows={[]} />);
        expect(screen.getByText('not used by anything')).toBeInTheDocument();
        expect(screen.getByText('Nothing uses this yet.')).toBeInTheDocument();
        expect(screen.queryByRole('table')).toBeNull();
    });

    it('emptyText replaces the default sentence', () => {
        render(<UsedByTab rows={[]} emptyText="No automation reads this table yet." />);
        expect(screen.getByText('No automation reads this table yet.')).toBeInTheDocument();
    });

    it('an error is shown above the list, never instead of it', () => {
        render(<UsedByTab rows={[ROW()]} error="boom" />);
        expect(screen.getAllByRole('status')[0]).toHaveTextContent(/could not load/i);
        expect(screen.getByText('Nightly sync')).toBeInTheDocument();
    });
});

/**
 * An empty list is a CLAIM: everything was looked at and nothing was found.
 * Several usage endpoints cannot make it — the webpage one never can, because
 * two of its kinds have no row that could answer them — and they say so in
 * `unchecked`. Without this the honest server answer `{usage: [], unchecked:
 * ['agent']}` rendered as "Nothing uses this yet." plus a dashed "not used by
 * anything" pill: the exact sentence somebody presses delete through.
 */
describe('UsedByTab — kinds that could not be checked', () => {
    it('an empty list with unchecked kinds never says "nothing uses this"', () => {
        render(<UsedByTab rows={[]} unchecked={['chat', 'agent']} />);
        expect(screen.queryByText('Nothing uses this yet.')).toBeNull();
        expect(screen.queryByText('not used by anything')).toBeNull();
        expect(screen.getByTestId('usage-empty')).toHaveTextContent(/not everything could be checked/i);
        expect(screen.getByTestId('usage-summary')).toHaveTextContent('not fully checked');
    });

    it('names the kinds it could not check', () => {
        render(<UsedByTab rows={[]} unchecked={['chat', 'agent']} />);
        expect(screen.getByTestId('usage-unchecked')).toHaveTextContent('chats, agents');
    });

    it('says it over a NON-EMPTY list too', () => {
        render(<UsedByTab rows={[ROW()]} unchecked={['agent']} />);
        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(screen.getByTestId('usage-unchecked')).toHaveTextContent(/incomplete/i);
    });

    it('omitting the prop keeps the old wording exactly', () => {
        render(<UsedByTab rows={[]} />);
        expect(screen.getByText('Nothing uses this yet.')).toBeInTheDocument();
        expect(screen.getByText('not used by anything')).toBeInTheDocument();
        expect(screen.queryByTestId('usage-unchecked')).toBeNull();
    });

    it('an explicit emptyText still wins — that caller has already thought about it', () => {
        render(<UsedByTab rows={[]} unchecked={['agent']} emptyText="No automation reads this table yet." />);
        expect(screen.getByText('No automation reads this table yet.')).toBeInTheDocument();
    });
});

describe('UsedByTab — the table', () => {
    it('summarises per kind: "2 agents", "1 automation"', () => {
        render(<UsedByTab rows={[
            { kind: 'agent', id: 'a1', title: 'One', role: 'read' },
            { kind: 'agent', id: 'a2', title: 'Two', role: 'read' },
            ROW(),
        ]} />);
        const summary = screen.getByTestId('usage-summary');
        expect(within(summary).getByText('2 agents')).toBeInTheDocument();
        expect(within(summary).getByText('1 automation')).toBeInTheDocument();
        expect(screen.queryByText('not used by anything')).toBeNull();
    });

    it('has the three headings, "Does" by default, and a roleHeader override ("As" for an agent)', () => {
        const { rerender } = render(<UsedByTab rows={[ROW()]} />);
        const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
        expect(heads.slice(0, 3)).toEqual(['Where', 'Does', 'Last time']);
        rerender(<UsedByTab rows={[ROW()]} roleHeader="As" />);
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent).slice(0, 3)).toEqual(['Where', 'As', 'Last time']);
    });

    it('lastLabel overrides the time (a solution’s last touch is a version, not a moment)', () => {
        render(<UsedByTab rows={[
            { kind: 'solution', id: 's1', title: 'Quotes', role: 'contains', lastLabel: 'v1.2', lastAt: new Date().toISOString() },
            { kind: 'app', id: 'p1', title: 'Portal', role: 'read', lastAt: new Date().toISOString() },
            { kind: 'skill', id: 'k1', title: 'Summarise', role: 'invokes' },
        ]} />);
        const rows = screen.getAllByTestId('usage-row');
        expect(rows[0]).toHaveTextContent('v1.2');
        expect(rows[1]).toHaveTextContent('just now');
        expect(rows[2]).toHaveTextContent('—');
    });

    it('spells out the role and the site', () => {
        render(<UsedByTab rows={[
            ROW({ role: 'write', siteLabel: 'step 6' }),
            { kind: 'agent', id: 'ag', title: 'Assistant', role: 'ai_step', siteLabel: 'as knowledge' },
        ]} />);
        const rows = screen.getAllByTestId('usage-row');
        expect(rows[0]).toHaveTextContent('writes');
        expect(rows[0]).toHaveTextContent('· step 6');
        expect(rows[1]).toHaveTextContent('AI step');
        expect(rows[1]).toHaveTextContent('· as knowledge');
    });

    it('showSummary={false} drops the pills (the delete dialog embeds the bare list)', () => {
        render(<UsedByTab rows={[ROW()]} showSummary={false} />);
        expect(screen.queryByTestId('usage-summary')).toBeNull();
        expect(screen.getByRole('table')).toBeInTheDocument();
    });
});

describe('UsedByTab — adapt (legacy datatables shape)', () => {
    const LEGACY = { automationId: 'a1', automationTitle: 'Nightly sync', automationOwner: 'u1', stepId: 's6', mode: 'write', columns: ['email', 'name'] };

    it('maps {automationId, automationTitle, automationOwner, mode, columns} onto the contract', () => {
        expect(adaptDatatableUsageRow(LEGACY)).toEqual({
            kind: 'automation', id: 'a1', title: 'Nightly sync', role: 'write',
            siteLabel: 'email, name', lastAt: null, ownerId: 'u1',
        });
        expect(adaptDatatableUsageRow({ automationId: 'a2', mode: 'read', columns: [] })).toMatchObject({ title: null, role: 'read', ownerId: null });
        const contract = ROW();
        expect(adaptDatatableUsageRow(contract)).toBe(contract); // a contract row passes through untouched
    });

    it('renders legacy rows through adapt with the same navigation rule', () => {
        const onNavigate = vi.fn();
        const { rerender } = render(<UsedByTab rows={[LEGACY]} adapt={adaptDatatableUsageRow} currentUserId="u1" onNavigate={onNavigate} />);
        fireEvent.click(screen.getByRole('button', { name: 'Nightly sync' }));
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/a1');
        rerender(<UsedByTab rows={[{ ...LEGACY, automationOwner: 'u9' }]} adapt={adaptDatatableUsageRow} currentUserId="u1" onNavigate={onNavigate} />);
        expect(screen.queryByRole('button', { name: 'Nightly sync' })).toBeNull();
        expect(screen.getByText(/someone else/i)).toBeInTheDocument();
    });

    it('adaptUsageRows drops what the adapter refuses', () => {
        expect(adaptUsageRows([LEGACY, null, 'junk'], adaptDatatableUsageRow)).toHaveLength(1);
        expect(adaptUsageRows(null)).toEqual([]);
    });
});

describe('UsedByTab — helpers', () => {
    it('usageKind folds aliases and knows the non-Studio kinds', () => {
        expect(usageKind({ kind: 'automations' })).toBe('automation');
        expect(usageKind({ kind: 'chat' })).toBe('chat');
        expect(usageKind({ kind: 'Project' })).toBe('project');
        expect(usageKind({})).toBeNull();
    });

    it('usageHref derives the Studio page per kind and null where there is none', () => {
        expect(usageHref({ kind: 'kb', id: 'k1' })).toBe('studio/knowledge/k1');
        expect(usageHref({ kind: 'meeting', id: 'm1' })).toBeNull();
        expect(usageHref({ kind: 'agent' })).toBeNull();
    });

    it('isForeignRow: only a set owner that is not me', () => {
        expect(isForeignRow({ ownerId: 'u9' }, 'u1')).toBe(true);
        expect(isForeignRow({ ownerId: 'u1' }, 'u1')).toBe(false);
        expect(isForeignRow({ ownerId: null }, 'u1')).toBe(false);
        expect(isForeignRow({}, null)).toBe(false);
        expect(isForeignRow({ ownerId: 'u9' }, null)).toBe(true);
    });

    it('kindLabelFor keeps an UNKNOWN kind under its own name, not as "items"', () => {
        // `unchecked` is an open vocabulary — KIND_NOUNS is today's list. A
        // server that starts reporting `widget` must not read as "Could not be
        // checked: items", which names nothing at all.
        const t = (key, fallback) => fallback;
        expect(kindLabelFor(t, 'widget', 2)).toBe('widget');
        expect(kindLabelFor(t, 'form', 2)).toBe('forms');
        expect(kindLabelFor(t, 'notebook', 2)).toBe('notebooks');
        expect(kindLabelFor(t, 'automation')).toBe('automation');
        // A row with no kind at all is the one case that still says "item".
        expect(kindLabelFor(t, undefined)).toBe('item');
        expect(kindLabelFor(t, '', 2)).toBe('items');
    });

    it('countByKind keeps first-seen order', () => {
        expect(countByKind([{ kind: 'agent' }, { kind: 'app' }, { kind: 'agent' }])).toEqual([
            { kind: 'agent', n: 2 }, { kind: 'app', n: 1 },
        ]);
    });
});
