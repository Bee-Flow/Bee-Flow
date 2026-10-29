/**
 * The `{{Name: description}}` placeholders mammoth found in the .docx. A
 * template's own fields — a short list, so chips in a wrapping row.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { Chip, Text } from '@/shared/ui';

import type { TemplateParameter } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        block: { gap: theme.spacing.sm },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    });

export function TemplatePlaceholders({ parameters }: { parameters: TemplateParameter[] }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.block}>
            <Text variant="label" tone="tertiary">
                {(parameters.length
                    ? nOf(t, 'mobile.templates.n_placeholders', parameters.length, ['{count} placeholder', '{count} placeholders'])
                    : t('mobile.templates.no_placeholders', 'No placeholders found')
                ).toUpperCase()}
            </Text>
            {parameters.length ? (
                <View style={styles.chips}>
                    {parameters.map((param) => (
                        <Chip key={param.name} label={param.name} />
                    ))}
                </View>
            ) : (
                <Text variant="caption" tone="tertiary">
                    {t(
                        'mobile.templates.no_placeholders_hint',
                        'Bee Flow could not find any {{placeholders}} in this document. You can still chat about it — it just has nothing to fill in.',
                    )}
                </Text>
            )}
        </View>
    );
}
