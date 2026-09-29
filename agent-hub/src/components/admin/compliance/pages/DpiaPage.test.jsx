import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import DpiaPage, { dpiaRows, defaultExpiry, DPIA_CHECK_ID } from './DpiaPage';

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

afterEach(cleanup);

const CHECKS = [
    { check_id: DPIA_CHECK_ID, scope_id: 'agent_1', status: 'fail', evidence: { agent_name: 'HR screening agent', risk_reason: 'Evaluates applicants' } },
    { check_id: DPIA_CHECK_ID, scope_id: 'agent_2', status: 'pass', evidence: { agent_name: 'Support agent', risk_reason: 'Large-scale customer data' } },
    { check_id: DPIA_CHECK_ID, status: 'warn', evidence: {} }, // no scope: the org-level roll-up, not a row
    { check_id: 'GDPR-Art32-dlp-enabled', scope_id: 'agent_9', status: 'pass', evidence: {} },
];
const DPIA_LIST = [{ agent_id: 'agent_2', mode: 'attestation', approved_at: '2026-08-01T10:00:00Z', expires_at: '2027-08-01T10:00:00Z' }];

function dpiaState(over = {}) {
    return { dpiaList: DPIA_LIST, savingId: null, refresh: vi.fn(), save: vi.fn().mockResolvedValue({}), pdfUrlFor: (id) => `/api/compliance/dpia/${id}/pdf`, ...over };
}

function pageProps(over = {}) {
    const { dpia, core, ...rest } = over;
    return {
        section: { id: 'dpia' }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null,
        exportsEnabled: true, dl: (u) => u, api: '/api/compliance', isMobile: false, setHeaderActions: vi.fn(),
        data: { dpia: dpiaState(dpia), core: { checks: CHECKS, ...core } },
        ...rest,
    };
}

describe('dpiaRows / defaultExpiry', () => {
    it('keeps only the per-agent Art-35 rows', () => {
        const rows = dpiaRows(CHECKS, DPIA_LIST);
        expect(rows.map(r => r.agentId)).toEqual(['agent_1', 'agent_2']);
        expect(rows[1].dpia.mode).toBe('attestation');
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
    it('lists one row per high-risk agent with its DPIA status', () => {
        render(<DpiaPage {...pageProps()} />);
        expect(screen.getByTestId('dpia-row-agent_1')).toBeTruthy();
        expect(screen.getByTestId('dpia-status-agent_1').textContent).toContain('No DPIA on record');
        expect(screen.getByTestId('dpia-status-agent_2').textContent).toContain('DPIA on record');
    });

    it('says nothing needs a DPIA rather than showing an empty table', () => {
        render(<DpiaPage {...pageProps({ core: { checks: [] } })} />);
        expect(screen.getByText('No agent needs a DPIA')).toBeTruthy();
    });

    it('shows skeletons while the DPIA list is being read', () => {
        render(<DpiaPage {...pageProps({ dpia: { dpiaList: null } })} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
    });

    it('attests an agent with a twelve-month validity', () => {
        const save = vi.fn();
        render(<DpiaPage {...pageProps({ dpia: { save } })} />);
        fireEvent.click(screen.getByTestId('dpia-row-agent_1'));
        fireEvent.click(screen.getByTestId('dpia-attest'));
        expect(save).toHaveBeenCalledWith('agent_1', expect.objectContaining({ mode: 'attestation', risk_level: 'medium' }));
        expect(save.mock.calls[0][1].expires_at).toBeTruthy();
    });

    it('records a questionnaire as answers plus mitigations, one per line', () => {
        const save = vi.fn();
        render(<DpiaPage {...pageProps({ dpia: { save } })} />);
        fireEvent.click(screen.getByTestId('dpia-row-agent_1'));
        fireEvent.change(screen.getByTestId('dpia-q-purpose'), { target: { value: 'Screen applications' } });
        fireEvent.change(screen.getByTestId('dpia-q-data'), { target: { value: 'CVs' } });
        fireEvent.click(screen.getByTestId('dpia-q-automated').querySelector('input'));
        fireEvent.change(screen.getByTestId('dpia-q-oversight'), { target: { value: 'Recruiter reviews every result' } });
        fireEvent.change(screen.getByTestId('dpia-q-mitigations'), { target: { value: 'Redaction\n\nFour-eyes check ' } });
        fireEvent.change(screen.getByTestId('dpia-q-risk'), { target: { value: 'high' } });
        fireEvent.click(screen.getByTestId('dpia-submit'));
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

    it('offers the PDF only for an agent that has a DPIA on record', () => {
        render(<DpiaPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('dpia-row-agent_1'));
        expect(screen.queryByTestId('dpia-pdf')).toBeNull();
        fireEvent.click(screen.getByTestId('dpia-row-agent_2'));
        expect(screen.getByTestId('dpia-pdf').getAttribute('href')).toBe('/api/compliance/dpia/agent_2/pdf');
    });

    it('withholds the PDF when downloads are off', () => {
        const { container } = render(<DpiaPage {...pageProps()} dl={() => null} />);
        fireEvent.click(screen.getByTestId('dpia-row-agent_2'));
        expect(container.querySelector('a[download]')).toBeNull();
    });

    it('forgets the form when another agent is opened', () => {
        render(<DpiaPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('dpia-row-agent_1'));
        fireEvent.change(screen.getByTestId('dpia-q-purpose'), { target: { value: 'Screen applications' } });
        fireEvent.click(screen.getByTestId('dpia-row-agent_2'));
        expect(screen.getByTestId('dpia-q-purpose').value).toBe('');
    });

    it('opens straight onto the focused agent and closes on a second click', async () => {
        render(<DpiaPage {...pageProps({ focusId: 'agent_2' })} />);
        await waitFor(() => expect(screen.getByTestId('dpia-drawer-id').textContent).toBe('agent_2'));
        fireEvent.click(screen.getByTestId('dpia-row-agent_2'));
        expect(screen.queryByTestId('dpia-drawer')).toBeNull();
    });

    it('disables saving while this agent is being written', () => {
        render(<DpiaPage {...pageProps({ dpia: { savingId: 'agent_1' } })} />);
        fireEvent.click(screen.getByTestId('dpia-row-agent_1'));
        expect(screen.getByTestId('dpia-submit').disabled).toBe(true);
        expect(screen.getByTestId('dpia-attest').disabled).toBe(true);
    });
});

describe('DpiaPage — phone (artboard 1h)', () => {
    it('the drawer is a right-side modal; desktop keeps the inline card', () => {
        const { unmount } = render(<DpiaPage {...pageProps({ isMobile: true })} />);
        fireEvent.click(screen.getByTestId('dpia-card-agent_1'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('dpia-drawer').dataset.mode).toBe('modal');
        unmount();
        render(<DpiaPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('dpia-row-agent_1'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('dpia-drawer').dataset.mode).toBe('inline');
    });
});
