/**
 * "Hide from AI": the 21 kinds of personal data the shield looks for, as a
 * sheet behind one row, with All and None. Edits go straight into the
 * screen's draft — the Save bar saves them with everything else.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Sheet, Text } from '@/shared/ui';

import { CategoryToggles } from './CategoryToggles';
import { toggleId } from '../model/fields';
import { PII_CATALOG } from '../model/piiCatalog';

export function DetectionSheet({
    visible,
    selected,
    onChange,
    onClose,
}: {
    visible: boolean;
    selected: readonly string[];
    onChange: (ids: string[]) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const count = t('admin.shield_posture_categories_value', '{n} of {total}', { n: selected.length, total: PII_CATALOG.length });
    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('admin.shield_matrix_col_detect', 'Hide from AI')}
            subtitle={t('mobile.orgShield.detect_footer', 'A kind that is not ticked here is never asked of the model, so it can never be found.')}
            tall
            footer={<Button label={t('common.close', 'Close')} onPress={onClose} fullWidth />}
        >
            <View style={styles.bulk}>
                <Text variant="caption" tone="tertiary" style={styles.bulkText}>{count}</Text>
                <Button label={t('common.all', 'All')} size="sm" variant="ghost" onPress={() => onChange(PII_CATALOG.map((c) => c.id))} testID="detect-all" />
                <Button label={t('common.none', 'None')} size="sm" variant="ghost" onPress={() => onChange([])} testID="detect-none" />
            </View>
            <CategoryToggles selected={selected} onToggle={(id, on) => onChange(toggleId(selected, id, on))} testPrefix="detect" />
        </Sheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bulk: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.sm },
        bulkText: { flex: 1 },
    });
