// Organisation in the Cowork sheet, for administrators: the budget meter has three states (fine, from 80% close, from
// 100% over) with their sentence, switches save at once, the receipts audit says what it found, and someone who is no
// administrator sees only that. The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkOrgPanel, { budgetState } from './CoworkOrgPanel';
import { panelProps } from './panelProps.testkit';
import type { ReceiptsAudit } from '@/api/coworkOrgPanel';

afterEach(() => { vi.unstubAllGlobals(); });

const POLICY = { ceiling: 'asks_before_sending', readOnly: false, unattendedApps: null, monthlyBudget: 500, habitsAllowed: true, autoFix: true };
const AUDIT: ReceiptsAudit = { checkedAt: '2026-11-24T10:00:00Z', items: 12, receipts: 1204, unsigned: 0, missing: 0, problems: [], truncated: false, ok: true };

function serve({ spent = 100, policy = POLICY, audit = AUDIT, admin = true } = {}) {
    return stubRecordingFetch(({ method, url }) => {
        if (url.endsWith('/api/cowork/policy/mine/org')) return admin ? jsonResponse({ orgId: 'org1', name: 'Northwind', spent }) : jsonResponse({ error: 'Only organization admins can see this.' }, 403);
        if (url.endsWith('/api/cowork/policy/mine/receipts-audit')) return jsonResponse(audit);
        if (url.endsWith('/api/cowork/policy/org1')) return jsonResponse(method === 'PUT' ? { ...policy, readOnly: true } : policy);
        return jsonResponse({});
    });
}
const put = (calls: RecordedCall[]) => calls.find((c) => c.method === 'PUT' && c.url.endsWith('/api/cowork/policy/org1'));

describe('budgetState', () => {
    it.each([[0, 'fine'], [399, 'fine'], [400, 'close'], [499, 'close'], [500, 'over'], [900, 'over']])('%i of 500 euros is %s', (spent, level) => {
        expect(budgetState(spent, 500).level).toBe(level);
    });
});

describe('CoworkOrgPanel', () => {
    it.each([
        [100, 'fine', '€100 of €500 used this month (20%).', 'Nobody sees a notice until 80% is used.'],
        [450, 'close', '€450 of €500 used this month (90%).', 'Everyone sees a notice on their home page from 80%.'],
        [520, 'over', '€520 of €500 used this month (104%).', 'The budget is used up. New runs are refused'],
    ])('the budget meter at %i euros is %s, with its sentence', async (spent, level, used, sentence) => {
        serve({ spent });
        renderWithClient(<CoworkOrgPanel {...panelProps({ kind: 'org' })} />);
        const meter = await screen.findByTestId('cowork-org-budget');
        expect(meter).toHaveAttribute('data-level', level);
        expect(within(meter).getByRole('progressbar', { name: 'Budget used this month' })).toHaveAttribute('value', String(Math.min(100, Math.round((spent / 500) * 100))));
        expect(meter).toHaveTextContent(used);
        expect(meter).toHaveTextContent(sentence);
    });

    it('saves a new budget on its own button, and an empty box means no limit', async () => {
        const calls = serve();
        renderWithClient(<CoworkOrgPanel {...panelProps({ kind: 'org' })} />);
        const user = userEvent.setup();
        const box = await screen.findByLabelText('Budget for all tasks together, in euros a month');
        expect(box).toHaveValue('500');
        await user.clear(box);
        await user.type(box, '750');
        await user.click(screen.getByRole('button', { name: 'Save budget' }));
        await waitFor(() => expect(put(calls)?.body).toEqual({ monthlyBudget: 750 }));
        await user.clear(box);
        await user.type(box, '0');
        expect(screen.getByRole('alert')).toHaveTextContent('Fill in an amount above 0');
        expect(screen.getByRole('button', { name: 'Save budget' })).toBeDisabled();
    });

    it('a switch saves at once', async () => {
        const calls = serve();
        renderWithClient(<CoworkOrgPanel {...panelProps({ kind: 'org' })} />);
        const readOnly = await screen.findByRole('switch', { name: 'Read-only mode' });
        await waitFor(() => expect(readOnly).toBeEnabled());
        await userEvent.setup().click(readOnly);
        await waitFor(() => expect(put(calls)?.body).toEqual({ readOnly: true }));
        const habits = screen.getByRole('switch', { name: 'Allow “Notices what you repeat”' });
        expect(habits).toBeChecked();
    });

    it('checks every receipt on "Check now" and offers the file', async () => {
        serve();
        renderWithClient(<CoworkOrgPanel {...panelProps({ kind: 'org' })} />);
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Check now' }));
        expect(await screen.findByText('All 1,204 receipts of 12 tasks check out, checked just now.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Export the audit file' })).toHaveAttribute('href', expect.stringContaining('/api/cowork/policy/mine/receipts-audit?download=true'));
    });

    it('says plainly when a receipt does not check out', async () => {
        serve({ audit: { ...AUDIT, ok: false, problems: [{ itemId: 'x', seq: 4, kind: 'content' }], missing: 2 } });
        renderWithClient(<CoworkOrgPanel {...panelProps({ kind: 'org' })} />);
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Check now' }));
        expect(await screen.findByText('1 of 12 tasks have a receipt that does not check out, and 2 runs have no receipt.')).toBeInTheDocument();
    });

    it('shows someone who is no administrator nothing but that', async () => {
        serve({ admin: false });
        renderWithClient(<CoworkOrgPanel {...panelProps({ kind: 'org' })} />);
        expect(await screen.findByText('Only administrators of your organisation can see and change these rules.')).toBeInTheDocument();
        expect(screen.queryByRole('switch')).toBeNull();
    });
});
