import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeadlinesCardJs, { URGENT_BELOW_MS } from './DeadlinesCard';

/**
 * The Overview's clocks: what is pressing first, one reference style, one line
 * per empty register. Pinned against the four things the card used to get
 * wrong: "Art. GDPR Art. 12(3)", clocks a year out beside a 72-hour one, three
 * identical "no open vulnerability" rows, and a subject kind printed as if it
 * were an identifier ("training · Annual refresher").
 */
vi.mock('../../../../../hooks/useTranslation', () => {
    const t = (key: string, fallback?: unknown, vars?: Record<string, unknown>) => {
        let s = typeof fallback === 'string' ? fallback : key;
        for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(String(v));
        return s;
    };
    const hook = () => ({ t, locale: 'en', resolvedLocale: 'en' });
    return { useTranslation: hook, default: hook };
});

interface DeadlineItem {
    id: string; kind: string; ref?: string; title?: string; meta?: { article?: string | null };
    started_at?: string | null; due_at?: string | null; state?: string; pct?: number; target?: unknown;
}

// DeadlinesCard is plain JavaScript; these are the props it takes.
const DeadlinesCard = DeadlinesCardJs as unknown as React.ComponentType<{
    items?: DeadlineItem[] | null; emptyKinds?: string[]; failed?: boolean;
    navigate?: (section: string, id?: string, tab?: string) => void; testId?: string;
}>;

const NOW = new Date('2026-10-07T12:00:00Z').getTime();
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

/** The demo's nine clocks, most urgent first, as GET /deadlines sends them. */
const ITEMS: DeadlineItem[] = [
    { id: 'attestation_expiry:automation:a1', kind: 'attestation_expiry', ref: 'Automation', title: 'Polisvoorwaarden-brief',
        meta: { article: null }, due_at: at(-31), state: 'overdue', target: '/app/admin/compliance/frameworks?tab=per_automation' },
    { id: 'obligation:o1', kind: 'obligation', ref: 'training', title: 'Annual security awareness refresher',
        meta: { article: 'ISO 27001 cl. 9' }, due_at: at(-27), state: 'overdue', target: '/app/admin/compliance/training' },
    { id: 'obligation:o2', kind: 'obligation', ref: 'exercise', title: 'Phishing simulation',
        meta: { article: 'ISO 27001 cl. 9' }, due_at: at(-5), state: 'overdue', target: '/app/admin/compliance/training' },
    { id: 'dsr:dsr_2417', kind: 'dsr', ref: '#dsr_2417', title: 'Access request',
        meta: { article: 'GDPR Art. 12(3)' }, started_at: at(-27), due_at: at(3), state: 'urgent', target: '/app/admin/compliance/dsr/dsr_2417' },
    { id: 'incident:inc_31', kind: 'incident', ref: 'INC-inc_31', title: 'Claim summary emailed to the wrong customer',
        meta: { article: 'GDPR Art. 33' }, started_at: at(-1), due_at: at(2.2), state: 'ok', target: '/app/admin/compliance/incidents/inc_31' },
    { id: 'incident:inc_32', kind: 'incident', ref: 'INC-inc_32', title: 'Policy-system connector misconfigured',
        meta: { article: 'GDPR Art. 33' }, started_at: at(-0.2), due_at: at(2.9), state: 'ok', target: '/app/admin/compliance/incidents/inc_32' },
    { id: 'dsr:dsr_2416', kind: 'dsr', ref: '#dsr_2416', title: 'Deletion request',
        meta: { article: 'GDPR Art. 12(3)' }, started_at: at(-9), due_at: at(21), state: 'ok', target: '/app/admin/compliance/dsr/dsr_2416' },
    { id: 'attestation_expiry:agent:g1', kind: 'attestation_expiry', ref: 'Agent', title: 'Klantenservice-assistent',
        meta: { article: null }, due_at: at(313), state: 'ok', target: '/app/admin/compliance/frameworks?tab=per_automation' },
    { id: 'attestation_expiry:agent:g2', kind: 'attestation_expiry', ref: 'Agent', title: 'Schadebeoordeling',
        meta: { article: null }, due_at: at(327), state: 'ok', target: '/app/admin/compliance/frameworks?tab=per_automation' },
];

function mount(props: Partial<React.ComponentProps<typeof DeadlinesCard>> = {}) {
    const navigate = vi.fn();
    render(<DeadlinesCard items={ITEMS} emptyKinds={[]} navigate={navigate} {...props} />);
    return { navigate, user: userEvent.setup() };
}

/** The row whose title contains `text`. */
const rowById = (text: string) => screen.getAllByTestId('deadlines-card-row').find((r) => r.textContent?.includes(text));

describe('DeadlinesCard — the pressing clocks first', () => {
    beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows overdue, urgent and due-within-30-days clocks (at most six) and folds the rest behind one toggle', async () => {
        const { user } = mount();
        expect(screen.getAllByTestId('deadlines-card-row')).toHaveLength(6);
        // The two self-assessments that expire in ten months are not on the first screen.
        expect(screen.queryByText('Klantenservice-assistent')).toBeNull();
        const toggle = screen.getByTestId('deadlines-card-toggle');
        expect(toggle).toHaveTextContent('Show 3 later');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');

        await user.click(toggle);
        expect(screen.getAllByTestId('deadlines-card-row')).toHaveLength(9);
        expect(screen.getByText('Klantenservice-assistent')).toBeInTheDocument();
        expect(toggle).toHaveTextContent('Show fewer');
        expect(toggle).toHaveAttribute('aria-expanded', 'true');

        await user.click(toggle);
        expect(screen.getAllByTestId('deadlines-card-row')).toHaveLength(6);
    });

    it('has no toggle when every clock is pressing', () => {
        mount({ items: ITEMS.slice(0, 4) });
        expect(screen.getAllByTestId('deadlines-card-row')).toHaveLength(4);
        expect(screen.queryByTestId('deadlines-card-toggle')).toBeNull();
    });

    it('says so when nothing is due soon, and keeps the far clocks one click away', () => {
        mount({ items: ITEMS.slice(7) });
        expect(screen.queryAllByTestId('deadlines-card-row')).toHaveLength(0);
        expect(screen.getByTestId('deadlines-card-none-soon')).toHaveTextContent('Nothing due in the next 30 days.');
        expect(screen.getByTestId('deadlines-card-toggle')).toHaveTextContent('Show 2 later');
    });

    it('a row opens its target', async () => {
        const { navigate, user } = mount();
        await user.click(within(rowById('Access request') as HTMLElement).getByRole('button'));
        expect(navigate).toHaveBeenCalledWith('dsr', 'dsr_2417', undefined);
    });

    it('says the hint in plain words', () => {
        mount();
        expect(screen.getByTestId('deadlines-card')).toHaveTextContent('Legal response deadlines, most urgent first');
    });
});

describe('DeadlinesCard — one reference style', () => {
    beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('prints the article as the server wrote it — never "Art. GDPR Art."', () => {
        mount();
        const card = screen.getByTestId('deadlines-card');
        expect(card.textContent).not.toMatch(/Art\.\s+(GDPR|AI Act|ISO|CRA)/);
        const dsr = rowById('Access request');
        expect(within(dsr as HTMLElement).getByTestId('deadlines-card-meta')).toHaveTextContent('Data-subject request · GDPR Art. 12(3)');
        expect(within(dsr as HTMLElement).getByTestId('deadlines-card-article').className).not.toContain('font-mono');
    });

    it('shows the ref only for requests and incidents, in the sans face', () => {
        mount();
        const dsr = rowById('Access request') as HTMLElement;
        const ref = within(dsr).getByTestId('deadlines-card-ref');
        expect(ref).toHaveTextContent('#dsr_2417');
        expect(ref.className).not.toContain('font-mono');
        expect(within(rowById('Claim summary') as HTMLElement).getByTestId('deadlines-card-ref')).toHaveTextContent('INC-inc_31');
    });

    it('an obligation or attestation drops the ref and names the subject kind in the meta', () => {
        mount();
        const obligation = rowById('Annual security awareness') as HTMLElement;
        expect(within(obligation).queryByTestId('deadlines-card-ref')).toBeNull();
        expect(within(obligation).getByTestId('deadlines-card-title')).toHaveTextContent(/^Annual security awareness refresher$/);
        expect(within(obligation).getByTestId('deadlines-card-meta')).toHaveTextContent('ISMS obligation · ISO 27001 cl. 9 · Training');
        const attestation = rowById('Polisvoorwaarden-brief') as HTMLElement;
        // No statutory clock behind an attestation's expiry: the server sends no article, and none prints.
        expect(within(attestation).getByTestId('deadlines-card-meta')).toHaveTextContent(/^Attestation expires · Automation$/);
        expect(within(attestation).queryByTestId('deadlines-card-article')).toBeNull();
    });

    it('prints a full citation across regimes as it comes', () => {
        const incident = { ...ITEMS[4], meta: { article: 'GDPR Art. 33 · NIS2 Art. 23(4)' } };
        mount({ items: [incident] });
        expect(screen.getByTestId('deadlines-card-meta')).toHaveTextContent(/^Incident notification · GDPR Art\. 33 · NIS2 Art\. 23\(4\)$/);
    });
});

describe('DeadlinesCard — the CRA clocks', () => {
    beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    const cra = (kind: string, article: string): DeadlineItem => ({
        id: `${kind}:inc_40`, kind, ref: 'INC-inc_40', title: 'Remote code execution in the export module',
        meta: { article }, started_at: at(-1), due_at: at(2), state: 'ok', target: '/app/admin/compliance/incidents/inc_40',
    });

    it('names the 72-hour notification and the final report, with their refs and articles', () => {
        mount({ items: [cra('cra_notification', 'CRA Art. 14(2)(b)'), cra('cra_full_report', 'CRA Art. 14(2)(c)')] });
        const [notification, report] = screen.getAllByTestId('deadlines-card-row');
        expect(within(notification).getByTestId('deadlines-card-ref')).toHaveTextContent('INC-inc_40');
        expect(within(notification).getByTestId('deadlines-card-meta')).toHaveTextContent('CRA notification (72 h) · CRA Art. 14(2)(b)');
        expect(within(report).getByTestId('deadlines-card-meta')).toHaveTextContent('CRA final report · CRA Art. 14(2)(c)');
    });

    it('the notification is urgent under 24 hours, as the server rules', () => {
        expect(URGENT_BELOW_MS.cra_notification).toBe(24 * 3_600_000);
    });
});

describe('DeadlinesCard — empty registers', () => {
    beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('collapses the CRA kinds into one line', () => {
        mount({ emptyKinds: ['cra_vulnerability', 'cra_early_warning', 'cra_notification', 'cra_full_report'] });
        const lines = screen.getAllByTestId('deadlines-card-empty');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toHaveTextContent('CRA: no open vulnerability');
    });

    it('keeps a line per other register', () => {
        mount({ items: [], emptyKinds: ['dsr', 'incident', 'cra_early_warning', 'cra_full_report'] });
        const lines = screen.getAllByTestId('deadlines-card-empty').map((l) => l.textContent);
        expect(lines).toEqual(['Data-subject requestno open request', 'Incident notificationno open incident', 'CRA: no open vulnerability']);
        expect(screen.queryByTestId('deadlines-card-none')).toBeNull();
    });
});
