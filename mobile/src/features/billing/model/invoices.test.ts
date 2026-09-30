import { _reset, setCatalogue } from '@/core/i18n';

import { formatInvoiceAmount, invoiceAmount, invoiceStatus } from './invoices';
import { previewRows } from './preview';
import { plan } from './testing';

const t = (_key: string, fallback: string) => fallback;

describe('invoice rows', () => {
    it('names and colours the four Stripe statuses, and shows another as itself', () => {
        expect(invoiceStatus('paid', t)).toEqual({ label: 'Paid', tone: 'success' });
        expect(invoiceStatus('open', t)).toEqual({ label: 'Open', tone: 'warning' });
        expect(invoiceStatus('uncollectible', t)).toEqual({ label: 'Uncollectible', tone: 'error' });
        expect(invoiceStatus('void', t)).toEqual({ label: 'Void', tone: 'neutral' });
        expect(invoiceStatus('draft', t)).toEqual({ label: 'draft', tone: 'neutral' });
    });

    it('shows what was paid, else what is due, in the invoice’s currency', () => {
        const base = { id: 'in_1', number: null, created: null, currency: 'EUR', status: 'paid', invoicePdf: null };
        expect(invoiceAmount({ ...base, amountPaid: 0, amountDue: 30 })).toBe(0);
        expect(invoiceAmount({ ...base, amountPaid: null, amountDue: 30 })).toBe(30);
        expect(formatInvoiceAmount(null, 'EUR')).toBe('—');
        expect(formatInvoiceAmount(12.5, 'EUR')).toBe('€12.50');
        expect(formatInvoiceAmount(1, 'NOT-A-CURRENCY')).toBe('NOT-A-CURRENCY 1');
    });

    it('writes money as the app’s language does, not as a hard-coded nl-NL', () => {
        setCatalogue('nl', {});
        try {
            expect(formatInvoiceAmount(1234.5, 'EUR')).toMatch(/^€\s?1\.234,50$/);
            expect(formatInvoiceAmount(1, 'NOT-A-CURRENCY')).toBe('NOT-A-CURRENCY 1');
        } finally {
            _reset();
        }
    });
});

describe('the plan-change confirmation', () => {
    const quote = {
        currency: 'EUR',
        planName: 'Pro',
        perSeat: true,
        seatQuantity: 4,
        nextRenewalTotal: 196,
        prorationAmount: 12.34,
        effective: 'now',
    };

    it('charges an upgrade today, prorated, and counts its seats', () => {
        expect(previewRows({ ...quote, direction: 'upgrade' }, plan(), t)).toEqual([
            { label: 'Prorated charge today', value: '€12.34' },
            { label: 'Then', value: '€196.00 / month', strong: true },
            { label: '4 seats', value: 'billed per seat' },
        ]);
    });

    it('charges a downgrade nothing and says when it lands', () => {
        const rows = previewRows({ ...quote, direction: 'downgrade', effective: null }, plan({ billingInterval: 'yearly' }), t);
        expect(rows).toEqual([
            { label: 'Takes effect', value: 'the end of this period' },
            { label: 'Charge today', value: '€0.00' },
            { label: 'Then', value: '€196.00 / year', strong: true },
        ]);
    });
});
