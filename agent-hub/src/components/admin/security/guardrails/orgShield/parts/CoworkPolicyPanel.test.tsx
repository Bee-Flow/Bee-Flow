// The organisation's Cowork policy for its administrators: each change is saved on its own, at once, and the trail
// can be downloaded. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkPolicyPanel from './CoworkPolicyPanel';

const t = (_k: string, en: string) => en;
let calls: RecordedCall[];
const serve = () => {
    let policy: Record<string, unknown> = { ceiling: 'on_its_own', readOnly: false, unattendedApps: null };
    calls = stubRecordingFetch(({ method, body }) => {
        if (method === 'PUT') policy = { ...policy, ...(body as object) };
        return jsonResponse(policy);
    });
};
const puts = () => calls.filter((c) => c.method === 'PUT').map((c) => c.body);

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkPolicyPanel', () => {
    it('saves the read-only switch, the ceiling and the app list, each on its own', async () => {
        serve();
        renderWithClient(<CoworkPolicyPanel orgId="org-1" t={t} />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('switch', { name: /Make every cowork read-only/ }));
        await user.selectOptions(screen.getByLabelText('How independent a cowork may be'), 'asks_before_sending');
        await user.type(screen.getByLabelText('Apps a plan may use while nobody watches'), 'outlook, datatables');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(puts()).toHaveLength(3));
        expect(puts()).toEqual([{ readOnly: true }, { ceiling: 'asks_before_sending' }, { unattendedApps: ['outlook', 'datatables'] }]);
        expect(calls.every((c) => c.url.includes('/api/cowork/policy/org-1'))).toBe(true);
    });

    it('offers the trail as a download', async () => {
        serve();
        renderWithClient(<CoworkPolicyPanel orgId="org-1" t={t} />);
        expect(await screen.findByRole('link', { name: 'Download the trail (CSV)' })).toHaveAttribute('href', expect.stringMatching(/\/api\/cowork\/policy\/org-1\/audit$/));
    });
});
