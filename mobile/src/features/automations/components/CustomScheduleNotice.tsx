/**
 * A schedule the quick picker cannot represent: shown, explained, and left
 * alone until the person explicitly asks to replace it — or edits the
 * pattern itself on the trigger, in the flow editor.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text } from '@/shared/ui';

import { describeCron } from '../model/cron';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { gap: theme.spacing.lg },
        code: { padding: theme.spacing.md, borderRadius: theme.radii.md, backgroundColor: theme.colors.bgTertiary },
    });

export function CustomScheduleNotice({ cron, tz, onReplace }: { cron: string; tz: string; onReplace: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.root}>
            <Banner tone="info" icon="Clock">
                {t(
                    'mobile.automations.custom_schedule',
                    'This automation runs on a custom pattern this picker cannot show. To change the pattern itself, open the trigger in the flow editor.',
                )}
            </Banner>
            <View style={styles.code}>
                <Text variant="code" selectable>
                    {cron}
                </Text>
            </View>
            <Text variant="caption" tone="tertiary">
                {describeCron(cron, tz)}
            </Text>
            <Button
                label={t('mobile.automations.replace_schedule', 'Replace with a simple schedule')}
                variant="secondary"
                onPress={onReplace}
                accessibilityHint={t('mobile.automations.replace_schedule_hint', 'Discards the custom pattern and picks a daily, weekly or monthly time instead')}
            />
        </View>
    );
}
