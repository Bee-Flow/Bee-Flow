/**
 * A value that is one field read out of another step's JSON text — the web
 * value builder's DataPart for a JSON pick (agent-hub
 * `Builder/mapping/ValueBuilder.jsx`): the pill, "· from the JSON: customer.name",
 * and a way to take it out. Edit data's "Pick fields from it" writes these; they
 * used to open as `parseJson(steps.act_4d4307a.output.body, "customer.name")`.
 *
 * There is nothing to type around a JSON pick (the web's `jsonOnly`), so this
 * row stands in for the text field; the Formula switch still edits it by hand.
 */

import React from 'react';
import { Text as RNText, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { StepLabelMap } from '@/features/flow-editor/bindings';
import { Icon, IconButton } from '@/shared/ui';

import { chipsIn, type JsonPick } from './bindingText';
import { pillStyle, type StepTypeMap } from './PillTextInput';

export function JsonPickRow({
    pick,
    labels,
    types,
    onRemove,
    testID,
}: {
    pick: JsonPick;
    labels: StepLabelMap;
    types: StepTypeMap;
    onRemove?: () => void;
    testID?: string;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const chip = chipsIn(pick.path, true, labels)[0];
    const name = chip ? (chip.suffix ? `${chip.name} ▸ ${chip.suffix}` : chip.name) : pick.path;
    const from = `${t('routines.builder.from_the_json', '· from the JSON')}${pick.jsonPath ? `: ${pick.jsonPath}` : ''}`;
    return (
        <View style={styles.row} testID={testID}>
            <RNText style={[styles.pill, chip ? pillStyle(theme, chip, types) : null]} numberOfLines={2}>
                {name} <RNText style={styles.from}>{from}</RNText>
            </RNText>
            {onRemove ? (
                <IconButton
                    icon={<Icon name="X" size={16} />}
                    tone="danger"
                    accessibilityLabel={t('routines.builder.remove_value', 'Remove this value')}
                    onPress={onRemove}
                    testID={testID ? `${testID}-remove` : undefined}
                />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    pill: {
        ...theme.type.body,
        flexShrink: 1,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
        borderRadius: theme.radii.sm,
        overflow: 'hidden',
    } satisfies TextStyle,
    from: { opacity: 0.7 } satisfies TextStyle,
});
