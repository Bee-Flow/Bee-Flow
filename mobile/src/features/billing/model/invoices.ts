/**
 * An invoice row's words, as components/billing/InvoicesPanel.jsx writes
 * them: its status chip and the amount in the invoice's own currency.
 */

import { formatNumber, type TranslateFn } from '@/core/i18n';
import type { Tone } from '@/shared/ui';

import type { Invoice } from './types';

/** InvoicesPanel.jsx STATUS_TONE: the colour per Stripe status. */
const STATUS_TONE: Readonly<Record<string, Tone>> = {
    paid: 'success',
    open: 'warning',
    uncollectible: 'error',
    void: 'neutral',
};

export const INVOICE_STATUSES = Object.keys(STATUS_TONE);

function statusLabel(status: string, t: TranslateFn): string {
    if (status === 'paid') return t('billing.status_paid', 'Paid');
    if (status === 'open') return t('billing.status_open', 'Open');
    if (status === 'uncollectible') return t('billing.status_uncollectible', 'Uncollectible');
    if (status === 'void') return t('billing.status_void', 'Void');
    return status;
}

/** The chip; a status the web does not know shows as itself, uncoloured. */
export function invoiceStatus(status: string, t: TranslateFn): { label: string; tone: Tone } {
    return { label: statusLabel(status, t), tone: STATUS_TONE[status] ?? 'neutral' };
}

/** What was paid, else what is due. */
export function invoiceAmount(invoice: Invoice): number | null {
    return invoice.amountPaid ?? invoice.amountDue;
}

/**
 * formatAmount: the amount in the invoice's own currency, written as the
 * app's language writes money ("€ 12,50" in Dutch, "€12.50" in English) —
 * the web pins nl-NL, which printed Dutch money inside an English app.
 * An unknown currency falls back to "EUR 12.5".
 */
export function formatInvoiceAmount(amount: number | null, currency: string): string {
    if (amount === null) return '—';
    try {
        return formatNumber(amount, { style: 'currency', currency: currency || 'EUR' });
    } catch {
        return `${currency || 'EUR'} ${amount}`;
    }
}
