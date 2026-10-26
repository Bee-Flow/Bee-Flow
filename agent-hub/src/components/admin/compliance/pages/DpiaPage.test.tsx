import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent, { UserEvent } from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import DpiaPage, { dpiaRows, defaultExpiry, DPIA_CHECK_ID } from './DpiaPage';
import { renderWithClient } from '../../../../test/render';
import { TABLE_FOLDED_ONLY } from '../../../shared/DataTable';
import { stub } from '@/test/mocks';

vi.mock('../../../../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

// The drawer reads the full record (answers included): the register list
// carries none (dpiaStore.listForOrg).
const fetchJson = vi.fn();
vi.mock('../../../../api/complianceApi', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, fetchJson: (...args: Parameters<typeof fetchJson>) => fetchJson(...args) };
});

afterEach(cleanup);

const CHECKS = [
    { check_id: DPIA_CHECK_ID, scope_id: 'agent_1', status: 'fail', evidence: { agent_name: 'HR screening agent', risk_reason: 'Evaluates applicants' } },
    { check_id: DPIA_CHECK_ID, scope_id: 'agent_2', status: 'pass', evidence: { agent_name: 'Support agent', risk_reason: 'Large-scale customer data' } },
    { check_id: DPIA_CHECK_ID, status: 'warn', evidence: {} }, // no scope: the org-level roll-up, not a row
    { check_id: 'GDPR-Art32-dlp-enabled', scope_id: 'agent_9', status: 'pass', evidence: {} },
];
const DPIA_LIST = [{ agent_id: 'agent_2', mode: 'questionnaire', risk_level: 'low', approved_at: '2026-08-01T10:00:00Z', expires_at: '2099-08-01T10:00:00Z' }];
const RECORD = {
    ...DPIA_LIST[0],
    answers: { purpose: 'Answer support questions', data_categories: 'Ticket text', automated_decisions: false, human_oversight: 'An agent sends every reply' },
    mitigations: ['PII redaction', 'EU-hosted model'],
};

beforeEach(() => {
    fetchJson.mockReset();
    fetchJson.mockImplementation(async (url) => (String(url).endsWith('/dpia/agent_2') ? RECORD : null));
});

function dpiaState(over = {}) {
    return { dpiaList: DPIA_LIST, savingId: null, refresh: vi.fn(), save: vi.fn().mockResolvedValue({}), pdfUrlFor: (id: string) => `/api/compliance/dpia/${id}/pdf`, ...over };
}

function pageProps(over: { dpia?: Record<string, unknown>; core?: Record<string, unknown> } = {}) {
    const { dpia, core, ...rest } = over;
    return {
        section: { id: 'dpia' }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null,
        exportsEnabled: true, dl: (u: string) => u, api: '/api/compliance', isMobile: false, setHeaderActions: vi.fn(),
        data: { dpia: dpiaState(stub<Parameters<typeof dpiaState>[0]>(dpia)), core: { checks: CHECKS, ...core } },
        ...rest,
    };
}

async function fillRequired(user: UserEvent) {
    await user.type(screen.getByTestId('dpia-q-purpose'), 'Screen applications');
    await user.type(screen.getByTestId('dpia-q-data'), 'CVs');
    await user.type(screen.getByTestId('dpia-q-oversight'), 'Recruiter reviews every result');
}

describe('dpiaRows / defaultExpiry', () => {
    it('keeps only the per-agent Art-35 rows', () => {
        const rows = dpiaRows(CHECKS, DPIA_LIST);
        expect(rows.map(r => r.agentId)).toEqual(['agent_1', 'agent_2']);
        expect(rows[1].dpia!.mode).toBe('questionnaire');
        expect(rows[0].dpia).toBeNull();
    });
    it('survives a checks list that has not loaded', () => {
        expect(dpiaRows(null, null)).toEqual([]);
    });
    it('expires an attestation twelve months out', () => {
        expect(defaultExpiry(new Date('2026-09-14T00:00:00Z'))).toContain('2027-09-14');
    });
});

describe('DpiaPage', () => {
    it('one row per high-risk agent; the pill says "Assessed {date}" or "No DPIA", how and until when in its title', () => {
        renderWithClient(<DpiaPage {...pageProps()} />);
        const none = screen.getByTestId('dpia-status-agent_1');
        expect(none.textContent).toBe('No DPIA');
        expect(none.dataset.tone).toBe('error');
        const done = screen.getByTestId('dpia-status-agent_2');
        expect(done.textContent).toMatch(/^Assessed 1 Aug( 2026)?$/);
        expect(done.dataset.tone).toBe('success');
        expect(done.getAttribute('title')).toMatch(/^questionnaire · Expires 1 Aug 2099$/);
    });

    it('an expired assessment is not "Assessed"', () => {
        renderWithClient(<DpiaPage {...pageProps({ dpia: { dpiaList: [{ ...DPIA_LIST[0], expires_at: '2020-01-01T00:00:00Z' }] } })} />);
        const pill = screen.getByTestId('dpia-status-agent_2');
        expect(pill.textContent).toMatch(/^Expired 1 Jan 2020$/);
        expect(pill.dataset.tone).toBe('error');
    });

    it('keeps the risk reason under the agent name when its column folds, with no status icon', () => {
        renderWithClient(<DpiaPage {...pageProps()} />);
        const line = screen.getByTestId('dpia-reason-line-agent_1');
        expect(line.textContent).toBe('Evaluates applicants');
        for (const cls of TABLE_FOLDED_ONLY[900].split(' ')) expect(line.className).toContain(cls);
        expect(screen.getByTestId('dpia-row-agent_1').querySelector('svg')).toBeNull();
    });

    it('says nothing needs a DPIA rather than showing an empty table', () => {
        renderWithClient(<DpiaPage {...pageProps({ core: { checks: [] } })} />);
        expect(screen.getByText('No agent needs a DPIA')).toBeTruthy();
    });

    it('shows skeletons while the DPIA list is being read', () => {
        renderWithClient(<DpiaPage {...pageProps({ dpia: { dpiaList: null } })} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
    });

    it('an agent with a DPIA on record opens on its summary, not on an empty form', async () => {
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps()} />);
        await user.click(screen.getByTestId('dpia-row-agent_2'));
        expect(screen.getByTestId('dpia-summary')).toBeTruthy();
        expect(screen.queryByTestId('dpia-form')).toBeNull();
        expect(screen.queryByTestId('dpia-submit')).toBeNull();
        expect(screen.getByTestId('dpia-summary-meta').textContent).toBe('questionnaire · Expires 1 Aug 2099');
        expect(screen.getByTestId('dpia-summary-risk').textContent).toContain('Low');
        await waitFor(() => expect(screen.getByTestId('dpia-answer-purpose').textContent).toContain('Answer support questions'));
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/dpia\/agent_2$/);
        expect(screen.getByTestId('dpia-answer-data').textContent).toContain('Ticket text');
        expect(screen.getByTestId('dpia-answer-automated').textContent).toContain('No');
        expect(screen.getByTestId('dpia-answer-oversight').textContent).toContain('An agent sends every reply');
        expect(screen.getByTestId('dpia-answer-mitigations').querySelectorAll('li')).toHaveLength(2);
    });

    it('says so when the recorded answers cannot be read', async () => {
        fetchJson.mockRejectedValue(new Error('500 Internal Server Error'));
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps()} />);
        await user.click(screen.getByTestId('dpia-row-agent_2'));
        expect(await screen.findByTestId('dpia-answers-failed')).toBeTruthy();
        expect(screen.getByTestId('dpia-summary-meta')).toBeTruthy();
    });

    it('Re-assess pre-fills the form from the recorded answers and measures', async () => {
        const save = vi.fn();
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps({ dpia: { save } })} />);
        await user.click(screen.getByTestId('dpia-row-agent_2'));
        await screen.findByTestId('dpia-answer-purpose');
        await user.click(screen.getByTestId('dpia-reassess'));
        expect((screen.getByTestId('dpia-q-purpose') as HTMLInputElement).value).toBe('Answer support questions');
        expect((screen.getByTestId('dpia-q-data') as HTMLInputElement).value).toBe('Ticket text');
        expect((screen.getByTestId('dpia-q-oversight') as HTMLInputElement).value).toBe('An agent sends every reply');
        expect((screen.getByTestId('dpia-q-mitigations') as HTMLInputElement).value).toBe('PII redaction\nEU-hosted model');
        expect((screen.getByTestId('dpia-q-risk') as HTMLInputElement).value).toBe('low');
        await user.click(screen.getByTestId('dpia-submit'));
        expect(save).toHaveBeenCalledWith('agent_2', expect.objectContaining({
            mode: 'questionnaire', risk_level: 'low', mitigations: ['PII redaction', 'EU-hosted model'],
        }));
        // Cancel goes back to the summary without saving.
        await user.click(screen.getByTestId('dpia-reassess-cancel'));
        expect(screen.getByTestId('dpia-summary')).toBeTruthy();
    });

    it('Save stays disabled until purpose, data and oversight are filled', async () => {
        const save = vi.fn();
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps({ dpia: { save } })} />);
        await user.click(screen.getByTestId('dpia-row-agent_1'));
        const submit = screen.getByTestId('dpia-submit');
        expect((submit as HTMLInputElement).disabled).toBe(true);
        expect(screen.getByTestId('dpia-required').textContent).toBe('Fill in purpose, data and oversight to save');
        await user.click(submit);
        expect(save).not.toHaveBeenCalled();
        await user.type(screen.getByTestId('dpia-q-purpose'), 'Screen applications');
        await user.type(screen.getByTestId('dpia-q-data'), 'CVs');
        expect((submit as HTMLInputElement).disabled).toBe(true);
        await user.type(screen.getByTestId('dpia-q-oversight'), '   ');
        expect((submit as HTMLInputElement).disabled).toBe(true);
        await user.type(screen.getByTestId('dpia-q-oversight'), 'Recruiter');
        expect((submit as HTMLInputElement).disabled).toBe(false);
        expect(screen.queryByTestId('dpia-required')).toBeNull();
    });

    it('records a questionnaire as answers plus mitigations, one per line', async () => {
        const save = vi.fn();
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps({ dpia: { save } })} />);
        await user.click(screen.getByTestId('dpia-row-agent_1'));
        await fillRequired(user);
        await user.click(screen.getByTestId('dpia-q-automated').querySelector('input')!);
        await user.type(screen.getByTestId('dpia-q-mitigations'), 'Redaction{Enter}{Enter}Four-eyes check ');
        await user.selectOptions(screen.getByTestId('dpia-q-risk'), 'high');
        await user.click(screen.getByTestId('dpia-submit'));
        expect(save).toHaveBeenCalledWith('agent_1', expect.objectContaining({
            mode: 'questionnaire',
            risk_level: 'high',
            mitigations: ['Redaction', 'Four-eyes check'],
        }));
        expect(save.mock.calls[0][1].answers).toEqual({
            purpose: 'Screen applications',
            data_categories: 'CVs',
            automated_decisions: true,
            human_oversight: 'Recruiter reviews every result',
        });
    });

    it('an assessment kept elsewhere is a quiet link under the form that records an attestation', async () => {
        const save = vi.fn();
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps({ dpia: { save } })} />);
        await user.click(screen.getByTestId('dpia-row-agent_1'));
        const link = screen.getByTestId('dpia-attest');
        expect(link.textContent).toBe('Assessed outside Bee Flow? Record an attestation');
        expect(link.getAttribute('title')).toContain('outside Bee Flow');
        expect(screen.getByTestId('dpia-form').contains(link)).toBe(true);
        await user.click(link);
        expect(save).toHaveBeenCalledWith('agent_1', expect.objectContaining({ mode: 'attestation', risk_level: 'medium' }));
        expect(save.mock.calls[0][1].expires_at).toBeTruthy();
    });

    it('offers the PDF only for an agent that has a DPIA on record', async () => {
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps()} />);
        await user.click(screen.getByTestId('dpia-row-agent_1'));
        expect(screen.queryByTestId('dpia-pdf')).toBeNull();
        await user.click(screen.getByTestId('dpia-row-agent_2'));
        expect(screen.getByTestId('dpia-pdf').getAttribute('href')).toBe('/api/compliance/dpia/agent_2/pdf');
    });

    it('withholds the PDF when downloads are off', async () => {
        const { container } = renderWithClient(<DpiaPage {...pageProps()} dl={() => null} />);
        await userEvent.setup().click(screen.getByTestId('dpia-row-agent_2'));
        expect(container.querySelector('a[download]')).toBeNull();
    });

    it('forgets the form when another agent is opened', async () => {
        const user = userEvent.setup();
        const checks = [...CHECKS, { check_id: DPIA_CHECK_ID, scope_id: 'agent_3', status: 'fail', evidence: { agent_name: 'Claims agent' } }];
        renderWithClient(<DpiaPage {...pageProps({ core: { checks } })} />);
        await user.click(screen.getByTestId('dpia-row-agent_1'));
        await user.type(screen.getByTestId('dpia-q-purpose'), 'Screen applications');
        await user.click(screen.getByTestId('dpia-row-agent_3'));
        expect((screen.getByTestId('dpia-q-purpose') as HTMLInputElement).value).toBe('');
    });

    it('opens straight onto the focused agent, keeps its id as the title tooltip, and closes on a second click', async () => {
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps(stub<Parameters<typeof pageProps>[0]>({ focusId: 'agent_2' }))} />);
        const title = await screen.findByTestId('dpia-drawer-title');
        expect(title.textContent).toBe('Support agent');
        expect(title.getAttribute('title')).toBe('agent_2');
        expect(screen.queryByTestId('dpia-drawer-id')).toBeNull();
        await user.click(screen.getByTestId('dpia-row-agent_2'));
        expect(screen.queryByTestId('dpia-drawer')).toBeNull();
    });

    it('disables saving while this agent is being written', async () => {
        const user = userEvent.setup();
        renderWithClient(<DpiaPage {...pageProps({ dpia: { savingId: 'agent_1' } })} />);
        await user.click(screen.getByTestId('dpia-row-agent_1'));
        await fillRequired(user);
        expect((screen.getByTestId('dpia-submit') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByTestId('dpia-attest') as HTMLInputElement).disabled).toBe(true);
    });
});

describe('DpiaPage — phone (artboard 1h)', () => {
    it('the drawer is a right-side modal; desktop keeps the inline card', async () => {
        const user = userEvent.setup();
        const { unmount } = renderWithClient(<DpiaPage {...pageProps(stub<Parameters<typeof pageProps>[0]>({ isMobile: true }))} />);
        await user.click(screen.getByTestId('dpia-card-agent_1'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('dpia-drawer').dataset.mode).toBe('modal');
        unmount();
        renderWithClient(<DpiaPage {...pageProps()} />);
        await user.click(screen.getByTestId('dpia-row-agent_1'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('dpia-drawer').dataset.mode).toBe('inline');
    });

    it('a phone card carries the same pill: a red "No DPIA" for an agent without one', () => {
        renderWithClient(<DpiaPage {...pageProps(stub<Parameters<typeof pageProps>[0]>({ isMobile: true }))} />);
        const none = screen.getByTestId('dpia-card-status-agent_1');
        expect(none.textContent).toBe('No DPIA');
        expect(none.dataset.tone).toBe('error');
        expect(screen.getByTestId('dpia-card-status-agent_2').dataset.tone).toBe('success');
        expect(screen.getByTestId('dpia-card-agent_1').textContent).toContain('Evaluates applicants');
    });
});
