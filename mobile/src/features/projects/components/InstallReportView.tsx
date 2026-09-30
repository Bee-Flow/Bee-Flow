/**
 * What an install did: how much arrived, what did not and why, and the
 * installer's own warnings — every sentence the server wrote, none rounded
 * off, because "installed" over a half-installed Solution sends someone to
 * use something that is not there.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { Strip } from './Strip';
import type { InstallReport } from '../model/package';
import { byCount } from '../model/words';

export function InstallReportView({ report }: { report: InstallReport }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const p = { count: report.installed };
    return (
        <View style={styles.stack} testID="install-report">
            <Text variant="body" weight="semibold">
                {t('solutions.install_installed', 'Installed.')}
            </Text>
            <Text variant="body" tone="secondary">
                {byCount(
                    report.installed,
                    t('mobile.projects.install_count', '{count} thing arrived, as a draft.', p),
                    t('mobile.projects.install_count_plural', '{count} things arrived, as drafts.', p),
                )}
            </Text>
            {report.skipped.length > 0 ? (
                <View style={styles.group}>
                    <Text variant="label" tone="secondary">
                        {t('projects.blueprint_skipped', 'Not installed')}
                    </Text>
                    {report.skipped.map((s, i) => (
                        <Strip key={`${s.ref}-${i}`} tone="warning">
                            {s.why || s.ref}
                        </Strip>
                    ))}
                </View>
            ) : null}
            {report.warnings.map((w, i) => (
                <Strip key={`w-${i}`} tone="muted">
                    {w}
                </Strip>
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    stack: { gap: theme.spacing.md } satisfies ViewStyle,
    group: { gap: theme.spacing.sm } satisfies ViewStyle,
});
