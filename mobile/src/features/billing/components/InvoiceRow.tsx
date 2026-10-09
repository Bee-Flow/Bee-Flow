/**
 * One invoice (InvoicesPanel.jsx row): when, its number, the amount paid (or
 * due), the status chip, and — when Stripe has a PDF — the PDF, fetched on the
 * app's session and handed to the share sheet ("Open with…", save, send).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';
import { Badge, Button, ListRow } from '@/shared/ui';

import { formatInvoiceAmount, invoiceAmount, invoiceStatus } from '../model/invoices';
import type { Invoice } from '../model/types';

const styles = StyleSheet.create({ trailing: { alignItems: 'flex-end', gap: 6 } });

export function InvoiceRow({
    invoice,
    sharing,
    onShare,
}: {
    invoice: Invoice;
    sharing: boolean;
    onShare: (invoice: Invoice) => void;
}) {
    const t = useTranslation();
    const status = invoiceStatus(invoice.status, t);
    return (
        <ListRow
            testID={`invoice-${invoice.id}`}
            title={invoice.number || invoice.id}
            subtitle={invoice.created ? absoluteDate(invoice.created) : '—'}
            meta={formatInvoiceAmount(invoiceAmount(invoice), invoice.currency)}
            trailing={
                <View style={styles.trailing}>
                    <Badge label={status.label} tone={status.tone} />
                    {invoice.invoicePdf ? (
                        <Button
                            testID={`invoice-${invoice.id}-pdf`}
                            label={t('automations.document_fields.pdf', 'PDF')}
                            variant="ghost"
                            size="sm"
                            iconName="Download"
                            loading={sharing}
                            onPress={() => onShare(invoice)}
                        />
                    ) : null}
                </View>
            }
        />
    );
}
