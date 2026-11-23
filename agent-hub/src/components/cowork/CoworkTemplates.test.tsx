// "Start from a template": nothing is read until it opens; a template shows its brief, its schedule and what its plan
// may do in the plan card's words; adding one asks the server for the new item and opens it. A plan with findings is
// said to be left out. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkTemplates from './CoworkTemplates';

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

const CARD = { id: 'tpl-1', title: 'Supplier radar', brief: 'Watch the suppliers.', repeatInterval: 'weekly', hasPlan: true, createdAt: null, mine: false };
const PERMISSIONS = { v: 1, grants: [{ app: 'outlook', effect: 'reads', tools: ['outlook_search'] }, { app: 'outlook', effect: 'sends', tools: ['outlook_compose'] }], sends: 'others', ai: true, outsideText: false };

function serve(findings: unknown[] = []) {
    calls = stubRecordingFetch(({ method, url }) => {
        if (method === 'POST') return jsonResponse({ item: { id: 'new-1' }, planAttached: findings.length === 0, findings });
        if (url.endsWith('/templates')) return jsonResponse({ templates: [CARD] });
        return jsonResponse({
            template: { ...CARD, savedBy: 'Ann', canDelete: false },
            plan: { view: { trigger: 'schedule', steps: [], makeUp: { fixed: 1, ai: 1, ask: 0, deliver: 0 } }, permissions: PERMISSIONS, findings, attachable: findings.length === 0 },
        });
    });
}

describe('CoworkTemplates', () => {
    it('shows a template with what it may do, and adds it as a new item that it opens', async () => {
        serve();
        const onAdded = vi.fn();
        renderWithClient(<CoworkTemplates onAdded={onAdded} />);
        expect(calls).toHaveLength(0);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Start from a template' }));
        await user.click(await screen.findByRole('button', { name: /Supplier radar/ }));
        const view = await screen.findByTestId('cowork-template-view');
        expect(view).toHaveTextContent('Watch the suppliers.');
        expect(view).toHaveTextContent('Every week');
        expect(view).toHaveTextContent('saved by Ann');
        expect(screen.getByTestId('cowork-plan-may-reads')).toHaveTextContent('Outlook');
        expect(screen.getByTestId('cowork-plan-may-sends')).toHaveTextContent('To other people');
        expect(view).toHaveTextContent('Adding it runs nothing');
        expect(screen.queryByRole('button', { name: 'Delete this template' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Add to my cowork' }));
        await waitFor(() => expect(onAdded).toHaveBeenCalledWith('new-1'));
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.url).toMatch(/\/api\/cowork\/templates\/tpl-1\/use$/);
    });

    it('says a plan with findings is left out', async () => {
        serve([{ code: 'template.changed', stepId: null, message: 'This plan is not the one that was saved, so it is left out.' }]);
        renderWithClient(<CoworkTemplates onAdded={vi.fn()} />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Start from a template' }));
        await user.click(await screen.findByRole('button', { name: /Supplier radar/ }));
        expect(await screen.findByRole('note')).toHaveTextContent('This plan is not the one that was saved');
    });
});
