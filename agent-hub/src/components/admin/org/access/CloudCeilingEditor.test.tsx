// The cloud ceiling under an organisation's heading: assigning a plan is that
// organisation's, editing the plan is server-wide (every organisation on the
// plan), so the edit carries the whole-server mark.
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CloudCeilingEditor from './CloudCeilingEditor';
import { withQueryClient } from '@/test/queryWrapper';

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const address = String(url);
        const body = address.endsWith('/api/subscriptions/plans') ? [{ id: 'p1', name: 'Pro' }]
            : address.endsWith('/api/subscriptions/orgs') ? [{ organization_id: 'org-b', plan_id: 'p1' }]
                : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

describe('CloudCeilingEditor', () => {
    it('marks "Edit plan" as a whole-server change, and not the plan choice of the organisation', async () => {
        render(withQueryClient(<CloudCeilingEditor orgId="org-b" orgName="Org B" onCeilingChanged={undefined} />));
        const edit = await screen.findByRole('button', { name: /Edit plan/ });
        expect(within(edit).getByRole('img', { name: 'Whole server' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Plan' })).toHaveValue('p1');
        expect(screen.getAllByRole('img', { name: 'Whole server' })).toHaveLength(1);
    });
});
