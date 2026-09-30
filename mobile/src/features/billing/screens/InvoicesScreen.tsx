/**
 * Invoices (web: billing/InvoicesPanel.jsx under License & Usage): the
 * organisation's Stripe invoices, newest first as Stripe lists them, each with
 * its PDF. The PDF is fetched through the server's ownership-checked proxy on
 * the app's own session and shared from disk — the phone has no PDF viewer,
 * so "Open with…" stands in for the web's in-app preview.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { OrgLockedScreen } from '@/features/org';
import { QueryList } from '@/shared/patterns';
import { Screen, ScreenHeader, useToast } from '@/shared/ui';

import { InvoiceRow } from '../components/InvoiceRow';
import { useShareInvoice } from '../hooks/mutations';
import { useInvoices } from '../hooks/queries';
import { useBillingAccess } from '../hooks/useBillingAccess';
import type { Invoice } from '../model/types';

const keyOf = (invoice: Invoice) => invoice.id;

export function InvoicesScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const { allowed, denied } = useBillingAccess();
    const query = useInvoices(allowed);
    const share = useShareInvoice();
    const title = t('billing.invoices', 'Invoices');
    if (!allowed) return <OrgLockedScreen title={title} denied={denied} />;

    const onShare = (invoice: Invoice) =>
        share.mutate(invoice, { onError: (err) => toast(describeError(err).message, 'error') });

    return (
        <Screen edges={['top']}>
            <ScreenHeader title={title} subtitle={t('org.license_usage', 'License & Usage')} />
            <QueryList
                query={query}
                keyExtractor={keyOf}
                renderItem={({ item }) => (
                    <InvoiceRow
                        invoice={item}
                        sharing={share.isPending && share.variables?.id === item.id}
                        onShare={onShare}
                    />
                )}
                empty={{ icon: 'Receipt', title: t('billing.no_invoices', 'No invoices yet.') }}
            />
        </Screen>
    );
}
