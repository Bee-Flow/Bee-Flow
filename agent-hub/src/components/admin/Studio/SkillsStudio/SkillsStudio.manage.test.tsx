import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import SkillsStudio from './index';

/**
 * Studio → Skills, the 2026-11 additions: the list grouped by category, a
 * delete people can find (the ⋯ menu on a row and in the header, both through
 * SkillDeleteDialog), and the one-click clean-up of empty drafts.
 */

/** What the server answers in a test; DELETE always succeeds and is recorded. */
const reply: { list: unknown[]; summary: unknown; summaryStatus: number } = { list: [], summary: {}, summaryStatus: 200 };
let calls: RecordedCall[] = [];
const deleted = () => calls.filter((c) => c.method === 'DELETE').map((c) => [c.url.split('/').pop(), c.body]);

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: queryWrapper() });

const base = { canEdit: true, userId: 'u1', isShared: false, sharedGroups: [], steps: [{ id: 'st', text: 'Do it', refs: [] }], rulesV2: [], examplesV2: [], description: 'd' };
const SALES = { ...base, id: 's1', name: 'Quote helper', category: 'Sales' };
const LOOSE = { ...base, id: 's2', name: 'Loose skill', category: null };
const EMPTY = { ...base, id: 's3', name: 'Untitled skill', description: '', steps: [] };

const renderStudio = () => render(<SkillsStudio user={{ id: 'u1', orgRole: 'org_admin' }} onNavigate={() => {}} />);
const rowOf = (id: string) => screen.getAllByTestId('skill-row').find((r) => r.getAttribute('data-skill-id') === id) as HTMLElement;

beforeEach(() => {
    Object.assign(reply, { list: [SALES, LOOSE], summary: {}, summaryStatus: 200 });
    calls = stubRecordingFetch(({ method, url }) => {
        if (method === 'DELETE') return jsonResponse({ success: true });
        if (url.includes('/usage-summary')) return jsonResponse({ summary: reply.summary }, reply.summaryStatus);
        if (url.includes('/usage')) return jsonResponse({ usage: [], unchecked: [] });
        if (url.endsWith('/api/skills')) return jsonResponse(reply.list);
        return jsonResponse([]);
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('grouped by category', () => {
    it('shows a heading per category and a "No category" group last', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        await userEvent.click(screen.getByTestId('skills-group-toggle'));
        const headings = screen.getAllByTestId('skills-group-heading').map((h) => h.textContent);
        expect(headings).toEqual(['Sales', 'No category']);
    });
});

describe('deleting from the list and the header', () => {
    it('the row ⋯ menu opens the delete dialog, which deletes after the name is typed', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        await userEvent.click(within(rowOf('s1').parentElement as HTMLElement).getByTestId('skill-row-actions'));
        await userEvent.click(screen.getByTestId('skill-row-actions-delete'));
        await userEvent.type(await screen.findByPlaceholderText('Quote helper'), 'Quote helper');
        await userEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
        await waitFor(() => expect(deleted()).toEqual([['s1', { confirmBreaking: false }]]));
        await waitFor(() => expect(screen.queryByText('Quote helper')).toBeNull());
    });

    it('the header of an open skill has the same ⋯ menu', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        await userEvent.click(rowOf('s2'));
        await userEvent.click(await screen.findByTestId('skill-header-actions'));
        expect(screen.getByTestId('skill-header-actions-delete')).toBeTruthy();
    });

    it('a skill of someone else has no delete action', async () => {
        reply.list = [{ ...SALES, userId: 'other' }];
        renderStudio();
        await screen.findAllByTestId('skill-row');
        expect(screen.queryByTestId('skill-row-actions')).toBeNull();
    });
});

describe('cleaning up empty drafts', () => {
    it('removes the empty drafts nothing uses in one click, without confirmBreaking', async () => {
        reply.list = [SALES, EMPTY];
        reply.summary = { s1: { agents: 0, automations: 0 }, s3: { agents: 0, automations: 0 } };
        renderStudio();
        await userEvent.click(await screen.findByTestId('skills-clean-drafts'));
        await waitFor(() => expect(deleted()).toEqual([['s3', { confirmBreaking: false }]]));
    });

    it('offers nothing while the usage summary has not answered', async () => {
        reply.list = [EMPTY];
        reply.summaryStatus = 500;
        renderStudio();
        await screen.findAllByTestId('skill-row');
        expect(screen.queryByTestId('skills-clean-drafts')).toBeNull();
    });
});
