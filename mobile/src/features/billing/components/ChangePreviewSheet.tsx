/**
 * The plan-change confirmation (OrgLicenseSection.jsx change-plan modal): what
 * the change costs, from the server's preview (model/preview.ts), confirmed or
 * cancelled. It cannot be dismissed while the change is being made.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Button, InfoRow, Sheet } from '@/shared/ui';

import { previewRows } from '../model/preview';
import type { Plan, PlanChangePreview } from '../model/types';

const styles = StyleSheet.create({ actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 } });

export function ChangePreviewSheet({
    target,
    preview,
    busy,
    onConfirm,
    onClose,
}: {
    target: Plan | null;
    preview: PlanChangePreview | null;
    busy: boolean;
    onConfirm: () => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const heading =
        preview?.direction === 'downgrade'
            ? t('org.confirm_downgrade', 'Confirm downgrade')
            : t('org.confirm_upgrade', 'Confirm upgrade');
    const rows = target && preview ? previewRows(preview, target, t) : [];
    return (
        <Sheet
            visible={rows.length > 0}
            onClose={() => (busy ? undefined : onClose())}
            title={`${heading} — ${target?.name ?? ''}`}
            footer={
                <View style={styles.actions}>
                    <Button label={t('org.cancel', 'Cancel')} variant="secondary" disabled={busy} onPress={onClose} />
                    <Button testID="billing-confirm-change" label={t('org.confirm', 'Confirm')} loading={busy} onPress={onConfirm} />
                </View>
            }
        >
            {rows.map((row) => (
                <InfoRow key={row.label} label={row.label} value={row.value} tone={row.strong ? 'primary' : undefined} />
            ))}
        </Sheet>
    );
}
