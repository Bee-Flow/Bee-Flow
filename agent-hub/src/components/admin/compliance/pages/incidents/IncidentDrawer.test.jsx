import React from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import IncidentDrawer, { savePatch, craBody } from './IncidentDrawer';

vi.mock('../../../../../hooks/useTranslation', () => {
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

const NOW = Date.now();
const H = 3_600_000;
const iso = (ms) => new Date(NOW + ms).toISOString();

const BREACH = {
    id: 4, kind: 'breach', status: 'open', title: 'Lost laptop', description: 'Unencrypted spreadsheet on a stolen laptop',
    severity: 'high', high_risk: true, detected_at: iso(-10 * H), deadline_at: iso(62 * H), notes: [{ at: iso(-9 * H), text: 'Device remote-wiped' }],
};

const VULN = {
    id: 9, kind: 'vulnerability', status: 'open', title: 'Heap overflow in parser', severity: 'critical',
    cve_ids: ['CVE-2026-1234'], exploited_in_wild: true, affected_products: [{ name: 'beeflow-server', version_range: '< 3.4.2' }],
    detected_at: iso(-2 * H),
};

function drawer(over = {}) {
    const handlers = {
        onUpdate: vi.fn().mockResolvedValue({}),
        onNotify: vi.fn().mockResolvedValue({}),
        onCraReport: vi.fn().mockResolvedValue({}),
        onCustomerNotified: vi.fn().mockResolvedValue({}),
        onClose: vi.fn(),
    };
    const utils = render(<IncidentDrawer incident={BREACH} {...handlers} {...over} />);
    return { ...utils, ...handlers };
}

describe('IncidentDrawer — the GDPR breach row', () => {
    it('heads the drawer with INC-{id}, the severity and the status, and lists the clocks with their due stamps', () => {
        drawer();
        const header = screen.getByTestId('inc-drawer-header');
        expect(header.textContent).toMatch(/INC-4/);
        expect(header.textContent).toMatch(/Lost laptop/);
        expect(header.textContent).toMatch(/Open/);
        const clocks = screen.getByTestId('inc-drawer-clocks');
        const stages = within(clocks).getAllByRole('listitem');
        expect(stages.map(li => li.getAttribute('data-stage'))).toEqual(['notification']);
        expect(stages[0].getAttribute('data-done')).toBe('false');
        expect(stages[0].textContent).toMatch(/due/);
    });

    it('offers the assessment, the one e-mail Bee Flow sends and the close action — and the attestation sentence', () => {
        const { onUpdate, onNotify } = drawer();
        fireEvent.click(screen.getByTestId('inc-drawer-assess'));
        expect(onUpdate).toHaveBeenCalledWith(4, { status: 'assessing' });

        fireEvent.click(screen.getByTestId('inc-drawer-notify'));
        expect(onNotify).toHaveBeenCalledWith(4);

        fireEvent.click(screen.getByTestId('inc-drawer-close-incident'));
        expect(onUpdate).toHaveBeenLastCalledWith(4, expect.objectContaining({ status: 'closed' }));
        expect(screen.getByTestId('inc-drawer-actions').textContent).toMatch(/attestation/i);
    });

    it('records the authority notification with the reference the user typed, and nothing else', () => {
        const { onUpdate } = drawer();
        fireEvent.change(screen.getByTestId('inc-drawer-authority-ref'), { target: { value: '  AP-2026-118  ' } });
        fireEvent.click(screen.getByTestId('inc-drawer-authority'));
        expect(onUpdate).toHaveBeenCalledWith(4, { status: 'authority_notified', authority_reference: 'AP-2026-118' });
    });

    it('offers the Art. 34 action only for a high-risk breach, and hides a stamp that is already set', () => {
        drawer();
        expect(screen.getByTestId('inc-drawer-subjects')).toBeTruthy();
        cleanup();

        drawer({ incident: { ...BREACH, high_risk: false, recipients_notified_at: iso(-8 * H) } });
        expect(screen.queryByTestId('inc-drawer-subjects')).toBeNull();
        expect(screen.queryByTestId('inc-drawer-notify')).toBeNull();
    });

    it('a closed incident has no actions left — only its record', () => {
        drawer({ incident: { ...BREACH, status: 'closed', closed_at: iso(-H), authority_notified_at: iso(-30 * H) } });
        expect(screen.queryByTestId('inc-drawer-actions')).toBeNull();
        expect(screen.getByTestId('inc-drawer-stamps').textContent).toMatch(/Supervisory authority/);
    });

    it('Save stays disabled until an editable field changes, then sends an allow-listed patch', () => {
        const { onUpdate } = drawer();
        const save = screen.getByTestId('inc-drawer-save');
        expect(save.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('inc-drawer-title'), { target: { value: 'Lost laptop (encrypted after all)' } });
        expect(save.disabled).toBe(false);
        fireEvent.click(save);
        expect(onUpdate).toHaveBeenCalledWith(4, {
            title: 'Lost laptop (encrypted after all)',
            description: 'Unencrypted spreadsheet on a stolen laptop',
            severity: 'high',
            high_risk: true,
        });
    });

    it('an emptied title can never be saved', () => {
        drawer();
        fireEvent.change(screen.getByTestId('inc-drawer-title'), { target: { value: '   ' } });
        expect(screen.getByTestId('inc-drawer-save').disabled).toBe(true);
    });

    it('shows the log the server kept', () => {
        drawer();
        expect(screen.getByText(/Device remote-wiped/)).toBeTruthy();
    });
});

describe('IncidentDrawer — the CRA vulnerability row', () => {
    it('lists the 24 h · 72 h · 14 d clocks and the CVE / exploited / affected block', () => {
        drawer({ incident: VULN });
        expect(screen.getByTestId('inc-drawer-header').textContent).toMatch(/VULN-9/);
        const stages = within(screen.getByTestId('inc-drawer-clocks')).getAllByRole('listitem');
        expect(stages.map(li => li.getAttribute('data-stage'))).toEqual(['early_warning', 'notification', 'final_report']);
        expect(screen.getByText('CVE-2026-1234')).toBeTruthy();
        expect(screen.getByText(/Actively exploited/)).toBeTruthy();
        expect(screen.getByText(/beeflow-server < 3\.4\.2/)).toBeTruthy();
    });

    it('reports the early warning first, with the channel and the reference — never the vulnerability details', () => {
        const { onCraReport } = drawer({ incident: VULN });
        expect(screen.queryByTestId('inc-drawer-cra-full')).toBeNull();
        fireEvent.change(screen.getByTestId('inc-drawer-cra-via'), { target: { value: 'ENISA platform' } });
        fireEvent.change(screen.getByTestId('inc-drawer-cra-ref'), { target: { value: 'EW-77' } });
        fireEvent.click(screen.getByTestId('inc-drawer-cra-early'));
        expect(onCraReport).toHaveBeenCalledWith(9, { stage: 'early_warning', reported_via: 'ENISA platform', reference: 'EW-77' });
        expect(screen.getByTestId('inc-drawer-cra').textContent).toMatch(/never the vulnerability details/i);
    });

    it('moves on to "Report full" once the early warning is stamped, and then to the final report', () => {
        const sent = { ...VULN, status: 'early_warning_sent', early_warning_sent_at: iso(-H) };
        const { onCraReport } = drawer({ incident: sent });
        expect(screen.queryByTestId('inc-drawer-cra-early')).toBeNull();
        fireEvent.click(screen.getByTestId('inc-drawer-cra-full'));
        expect(onCraReport).toHaveBeenCalledWith(9, { stage: 'notification', reported_via: undefined, reference: undefined });
        cleanup();

        const reported = { ...sent, notification_sent_at: iso(-0.5 * H) };
        const second = drawer({ incident: reported });
        fireEvent.click(screen.getByTestId('inc-drawer-cra-full'));
        expect(second.onCraReport).toHaveBeenCalledWith(9, expect.objectContaining({ stage: 'final_report' }));
    });

    it('records the customer notice through its own route, and drops the button once it is stamped', () => {
        const { onCustomerNotified } = drawer({ incident: VULN });
        fireEvent.click(screen.getByTestId('inc-drawer-cra-customers'));
        expect(onCustomerNotified).toHaveBeenCalledWith(9);
        cleanup();

        drawer({ incident: { ...VULN, customer_notified_at: iso(-H) } });
        expect(screen.queryByTestId('inc-drawer-cra-customers')).toBeNull();
    });

    it('degrades on a server without the CRA routes: the buttons stay, disabled, with a sentence saying why', () => {
        drawer({ incident: VULN, craUnavailable: true });
        expect(screen.getByTestId('inc-drawer-cra-early').disabled).toBe(true);
        expect(screen.getByTestId('inc-drawer-cra-customers').disabled).toBe(true);
        expect(screen.getByTestId('inc-drawer-cra-unavailable').textContent).toMatch(/not available on this server yet/i);
    });

    it('keeps the GDPR-only fields out of a vulnerability: no high-risk switch, CRA stamps instead of Art. 33/34', () => {
        drawer({ incident: VULN });
        expect(screen.queryByTestId('inc-drawer-high-risk')).toBeNull();
        const stamps = screen.getByTestId('inc-drawer-stamps').textContent;
        expect(stamps).toMatch(/Early warning/);
        expect(stamps).toMatch(/Customers notified/);
        expect(stamps).not.toMatch(/Art\. 34/);
    });

    it('while a mutation runs every action is held', () => {
        drawer({ incident: VULN, busy: true });
        expect(screen.getByTestId('inc-drawer-cra-early').disabled).toBe(true);
        expect(screen.getByTestId('inc-drawer-close-incident').disabled).toBe(true);
    });
});

describe('IncidentDrawer — the bodies it builds', () => {
    it('savePatch is an allow-list: trimmed title, null-able description, high_risk only for a breach', () => {
        expect(savePatch({ title: '  Lost laptop  ', description: '  ', severity: 'high', high_risk: true }, false))
            .toEqual({ title: 'Lost laptop', description: null, severity: 'high', high_risk: true });
        expect(savePatch({ title: 'Heap overflow', description: 'x', severity: 'critical', high_risk: true }, true))
            .toEqual({ title: 'Heap overflow', description: 'x', severity: 'critical' });
        expect(savePatch({ title: '   ', description: '', severity: 'low' }, true).title).toBeUndefined();
    });

    it('craBody carries the stage, the channel and the reference — and drops what was left blank', () => {
        expect(craBody('final_report', { reported_via: ' CSIRT ', reference: '' }))
            .toEqual({ stage: 'final_report', reported_via: 'CSIRT', reference: undefined });
        expect(craBody('early_warning', undefined)).toEqual({ stage: 'early_warning', reported_via: undefined, reference: undefined });
    });
});
