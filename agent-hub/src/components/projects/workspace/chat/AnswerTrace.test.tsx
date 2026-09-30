import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { client } = vi.hoisted(() => ({ client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>> }));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));

import AnswerTrace from './AnswerTrace';

const TRACE = {
    model: 'claude-sonnet-5', tier: 'fast', categories: ['Email Address'],
    original: 'my mail is ann@example.test', sent: 'my mail is [email_1]', tokenMap: { '[email_1]': 'ann@example.test' }, returned: 'Noted, [email_1].',
};

beforeEach(() => {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockResolvedValue({ trace: TRACE });
});

const meta = (extra = {}) => ({ tier: 'fast', requestedTier: 'auto', redacted: 1, categories: ['Email Address'], trace: true, ...extra });
const renderTrace = (m = meta(), scope: { projectId: string | null; chatId: string | null } = { projectId: 'p1', chatId: 'c1' }) =>
    render(withQueryClient(<AnswerTrace meta={m} projectId={scope.projectId} chatId={scope.chatId} messageId="m1" />));

describe('AnswerTrace', () => {
    it('says the tier and how many values were replaced, without reading the trace', () => {
        renderTrace();
        expect(screen.getByText('Auto → Fast')).toBeInTheDocument();
        expect(screen.getByText('1 value replaced by Privacy protection')).toBeInTheDocument();
        expect(client.get).not.toHaveBeenCalled();
    });

    it('reads the trace when opened, and shows it as written, as sent, the placeholders, and what came back', async () => {
        const user = userEvent.setup();
        renderTrace();
        await user.click(screen.getByRole('button', { name: /How I got this answer/ }));
        const body = await screen.findByTestId('team-chat-answer-trace-body');
        expect(client.get).toHaveBeenCalledWith('/api/projects/p1/chats/c1/messages/m1/trace', expect.anything());
        expect(within(body).getByText('my mail is ann@example.test')).toBeInTheDocument();
        expect(within(body).getByText('my mail is [email_1]')).toBeInTheDocument();
        expect(within(body).getByText('[email_1] → ann@example.test')).toBeInTheDocument();
        expect(within(body).getByText('Noted, [email_1].')).toBeInTheDocument();
        expect(within(body).getByText('Detected: Email Address')).toBeInTheDocument();
    });

    it('is a plain line, with nothing to open, when no value was replaced', () => {
        renderTrace(meta({ redacted: 0, trace: false, requestedTier: 'fast' }));
        expect(screen.queryByRole('button', { name: /How I got this answer/ })).not.toBeInTheDocument();
        expect(screen.getByTestId('team-chat-answer-meta')).toHaveTextContent('Fast');
    });

    it('says so when the trace is gone', async () => {
        const user = userEvent.setup();
        client.get.mockRejectedValue(new Error('404'));
        renderTrace();
        await user.click(screen.getByRole('button', { name: /How I got this answer/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent('no longer available');
        await waitFor(() => expect(client.get).toHaveBeenCalledTimes(1));
    });
});
