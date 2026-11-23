// "How it starts": the start is read when the panel is shown (its Settings tab, see CoworkSettings.test.tsx), a choice is saved, and a webhook's address and token are
// shown once. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkStartPanel from './CoworkStartPanel';
import type { CoworkItem } from '@/api/cowork.types';

const ITEM = { id: 'w1', title: 'Order log', prompt: 'Log it.' } as CoworkItem;
const STATE = { kind: 'schedule', after: null, datatableId: null, inFolder: null, hasAddress: false };

let calls: RecordedCall[];
const serve = () => {
    calls = stubRecordingFetch(({ method, url, body }) => {
        if (url.endsWith('/api/cowork')) return jsonResponse({ items: [ITEM, { id: 'w2', title: 'Supplier radar' }], maxItems: 10 });
        if (method === 'PUT') {
            const kind = (body as { kind: string }).kind;
            return jsonResponse({ ...STATE, kind, hasAddress: kind === 'webhook', address: kind === 'webhook' ? { url: 'https://bee.example/api/cowork/hooks', token: 'tok-123' } : null });
        }
        return jsonResponse(STATE);
    });
};
const puts = () => calls.filter((c) => c.method === 'PUT');

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkStartPanel', () => {
    it('saves "after another cowork" with the cowork chosen', async () => {
        serve();
        renderWithClient(<CoworkStartPanel item={ITEM} />);
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Starts'), 'after_cowork');
        await user.selectOptions(await screen.findByLabelText('After which cowork'), 'w2');
        await user.click(screen.getByRole('button', { name: 'Save how it starts' }));
        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(puts()[0].body).toEqual({ kind: 'after_cowork', scheduleId: 'w2' });
    });

    it('a webhook shows its address and token once', async () => {
        serve();
        renderWithClient(<CoworkStartPanel item={ITEM} />);
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Starts'), 'webhook');
        await user.click(screen.getByRole('button', { name: 'Save how it starts' }));
        const address = await screen.findByTestId('cowork-start-address');
        expect(address).toHaveTextContent('POST https://bee.example/api/cowork/hooks');
        expect(address).toHaveTextContent('Authorization: Bearer tok-123');
    });

    it('a folder must be a path', async () => {
        serve();
        renderWithClient(<CoworkStartPanel item={ITEM} />);
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Starts'), 'file');
        await user.type(screen.getByLabelText('Folder in Nextcloud, such as /Invoices'), 'Invoices');
        expect(screen.getByRole('button', { name: 'Save how it starts' })).toBeDisabled();
    });

    it('a webhook item saves nothing until something changed; a new token is made only after asking once more', async () => {
        calls = stubRecordingFetch(({ method }) => jsonResponse(method === 'PUT'
            ? { ...STATE, kind: 'webhook', hasAddress: true, address: { url: 'https://bee.example/api/cowork/hooks', token: 'tok-new' } }
            : { ...STATE, kind: 'webhook', hasAddress: true }));
        renderWithClient(<CoworkStartPanel item={ITEM} />);
        const user = userEvent.setup();
        expect(await screen.findByRole('button', { name: 'Save how it starts' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Make a new token' }));
        expect(screen.getByRole('alertdialog')).toHaveTextContent('The current token stops working at once');
        await user.click(screen.getByRole('button', { name: 'Keep the current one' }));
        expect(puts()).toHaveLength(0);
        await user.click(screen.getByRole('button', { name: 'Make a new token' }));
        await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Make a new token' }));
        expect(await screen.findByTestId('cowork-start-address')).toHaveTextContent('tok-new');
        expect(puts().map((c) => c.body)).toEqual([{ kind: 'webhook' }]);
    });
});
