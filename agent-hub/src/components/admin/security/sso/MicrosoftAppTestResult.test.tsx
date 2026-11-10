import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import MicrosoftAppTestResult from './MicrosoftAppTestResult';
import type { TeamsDiagnosticsReport } from '@/components/meetings/teamsSetup/types';

const REPORT: TeamsDiagnosticsReport = {
    level: 'platform', ranAt: '2026-11-10T10:00:00.000Z', overall: 'fail',
    checks: [
        { id: 'app.config', option: 'app', status: 'pass', code: 'ok', params: { tenantMode: 'single' }, remediation: null, fixer: null, dependsOn: [] },
        { id: 'app.token', option: 'app', status: 'fail', code: 'secret_expired', params: { aadsts: 'AADSTS7000222' }, remediation: 'teams_setup.fix.new_client_secret', fixer: 'platform_admin', dependsOn: ['app.config'] },
        { id: 'app.redirect_uris', option: 'app', status: 'unknown', code: 'manual_check', params: { uris: ['https://flow.example/auth/callback/microsoft', 'https://flow.example/api/integrations/microsoft/callback'] }, remediation: 'teams_setup.fix.register_redirect_uris', fixer: 'platform_admin', dependsOn: [] },
    ],
};

describe('MicrosoftAppTestResult', () => {
    it('renders nothing without a report', () => {
        const { container } = render(<MicrosoftAppTestResult report={null} />);
        expect(container.innerHTML).toBe('');
    });

    it('shows the app registration checks with the AADSTS code and the fix', () => {
        render(<MicrosoftAppTestResult report={REPORT} />);
        expect(screen.getByText('Microsoft app registration test')).toBeTruthy();
        expect(screen.getByText('App registration details are filled in')).toBeTruthy();
        expect(screen.getByText('The client secret has expired (AADSTS7000222).')).toBeTruthy();
        expect(screen.getByText(/Create a new client secret under Certificates & secrets/)).toBeTruthy();
        expect(screen.getAllByText('The Bee Flow platform administrator must fix this')).toHaveLength(2);
        expect(screen.getByText(/https:\/\/flow\.example\/auth\/callback\/microsoft, https:\/\/flow\.example\/api\/integrations\/microsoft\/callback/)).toBeTruthy();
        expect(screen.getByRole('status').textContent).toMatch(/cannot work yet/);
    });
});
