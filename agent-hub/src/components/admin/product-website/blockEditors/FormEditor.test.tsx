import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormEditor } from './FormEditor';
import { withQueryClient } from '@/test/queryWrapper';

type Call = { url: string; method: string; body: unknown };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('FormEditor', () => {
    let calls: Call[];

    beforeEach(() => {
        calls = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            const method = init?.method || 'GET';
            calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
            if (method === 'PUT') return json({ id: 'a1', enabled: true });
            return json({ automations: [{ id: 'a1', title: 'Demo requests', enabled: false, blocks: [] }] });
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lists the candidate automations and switches the chosen one on for website forms', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(withQueryClient(<FormEditor data={{ automationId: 'a1', fields: [] }} onChange={onChange} />));
        const toggleLabel = await screen.findByText('Allow website forms to start this automation');
        expect(screen.getByText(/Until this is switched on/)).toBeInTheDocument();
        await user.click(toggleLabel.closest('label')!.querySelector('span:last-child') as HTMLElement);
        await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
        const put = calls.find(c => c.method === 'PUT');
        expect(put?.url).toContain('/api/cms/admin/form-automations/a1');
        expect(put?.body).toEqual({ enabled: true });
    });

    it('adds a field with a fresh id', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(withQueryClient(<FormEditor data={{ fields: [{ id: 'field_1', type: 'text' }] }} onChange={onChange} />));
        await user.click(await screen.findByRole('button', { name: /Add field/ }));
        const next = onChange.mock.calls.at(-1)?.[0] as { fields: { id: string }[] };
        expect(next.fields.map(f => f.id)).toEqual(['field_1', 'field_2']);
    });
});
