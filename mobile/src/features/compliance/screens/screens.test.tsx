/**
 * The Compliance Center's screens against canned server answers: what each
 * loads, the exact request each write sends, and who is turned away. One
 * file, so the mocks and fixtures are written once.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { ComplianceRecordScreen } from './ComplianceRecordScreen';
import { ComplianceScreen } from './ComplianceScreen';
import { ComplianceSectionScreen } from './ComplianceSectionScreen';
import { uploadEvidence } from '../api/upload';
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
jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn().mockResolvedValue('file://x') }));
jest.mock('expo-document-picker', () => ({
    getDocumentAsync: jest.fn().mockResolvedValue({ canceled: false, assets: [{ uri: 'file://proof.pdf', name: 'proof.pdf', mimeType: 'application/pdf', size: 10 }] }),
}));
jest.mock('../api/upload', () => ({ ...jest.requireActual('../api/upload'), uploadEvidence: jest.fn() }));
jest.mock('../hooks/useComplianceAccess', () => ({ useComplianceAccess: () => mockGate }));

const C = '/api/compliance';
const ANSWERS: Record<string, unknown> = {
    [`${C}/counts`]: {
        attention_open: 7,
        last_run: { at: '2026-09-01T09:12:00' },
        frameworks: { gdpr: { score: 91 }, iso27001: { score: 55 } },
        frameworks_summary: { candidates: 4, recently_in_force: 0 },
        dsr: { open: 3, overdue: 1 },
        onboarded: true,
    },
    [`${C}/frameworks`]: {
        frameworks: [
            { id: 'gdpr', name_key: 'compliance.fw_gdpr_name', enabled: true, core: true },
            { id: 'iso27001', name_key: 'compliance.fw_iso27001_name', enabled: true },
            { id: 'nis2', name_key: 'compliance.fw_nis2_name', enabled: false },
        ],
        custom: [],
    },
    [`${C}/attention`]: {
        items: [{ id: 'register:inc', source: 'register', status: 'fail', severity: 'high', title: 'Incident clock running', meta: { frameworks: [{ regulation: 'GDPR', ref: '33' }] }, action: { target: '/app/admin/compliance/incidents/4' } }],
    },
    [`${C}/deadlines`]: { items: [{ id: 'dsr:9', kind: 'dsr', ref: '#9', title: 'Deletion request', state: 'urgent', meta: { article: '12–22' }, target: { section: 'dsr', id: '9' } }] },
    [`${C}/org-users`]: [{ id: 'u1', displayName: 'Ann' }],
    [`${C}/iso/risks`]: { risks: [{ id: 1, title: 'Prompt leak', status: 'open', score: 16, likelihood: 4, impact: 4, category: 'confidentiality', owner_user_id: 'u1' }], treatments: [] },
    [`${C}/incidents`]: [{ id: 4, kind: 'breach', title: 'Laptop lost', status: 'open', severity: 'high', high_risk: true }],
    [`${C}/checks`]: [{ check_id: 'GDPR-Art30', regulation: 'GDPR', status: 'fail', severity: 'high', article: '30', autoFixId: 'fix1' }],
    [`${C}/checks/GDPR-Art30/history`]: [{ status: 'fail', run_at: '2026-09-01T00:00:00Z' }],
    [`${C}/evidence/GDPR-Art30`]: [{ id: 1, hash: 'abcdef0123456789abcdef', captured_at: '2026-09-01T00:00:00Z' }],
    [`${C}/settings`]: { dpo_name: 'Dee', onboarded_at: '2026-01-01', legal_bases: ['consent'] },
    [`${C}/ropa`]: { controller: { name: 'Acme' }, legal_bases: ['consent'], activities: [{ activity_id: 'a', name: 'Chat assistants' }], processors: [{ operator: 'openai', is_eu: false, scc_confirmed: false }] },
    [`${C}/access-audit`]: { entries: [{ id: 'e1', action: 'login_failed', created_at: '2026-09-01T00:00:00Z' }], total: 1, limit: 50, offset: 0 },
    [`${C}/access-audit/actions`]: { actions: ['login_failed'] },
    [`${C}/portability`]: [{ kind: 'chats', label_key: null, held: 3, formats: ['json'], mounted: true }],
    [`${C}/iso/audit`]: { audits: [{ id: 1, title: 'Q3 audit', status: 'planned' }], findings: [], reviews: [], ncs: [{ id: 4, title: 'Stale access', status: 'open' }], objectives: [], mr_inputs: null },
    [`${C}/custom/frameworks`]: [{ id: 'f1', code: 'Q', name: 'Customer Q', status: 'active' }],
    [`${C}/custom/frameworks/f1`]: { id: 'f1', code: 'Q', name: 'Customer Q', status: 'active', checks: [{ id: 'c1', ref: 'Q1', title: 'Backups', evidence_required: true }] },
    '/api/dsr/requests': [{ id: 9, request_type: 'deletion', status: 'pending', subject_email_masked: 'j***@x.nl', identity_status: 'unverified' }],
    '/api/dsr/requests/9/timeline': { id: 9, timeline: [{ kind: 'received', at: '2026-09-01T00:00:00Z' }] },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockGate = OPEN;
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
    (api.post as jest.Mock).mockResolvedValue({ ran: 3, score: { score: 88 } });
    (api.put as jest.Mock).mockResolvedValue({});
    (api.patch as jest.Mock).mockResolvedValue({});
    (api.delete as jest.Mock).mockResolvedValue({ ok: true });
});

function render(ui: ReactElement) {
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>,
    );
}

describe('the hub', () => {
    it('shows the run, the scores, what needs attention and the deadlines', async () => {
        await render(<ComplianceScreen />);
        expect(await screen.findByText('run today 09:12 · 7 open')).toBeTruthy();
        expect(await screen.findByText('Incident clock running')).toBeTruthy();
        expect(await screen.findByText('#9 · Deletion request')).toBeTruthy();
        expect(screen.getByText('91')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('attention-register:inc'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/compliance/incidents/4');
        await fireEvent.press(screen.getByTestId('deadline-dsr:9'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/compliance/dsr/9');
        await fireEvent.press(screen.getByTestId('report-report'));
        expect(shareServerFile).toHaveBeenCalledWith(`${C}/report.pdf`, 'compliance-report.pdf', 'application/pdf');
    });

    it('runs every check on demand', async () => {
        await render(<ComplianceScreen />);
        expect(await screen.findByText('Run checks now')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('compliance-run'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/checks/run`));
        expect(await screen.findByText(/Compliance scan complete · 88\/100/)).toBeTruthy();
    });

    it('lists the frameworks and the registers with their counts', async () => {
        await render(<ComplianceScreen />);
        await fireEvent.press(await screen.findByText('Registers'));
        expect(await screen.findByText('1 · 3 open')).toBeTruthy();
        expect(screen.getByText('Risk register with treatment plans and owner sign-off.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('section-risks'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/compliance/risks');
        await fireEvent.press(screen.getByText('Frameworks'));
        expect(await screen.findByText('4 candidates')).toBeTruthy();
    });

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

describe('a register', () => {
    it('lists the risks and adds one with the create body', async () => {
        await render(<ComplianceSectionScreen section="risks" />);
        expect(await screen.findByText('Prompt leak')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('create-risks'));
        await fireEvent.changeText(screen.getByTestId('field-title'), 'Vendor outage');
        await fireEvent.press(screen.getByTestId('field-category-availability'));
        const [, submit] = screen.getAllByLabelText('Add risk');
        await fireEvent.press(submit as NonNullable<typeof submit>);
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith(`${C}/iso/risks`, { title: 'Vendor outage', category: 'availability', likelihood: 3, impact: 3 }),
        );
    });

    it('seeds the suggested risks', async () => {
        await render(<ComplianceSectionScreen section="iso_risks" />);
        await fireEvent.press(await screen.findByTestId('list-action-seed'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/iso/risks/seed`, {}));
    });

    it('switches between the audit registers', async () => {
        await render(<ComplianceSectionScreen section="audits" />);
        expect(await screen.findByText('Q3 audit')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('register-tabs-ncs'));
        expect(await screen.findByText('Stale access')).toBeTruthy();
    });
});

describe('a record', () => {
    it('edits a risk and sends only the changed field', async () => {
        await render(<ComplianceRecordScreen section="risks" id="1" />);
        expect(await screen.findByText('Ann')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('record-edit'));
        await fireEvent.changeText(screen.getByTestId('field-title'), 'Prompt leak via plugins');
        await fireEvent.press(screen.getAllByLabelText('Save')[0] as never);
        await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${C}/iso/risks/1`, { title: 'Prompt leak via plugins' }));
    });

    it('accepts a risk after the confirmation', async () => {
        await render(<ComplianceRecordScreen section="risks" id="1" />);
        await fireEvent.press(await screen.findByTestId('action-accept'));
        const [, confirm] = screen.getAllByLabelText('Accept risk');
        await fireEvent.press(confirm as NonNullable<typeof confirm>);
        await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${C}/iso/risks/1`, { status: 'accepted' }));
    });

    it('moves an incident along and records the authority notification with its reference', async () => {
        await render(<ComplianceRecordScreen section="incidents" id="4" />);
        await fireEvent.press(await screen.findByTestId('action-assess'));
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`${C}/incidents/4`, { status: 'assessing' }));
        await fireEvent.press(screen.getByTestId('action-authority'));
        await fireEvent.changeText(screen.getByTestId('field-authority_reference'), 'AP-77');
        const [, submit] = screen.getAllByLabelText('Record authority notification');
        await fireEvent.press(submit as NonNullable<typeof submit>);
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`${C}/incidents/4`, { status: 'authority_notified', authority_reference: 'AP-77' }));
    });

    it('shows a request’s timeline and fulfils it', async () => {
        await render(<ComplianceRecordScreen section="dsr" id="9" />);
        expect(await screen.findByText('#9 · Deletion request')).toBeTruthy();
        expect(await screen.findByText('received')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('action-fulfil'));
        await fireEvent.changeText(screen.getByTestId('field-result_summary'), 'Account and memories erased');
        const [, submit] = screen.getAllByLabelText('Fulfil and e-mail the data subject');
        await fireEvent.press(submit as NonNullable<typeof submit>);
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/dsr/requests/9/fulfil', { status: 'fulfilled', result_summary: 'Account and memories erased', notify_subject: true }),
        );
    });

    it('attests a custom item with an uploaded evidence file', async () => {
        (uploadEvidence as jest.Mock).mockResolvedValue({ sha256: 'abc', filename: 'proof.pdf' });
        await render(<ComplianceRecordScreen section="custom" id="f1" />);
        await fireEvent.press(await screen.findByText('Q1 · Backups'));
        await fireEvent.press(screen.getByLabelText('Attest'));
        await fireEvent.press(await screen.findByTestId('attest-outcome-compliant'));
        await fireEvent.press(screen.getByTestId('attest-upload'));
        expect(await screen.findByText('proof.pdf')).toBeTruthy();
        await fireEvent.changeText(screen.getByTestId('attest-statement'), 'Restore tested');
        await fireEvent.press(screen.getByLabelText('Record attestation'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith(`${C}/custom/checks/c1/attest`, { outcome: 'compliant', statement: 'Restore tested', evidence_refs: [{ sha256: 'abc', filename: 'proof.pdf' }] }),
        );
        expect(uploadEvidence).toHaveBeenCalledWith(expect.objectContaining({ name: 'proof.pdf' }), { subjectType: 'custom_check', subjectId: null, checkId: null });
    });
});

describe('a framework and the pages of their own', () => {
    it('lists a framework’s checks and re-runs one', async () => {
        await render(<ComplianceSectionScreen section="gdpr" />);
        await fireEvent.press(await screen.findByTestId('check-GDPR-Art30'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/compliance/gdpr/GDPR-Art30');
        await render(<ComplianceRecordScreen section="gdpr" id="GDPR-Art30" />);
        expect(await screen.findByText(/sha256 abcdef0123456789/)).toBeTruthy();
        await fireEvent.press(screen.getByTestId('check-rerun'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/checks/GDPR-Art30/run`));
        await fireEvent.press(screen.getByTestId('check-autofix'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/checks/GDPR-Art30/auto-fix`, {}));
    });

    it('enables a framework', async () => {
        await render(<ComplianceSectionScreen section="frameworks" />);
        await fireEvent.press(await screen.findByTestId('framework-toggle-nis2'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/frameworks/nis2/enable`, {}));
    });

    it('saves only the changed settings column', async () => {
        await render(<ComplianceSectionScreen section="settings" />);
        await fireEvent.changeText(await screen.findByTestId('setting-dpo_name'), 'Dee Jansen');
        await fireEvent.press(screen.getByTestId('setting-legal_bases-contract'));
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${C}/settings`, { dpo_name: 'Dee Jansen', legal_bases: ['consent', 'contract'] }));
    });

    it('marks the ROPA reviewed and attests an SCC', async () => {
        await render(<ComplianceSectionScreen section="ropa" />);
        await fireEvent.press(await screen.findByTestId('ropa-review'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/ropa/review`, {}));
        await fireEvent.press(screen.getByTestId('scc-openai'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${C}/settings/scc`, { operator: 'openai', confirmed: true }));
    });

    it('reads the access log and exports what it shows', async () => {
        await render(<ComplianceSectionScreen section="access_log" />);
        expect((await screen.findAllByText('Sign-in refused')).length).toBe(2);
        await fireEvent.press(screen.getByTestId('aa-filter-login_failed'));
        await waitFor(() => expect(api.get).toHaveBeenCalledWith(`${C}/access-audit`, expect.objectContaining({ query: expect.objectContaining({ action: 'login_failed' }) })));
        // The filtered page reloads the list, which hides its header until the answer lands.
        await fireEvent.press(await screen.findByTestId('aa-export'));
        // shareDownload is async: the share lands after its own awaits.
        await waitFor(() =>
            expect(shareServerFile).toHaveBeenCalledWith(`${C}/access-audit/export?action=login_failed`, 'access-audit.json', 'application/json'),
        );
    });

    it('shows the portability matrix, and an unknown section', async () => {
        await render(<ComplianceSectionScreen section="portability" />);
        expect(await screen.findByText('Exportable')).toBeTruthy();
        await render(<ComplianceSectionScreen section="nope" />);
        expect(screen.getByText('This part of the Compliance Center does not exist.')).toBeTruthy();
    });
});
