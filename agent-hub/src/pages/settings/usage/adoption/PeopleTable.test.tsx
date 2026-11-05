import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import type { AdoptionPeoplePage } from './adoption.types';
import PeopleTable, { type PeopleTableProps } from './PeopleTable';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const people = (q: string) => (ROUTES as unknown as Record<string, Handler>)['GET /api/usage/adoption/people']({ state: createState(), query: new URLSearchParams(q) }) as AdoptionPeoplePage;

const base: Omit<PeopleTableProps, 'view' | 'revealed' | 'onReveal' | 'onHide'> = {
    loading: false, auditFailed: false, revealedAt: null, scopeLabel: '6 Oct – 5 Nov 2026 · all groups',
    currency: '€', showCalls: true, hasMore: false, onLoadMore: () => {},
};

/** The reveal round trip the tab does, with the fixture standing in for the server. */
function Host({ onRevealRequest }: { onRevealRequest?: () => void }) {
    const [revealed, setRevealed] = useState(false);
    const view = people(`days=30&limit=200${revealed ? '&reveal=true' : ''}`);
    return (
        <PeopleTable {...base} view={view} revealed={revealed} revealedAt={revealed ? Date.parse('2026-11-05T14:02:00Z') : null}
            onReveal={() => { onRevealRequest?.(); setRevealed(true); }} onHide={() => setRevealed(false)} />
    );
}

const memberCells = () => screen.getAllByRole('rowheader').map(h => h.textContent || '');

describe('PeopleTable', () => {
    it('is pseudonymous by default, with the "Names are hidden" banner', () => {
        render(<Host />);
        expect(screen.getByText('Names are hidden')).toBeTruthy();
        expect(memberCells().every(n => /^Member · [A-Z2-9]{4}$/.test(n))).toBe(true);
    });

    it('reveals names with one click, says it is recorded, and hides them again', async () => {
        const user = userEvent.setup();
        const onRevealRequest = vi.fn();
        render(<Host onRevealRequest={onRevealRequest} />);
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        expect(onRevealRequest).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('status').textContent).toContain('usage_adoption_people_revealed');
        expect(screen.getByRole('status').textContent).toContain('all groups');
        expect(memberCells().some(n => n.startsWith('Member · '))).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Hide names' }));
        expect(screen.getByText('Names are hidden')).toBeTruthy();
        expect(memberCells().every(n => n.startsWith('Member · '))).toBe(true);
    });

    it('searches, sorts and filters to members not yet active, and shows more on request', async () => {
        const user = userEvent.setup();
        render(<Host />);
        expect(memberCells()).toHaveLength(25);
        expect(screen.getByRole('button', { name: /Show more \(123 remaining\)/ })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Not yet active · 41' }));
        expect(screen.getByRole('button', { name: 'Not yet active · 41' }).getAttribute('aria-pressed')).toBe('true');
        const statuses = screen.getAllByRole('row').slice(1).map(r => r.textContent || '');
        expect(statuses.every(s => /Signed in only|Dormant > 30 d/.test(s))).toBe(true);
        await user.click(screen.getByRole('button', { name: /Show more/ }));
        expect(memberCells()).toHaveLength(41);
        await user.selectOptions(screen.getByLabelText('Sort'), 'name');
        const names = memberCells();
        expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
        const first = names[0];
        await user.type(screen.getByLabelText('Search people'), first.slice(-4));
        expect(memberCells()).toEqual([first]);
    });

    it('labels every status, and leaves the call column out for cloud customers', () => {
        const view = people('days=30&limit=200');
        render(<PeopleTable {...base} showCalls={false} view={view} revealed={false} onReveal={() => {}} onHide={() => {}} />);
        expect(screen.queryByRole('columnheader', { name: 'AI calls' })).toBeNull();
        expect(screen.getAllByText('AI-active').length).toBeGreaterThan(0);
    });

    it('shows nothing, and says why, when the audit log refused the reveal', async () => {
        const user = userEvent.setup();
        const onHide = vi.fn();
        render(<PeopleTable {...base} auditFailed view={people('days=30&reveal=true')} revealed onReveal={() => {}} onHide={onHide} />);
        expect(screen.getByText('Names not revealed')).toBeTruthy();
        expect(screen.queryAllByRole('rowheader')).toHaveLength(0);
        expect(screen.queryByLabelText('Search people')).toBeNull();
        await user.click(screen.getByRole('button', { name: /Back to pseudonyms/ }));
        expect(onHide).toHaveBeenCalled();
    });

    it('shows no name while names are hidden, even when handed a revealed answer', () => {
        const named = people('days=30&limit=200&reveal=true');
        expect(named.reveal).toBe(true);
        render(<PeopleTable {...base} loading view={named} revealed={false} onReveal={() => {}} onHide={() => {}} />);
        expect(screen.getByText('Names are hidden')).toBeTruthy();
        expect(screen.queryAllByRole('rowheader')).toHaveLength(0);
        for (const p of named.people.slice(0, 5)) expect(screen.queryByText(p.name)).toBeNull();
    });

    it('names the org role, never its id', () => {
        render(<PeopleTable {...base} view={people('days=30&limit=200')} revealed={false} onReveal={() => {}} onHide={() => {}} />);
        const roles = screen.getAllByRole('row').slice(1).map(r => r.querySelectorAll('td')[0]?.textContent || '');
        expect(roles).toContain('Organisation admin');
        expect(roles).toContain('Agent editor');
        expect(roles.some(r => /^(org_admin|agent_editor|member)$/.test(r))).toBe(false);
    });

    it('asks for the next page as soon as the filtered rows are all on screen', async () => {
        const user = userEvent.setup();
        const onLoadMore = vi.fn();
        const view = people('days=30&limit=200');
        render(<PeopleTable {...base} hasMore onLoadMore={onLoadMore} view={view} revealed={false} onReveal={() => {}} onHide={() => {}} />);
        await user.type(screen.getByLabelText('Search people'), memberCells()[0].slice(-4));
        expect(memberCells()).toHaveLength(1);
        await user.click(screen.getByRole('button', { name: /Show more/ }));
        expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('asks for the next page when the rows on screen run out', async () => {
        const user = userEvent.setup();
        const onLoadMore = vi.fn();
        const view = people('days=30&limit=30');
        render(<PeopleTable {...base} hasMore onLoadMore={onLoadMore} view={view} revealed={false} onReveal={() => {}} onHide={() => {}} />);
        const table = screen.getByRole('table');
        expect(within(table).getAllByRole('rowheader')).toHaveLength(25);
        await user.click(screen.getByRole('button', { name: /Show more/ }));
        expect(onLoadMore).toHaveBeenCalledTimes(1);
    });
});
