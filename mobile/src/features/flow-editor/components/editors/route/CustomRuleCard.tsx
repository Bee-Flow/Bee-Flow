/**
 * What Simple mode shows instead of a formula box (R8; the web's
 * mapping/CustomRuleCard.tsx): a rule the clickable rows cannot show reads as
 * a card naming the FIELDS it reads — never its code — with a way back to
 * clicking. The formula itself is edited in Advanced only.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { scanExprPaths } from '@/features/flow-editor/bindings';
import { listPathLabel } from '@/features/flow-editor/bindings/listPathLabel';
import { useVariablePicker } from '@/features/flow-editor/components/variables';
import { Button, Text } from '@/shared/ui';

import { fieldNameOf } from './routeSourceEdits';

/** listPathLabel's own translate type: the app's `t` with looser params. */
type ListLabelT = Parameters<typeof listPathLabel>[2];

const READ_ROOTS = ['item', 'steps', 'trigger', 'loop'];

type Labels = Pick<Map<string, string>, 'get'> | null;

/** The distinct field names a formula reads, in reading order: "Subject, Attachments". */
export function formulaFieldNames(expr: string, stepLabelById: Labels, t: TranslateFn, stepTypeById: Labels = null): string[] {
    const names: string[] = [];
    for (const part of scanExprPaths(expr, READ_ROOTS)) {
        if (!('path' in part) || !part.path) continue;
        const onItem = part.path === 'item' || part.path.startsWith('item.') || part.path.startsWith('item[');
        const name = onItem ? (part.path === 'item' ? '' : fieldNameOf(part.path, t)) : listPathLabel(part.path, stepLabelById, t as ListLabelT, { stepTypeById });
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

export interface CustomRuleCardProps {
    expr: string;
    onRebuild: () => void;
}

export function CustomRuleCard({ expr, onRebuild }: CustomRuleCardProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const picker = useVariablePicker();
    const known = picker.stepLabelById;
    const fields = formulaFieldNames(expr, known instanceof Map ? known : null, t, picker.stepTypeById);
    return (
        <View style={styles.card} testID="custom-rule-card">
            <Text variant="caption" weight="medium">
                {t('condition_node.custom.title', 'Custom rule')}
            </Text>
            <Text variant="caption" tone="secondary">
                {t('condition_node.custom.body', 'This rule is written as a formula, so it can’t be shown as clickable rows here.')}
            </Text>
            {fields.length ? (
                <Text variant="caption" tone="secondary">
                    {t('condition_node.custom.reads', 'It reads: {fields}', { fields: fields.join(', ') })}
                </Text>
            ) : null}
            <Button size="sm" variant="ghost" label={t('condition_node.custom.rebuild', 'Build it again by clicking')} onPress={onRebuild} testID="custom-rule-rebuild" />
            <Text variant="caption" tone="tertiary">
                {t('condition_node.custom.advanced', 'To change the formula itself, switch to Advanced.')}
            </Text>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        gap: theme.spacing.xs,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
});
