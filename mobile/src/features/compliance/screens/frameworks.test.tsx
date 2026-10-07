/**
 * More frameworks (ComplianceSectionScreen section='frameworks') against
 * canned server answers: the legal banner, the groups and the own-framework
 * door, a locked row with View plan, the Not relevant toggle, the toasts,
 * and the calendar below. Includes the 'enables a framework' test the
 * foundation moved out of screens.test.tsx.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api, ApiError } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { ComplianceSectionScreen } from './ComplianceSectionScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('../hooks/useComplianceAccess', () => ({ useComplianceAccess: () => ({ access: { state: 'open' }, open: true, hint: '' }) }));

const C = '/api/compliance';
/** A day 30 days ahead, local: the status chip turns warning within 90 days. */
const soon = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
let catalogue: unknown = { verified_on: '2026-09-29', stale: false };
const frameworks = () => ({
    frameworks: [
        { id: 'gdpr', name_key: 'compliance.fw_gdpr_name', enabled: true, core: true },
        { id: 'iso27001', name_key: 'compliance.fw_iso27001_name', enabled: true, checks_count: 12, in_force_since: '2022-10-25' },
        { id: 'nis2', name_key: 'compliance.fw_nis2_name', enabled: false, checks_count: 8, registers: ['incidents'], in_force_from: soon },
        { id: 'dora', name_key: 'compliance.fw_dora_name', enabled: false, relevance: 'not_relevant', relevance_gate: true },
        { id: 'cra', name_key: 'compliance.fw_cra_name', enabled: false, locked: 'ceiling' },
    ],
    custom: [],
    catalogue,
});
const ANSWERS: Record<string, () => unknown> = {
    [`${C}/frameworks`]: frameworks,
    [`${C}/counts`]: () => ({ frameworks_summary: { active: 3, candidates: 4, recently_in_force: 1 } }),
    [`${C}/calendar`]: () => ({ milestones: [{ id: 'nis2_x', date: '2027-01-01', framework_id: 'nis2', kind: 'phase', label: 'NIS2 transposition' }] }),
};

beforeEach(() => {
    jest.clearAllMocks();
    catalogue = { verified_on: '2026-09-29', stale: false };
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path]?.() ?? null));
    (api.post as jest.Mock).mockResolvedValue({});
});

function render(ui: ReactElement) {
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>,
    );
}

describe('More frameworks', () => {
    it('enables a framework', async () => {
        await render(<ComplianceSectionScreen section="frameworks" />);
        await fireEvent(await screen.findByTestId('framework-toggle-nis2'), 'valueChange', true);
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/frameworks/nis2/enable`, {}));
        expect(await screen.findByText('Framework enabled — its checks are running')).toBeTruthy();
    });

    it('groups the optional frameworks, drops core ones and ends with the own-framework door', async () => {
        await render(<ComplianceSectionScreen section="frameworks" />);
        expect(await screen.findByText('ENABLED')).toBeTruthy();
        expect(screen.getByText('AVAILABLE')).toBeTruthy();
        expect(screen.queryByTestId('framework-row-gdpr')).toBeNull();
        expect(screen.getByTestId('framework-row-iso27001')).toBeTruthy();
        expect(within(screen.getByTestId('framework-row-iso27001')).getByText('Enabled · 12 checks')).toBeTruthy();
        expect(within(screen.getByTestId('framework-row-nis2')).getByText(/^from .* · in 30 days$/)).toBeTruthy();
        await fireEvent.press(screen.getByTestId('framework-own'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/compliance/custom');
        await fireEvent.press(screen.getByTestId('frameworks-add'));
        expect(mockRouter.push).toHaveBeenCalledTimes(2);
        expect(await screen.findByText('NIS2 transposition')).toBeTruthy();
    });

    it('shows a locked framework with its lock line and View plan', async () => {
        await render(<ComplianceSectionScreen section="frameworks" />);
        expect(await screen.findByTestId('fw-locked-cra')).toBeTruthy();
        expect(screen.getByText('Available on a higher plan')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('fw-view-plan-cra'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/billing');
    });

    it('toggles Not relevant on a gated candidate', async () => {
        await render(<ComplianceSectionScreen section="frameworks" />);
        await fireEvent.press(await screen.findByTestId('fw-relevance-dora'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/frameworks/dora/relevance`, { relevance: 'relevant' }));
        expect(screen.queryByTestId('fw-relevance-nis2')).toBeNull();
    });

    it('confirms a disable, then toasts it', async () => {
        await render(<ComplianceSectionScreen section="frameworks" />);
        await fireEvent(await screen.findByTestId('framework-toggle-iso27001'), 'valueChange', false);
        await fireEvent.press(await screen.findByText('Disable'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/frameworks/iso27001/disable`, {}));
        expect(await screen.findByText('Framework disabled')).toBeTruthy();
    });

    it('says the plan sentence when the server answers 403', async () => {
        (api.post as jest.Mock).mockRejectedValue(new ApiError('Forbidden', { status: 403 }));
        await render(<ComplianceSectionScreen section="frameworks" />);
        await fireEvent(await screen.findByTestId('framework-toggle-nis2'), 'valueChange', true);
        expect(await screen.findByText('This framework is not included in your plan')).toBeTruthy();
    });

    it('shows the legal status, in warning tone once due for review, and the summary', async () => {
        catalogue = { verified_on: '2026-09-29', stale: true };
        await render(<ComplianceSectionScreen section="frameworks" />);
        expect(await screen.findByTestId('legal-status-warning')).toBeTruthy();
        expect(screen.getByText('Legal status checked 29 Sep 2026 · due for review')).toBeTruthy();
        expect(await screen.findByText('3 active · 4 candidates · 1 just in force')).toBeTruthy();
    });
});
