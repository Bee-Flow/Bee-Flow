/**
 * What the AI wrote, before anything is created: its title and blurb, the
 * phases in order, the table's columns — and, when the columns were read off
 * the briefs because the model declared none, a warning saying so.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import type { Recipe } from '../model/types';

export function RecipePreview({ recipe, warnings }: { recipe: Recipe; warnings: readonly string[] }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const fields = recipe.fields ?? [];
    const synthesized = warnings.includes('table_synthesized') || recipe.warnings.includes('table_synthesized');
    return (
        <View style={styles.box} testID="playbook-recipe-preview">
            <View style={styles.head}>
                <Icon name="Sparkles" size={14} color={theme.colors.typeAi} />
                <Text variant="caption" weight="semibold" style={styles.grow}>
                    {recipe.title}
                </Text>
            </View>
            {recipe.description ? (
                <Text variant="caption" tone="secondary">
                    {recipe.description}
                </Text>
            ) : null}
            <Text variant="caption" tone="secondary">
                {recipe.phases.map((p) => p.label || p.key).join(' → ')}
            </Text>
            {fields.length > 0 ? (
                <Text variant="caption" tone="secondary">
                    {t('playbooks.new.preview_columns', 'Columns: {list}', { list: fields.map((f) => `${f.name || f.key} (${f.type})`).join(', ') })}
                </Text>
            ) : null}
            {fields.length > 0 && synthesized ? (
                <Text variant="caption" tone="warning" testID="playbook-columns-synthesized">
                    {t('playbooks.new.preview_columns_synthesized', 'The AI did not declare these columns — they were read from the placeholders in its briefs. Check them before you start.')}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: {
        gap: theme.spacing[1.5],
        padding: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgPrimary,
    },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[1.5] },
    grow: { flex: 1 },
});
