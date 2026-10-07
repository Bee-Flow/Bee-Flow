/**
 * The Compliance Center's screens against canned server answers: who is
 * turned away, and what an unknown section shows. Each area's own screens are
 * tested in its own package.
 */

import { screen } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { ComplianceScreen } from './ComplianceScreen';
import { ComplianceSectionScreen } from './ComplianceSectionScreen';
import type { ComplianceGate } from '../hooks/useComplianceAccess';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const OPEN: ComplianceGate = { access: { state: 'open' }, open: true, hint: '' };
let mockGate: ComplianceGate = OPEN;

jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('../hooks/useComplianceAccess', () => ({ useComplianceAccess: () => mockGate }));

const C = '/api/compliance';
const ANSWERS: Record<string, unknown> = {
    [`${C}/counts`]: { attention_open: 0, frameworks: { gdpr: { score: 91 } }, onboarded: true },
    [`${C}/frameworks`]: { frameworks: [{ id: 'gdpr', name_key: 'compliance.fw_gdpr_name', enabled: true, core: true }], custom: [] },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockGate = OPEN;
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
});

function render(ui: ReactElement) {
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>,
    );
}

describe('the gate', () => {
    it('tells a member without the permission who it is for, and asks the server nothing', async () => {
        mockGate = { access: { state: 'denied' }, open: false, hint: '' };
        await render(<ComplianceScreen />);
        expect(screen.getByText('For compliance officers')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('shows the hub locked with the plan line when the capability is missing', async () => {
        mockGate = { access: { state: 'locked', reason: 'ceiling' }, open: false, hint: 'Available on a higher plan' };
        await render(<ComplianceSectionScreen section="risks" />);
        expect(screen.getByText('The Compliance Center is not included in your plan')).toBeTruthy();
        expect(screen.getByText('Available on a higher plan')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalled();
    });
});

describe('an unknown section', () => {
    it('says so', async () => {
        await render(<ComplianceSectionScreen section="nope" />);
        expect(screen.getByText('This part of the Compliance Center does not exist.')).toBeTruthy();
    });
});
