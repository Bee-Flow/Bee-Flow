import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
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
    it('heads the drawer with INC-{id}, the severity in incident words and the status; ONE Reporting list', () => {
        drawer({ incident: { ...BREACH, severity: 'medium' } });
        const header = screen.getByTestId('inc-drawer-header');
        expect(header.textContent).toMatch(/INC-4/);
        expect(header.textContent).toMatch(/Lost laptop/);
        expect(header.textContent).toMatch(/Open/);
        expect(screen.getByTestId('inc-drawer-severity')).toHaveTextContent('Medium');
        expect(header.textContent).not.toMatch(/Consider/i);
        expect(screen.queryByTestId('inc-drawer-clocks')).toBeNull();
        expect(screen.queryByTestId('inc-drawer-stamps')).toBeNull();
        const reporting = screen.getByTestId('inc-drawer-reporting');
        const stages = within(reporting).getAllByRole('listitem');
        expect(stages.map(li => li.getAttribute('data-stage'))).toEqual(['recipients', 'notification', 'subjects']);
        expect(stages[1].getAttribute('data-filed')).toBe('false');
        expect(stages[1].textContent).toMatch(/Authority notification \(72 h\)due \d+ \w+ \d{2}:\d{2}/);
    });

    it('the next filing step is the primary, directly under the clock; the assessment and the e-mail are secondary', async () => {
        const user = userEvent.setup();
        const { onUpdate, onNotify } = drawer();
        const next = screen.getByTestId('inc-drawer-next');
        expect(within(next).getByTestId('inc-drawer-authority')).toHaveTextContent('Record authority notification');
        expect(within(next).getByTestId('inc-drawer-authority').className).toContain('bg-[var(--accent-primary)]');
        expect(next.textContent).toMatch(/attestation/i);
        // the clock comes first, then the next step
        expect(screen.getByTestId('inc-drawer-clock').compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        await user.click(screen.getByTestId('inc-drawer-assess'));
        expect(onUpdate).toHaveBeenCalledWith(4, { status: 'assessing' });
        await user.click(screen.getByTestId('inc-drawer-notify'));
        expect(onNotify).toHaveBeenCalledWith(4);
    });

    it('Close incident is last, in the footer, and asks why the authority was not notified (Art. 33(5)), sent as the note', async () => {
        const user = userEvent.setup();
        const { onUpdate } = drawer();
        const footer = screen.getByTestId('inc-drawer-footer');
        const toggle = within(footer).getByTestId('inc-drawer-close-incident');
        await user.click(toggle);
        expect(onUpdate).not.toHaveBeenCalled();
        const confirm = screen.getByTestId('inc-drawer-close-confirm');
        expect(confirm).toBeDisabled();
        await user.type(screen.getByLabelText('Why was the authority not notified? (Art. 33(5))'), 'Encrypted device, no risk to the people involved');
        await user.click(confirm);
        expect(onUpdate).toHaveBeenCalledWith(4, { status: 'closed', note: 'Encrypted device, no risk to the people involved' });
    });

    it('once every stage is filed, Close incident closes straight away with the standard note', async () => {
        const user = userEvent.setup();
        const { onUpdate } = drawer({ incident: { ...BREACH, status: 'authority_notified', authority_notified_at: iso(-H), subjects_notified_at: iso(-H) } });
        await user.click(screen.getByTestId('inc-drawer-close-incident'));
        expect(onUpdate).toHaveBeenCalledWith(4, { status: 'closed', note: 'Closed after assessment.' });
    });

});

describe('IncidentDrawer — the GDPR breach row: filing, closing, editing', () => {
    it('records the authority notification with the reference the user typed, and nothing else', () => {
        const { onUpdate } = drawer();
        fireEvent.change(screen.getByTestId('inc-drawer-authority-ref'), { target: { value: '  AP-2026-118  ' } });
        fireEvent.click(screen.getByTestId('inc-drawer-authority'));
        expect(onUpdate).toHaveBeenCalledWith(4, { status: 'authority_notified', authority_reference: 'AP-2026-118' });
    });

    it('offers the Art. 34 action only for a high-risk breach, and hides a stamp that is already set', () => {
        drawer();
        expect(within(screen.getByTestId('inc-drawer-actions')).getByTestId('inc-drawer-subjects')).toBeTruthy();
        cleanup();

        drawer({ incident: { ...BREACH, high_risk: false, recipients_notified_at: iso(-8 * H) } });
        expect(screen.queryByTestId('inc-drawer-subjects')).toBeNull();
        expect(screen.queryByTestId('inc-drawer-notify')).toBeNull();
    });

    it('a closed incident has no actions left — only its record', () => {
        drawer({ incident: { ...BREACH, status: 'closed', closed_at: iso(-H), authority_notified_at: iso(-30 * H), authority_reference: 'AP-1' } });
        expect(screen.queryByTestId('inc-drawer-actions')).toBeNull();
        expect(screen.queryByTestId('inc-drawer-next')).toBeNull();
        expect(screen.queryByTestId('inc-drawer-close-incident')).toBeNull();
        const authority = within(screen.getByTestId('inc-drawer-reporting')).getAllByRole('listitem').find(li => li.dataset.stage === 'notification');
        expect(authority.textContent).toMatch(/filed .* · ref AP-1/);
        expect(authority.lastElementChild.className).toContain('text-[var(--success-ink)]');
    });

    it('a closed, deliberately unnotified breach reads "not filed (decision logged)" and "closed · not notified", never overdue', () => {
        drawer({ incident: { ...BREACH, status: 'closed', deadline_at: iso(-200 * H), detected_at: iso(-272 * H) } });
        expect(screen.getByTestId('inc-drawer-clock')).toHaveTextContent('closed · not notified');
        expect(screen.getByTestId('inc-drawer-clock')).not.toHaveTextContent(/overdue/);
        const authority = within(screen.getByTestId('inc-drawer-reporting')).getAllByRole('listitem').find(li => li.dataset.stage === 'notification');
        expect(authority).toHaveAttribute('data-not-filed', 'true');
        expect(authority.textContent).toMatch(/not filed \(decision logged\)/);
    });

    it('Save appears only after an editable field changes, inside the footer, and sends an allow-listed patch', () => {
        const { onUpdate } = drawer();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        fireEvent.change(screen.getByTestId('inc-drawer-title'), { target: { value: 'Lost laptop (encrypted after all)' } });
        const save = within(screen.getByTestId('inc-drawer-foot')).getByRole('button', { name: 'Save' });
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
        expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    });

    it('a DORA customer notice that runs first is the primary; the authority notification stays one click away', async () => {
        const user = userEvent.setup();
        const dora = { ...BREACH, kind: 'security_incident', high_risk: false, customer_notice_due_at: iso(2 * H) };
        const { onCustomerNotified, onUpdate } = drawer({ incident: dora });
        await user.click(within(screen.getByTestId('inc-drawer-next')).getByTestId('inc-drawer-cra-customers'));
        expect(onCustomerNotified).toHaveBeenCalledWith(4);
        await user.click(screen.getByTestId('inc-drawer-authority-open'));
        expect(screen.getByTestId('inc-drawer-authority-ref')).toHaveFocus();
        await user.type(screen.getByTestId('inc-drawer-authority-ref'), 'AP-9');
        await user.click(screen.getByTestId('inc-drawer-authority'));
        expect(onUpdate).toHaveBeenCalledWith(4, { status: 'authority_notified', authority_reference: 'AP-9' });
    });

    it('shows the log the server kept', () => {
        drawer();
        expect(screen.getByText(/Device remote-wiped/)).toBeTruthy();
    });
});

describe('IncidentDrawer — the CRA vulnerability row', () => {
    it('lists the 24 h · 72 h · 14 d stages (and the customer notice) and the CVE / exploited / affected block', () => {
        drawer({ incident: VULN });
        expect(screen.getByTestId('inc-drawer-header').textContent).toMatch(/VULN-9/);
        const stages = within(screen.getByTestId('inc-drawer-reporting')).getAllByRole('listitem');
        expect(stages.map(li => li.getAttribute('data-stage'))).toEqual(['early_warning', 'notification', 'final_report', 'customers']);
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
        expect(screen.getByTestId('inc-drawer-next').textContent).toMatch(/never the vulnerability details/i);
    });

    it('moves on to "Report full" once the early warning is stamped — posted as the route\'s `full` stage', () => {
        const sent = { ...VULN, status: 'early_warning_sent', early_warning_sent_at: iso(-H) };
        const { onCraReport } = drawer({ incident: sent });
        expect(screen.queryByTestId('inc-drawer-cra-early')).toBeNull();
        fireEvent.click(screen.getByTestId('inc-drawer-cra-full'));
        expect(onCraReport).toHaveBeenCalledWith(9, { stage: 'full', reported_via: undefined, reference: undefined });
        cleanup();

        const reported = { ...sent, notification_sent_at: iso(-0.5 * H) };
        const second = drawer({ incident: reported });
        expect(screen.getByTestId('inc-drawer-cra-full')).toHaveTextContent('Report final report');
        fireEvent.click(screen.getByTestId('inc-drawer-cra-full'));
        expect(second.onCraReport).toHaveBeenCalledWith(9, expect.objectContaining({ stage: 'full' }));
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

    it('keeps the GDPR-only fields out of a vulnerability: no high-risk switch, CRA stages instead of Art. 33/34', () => {
        drawer({ incident: VULN });
        expect(screen.queryByTestId('inc-drawer-high-risk')).toBeNull();
        const stamps = screen.getByTestId('inc-drawer-reporting').textContent;
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
            .toEqual({ stage: 'full', reported_via: 'CSIRT', reference: undefined });
        expect(craBody('notification', {}).stage).toBe('full');
        expect(craBody('early_warning', undefined)).toEqual({ stage: 'early_warning', reported_via: undefined, reference: undefined });
    });
});
