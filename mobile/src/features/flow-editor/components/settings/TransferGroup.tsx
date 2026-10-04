/**
 * The automation as a file: Export shares it (pinned samples, environment
 * references and app back-pointers are left out — the server names each in
 * a warning, shown here), Import makes a new draft automation from a file and
 * opens it; what it could not connect comes back as its warnings.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { SaveResult } from '@/features/flow-editor/api';
import { Banner, Group, Icon, SettingRow, useToast } from '@/shared/ui';

import { usePickImport, useShareExport } from './useTransfer';

const makeStyles = (theme: Theme) => ({
    warnings: { padding: theme.spacing.lg, gap: theme.spacing.sm } satisfies ViewStyle,
});

export function TransferGroup({ flowKey, title, onImported }: { flowKey: string; title: string; onImported: (automationId: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [warnings, setWarnings] = useState<string[]>([]);
    const exporter = useShareExport(flowKey, title);
    const importer = usePickImport((result: SaveResult) => {
        const id = result.automation?.id;
        if (!id) return;
        const n = result.warnings.length;
        toast(
            n ? t('mobile.flow.settings.imported_warnings', 'Imported — {n} things to check', { n }) : t('mobile.flow.settings.imported', 'Imported as a new draft'),
            'success',
        );
        onImported(id);
    });
    return (
        <Group title={t('mobile.flow.settings.transfer', 'Export and import')}>
            <SettingRow
                label={exporter.busy ? t('mobile.flow.settings.exporting', 'Exporting…') : t('common.export', 'Export')}
                value={t('mobile.flow.settings.export_value', 'JSON file')}
                icon={<Icon name="Share2" size={18} />}
                onPress={() => void exporter.share().then(setWarnings)}
                disabled={exporter.busy}
                testID="settings-export"
            />
            <SettingRow
                label={importer.busy ? t('mobile.flow.settings.importing', 'Importing…') : t('mobile.flow.settings.import', 'Import an automation')}
                value={t('mobile.flow.settings.import_value', 'New draft')}
                icon={<Icon name="Import" size={18} />}
                onPress={importer.pick}
                disabled={importer.busy}
                testID="settings-import"
            />
            {warnings.length ? (
                <View style={styles.warnings}>
                    {warnings.map((w) => (
                        <Banner key={w} tone="info">{w}</Banner>
                    ))}
                </View>
            ) : null}
        </Group>
    );
}
