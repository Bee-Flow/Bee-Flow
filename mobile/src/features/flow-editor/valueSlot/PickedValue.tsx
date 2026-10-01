/**
 * A field that holds one value picked from an earlier step: the chip with
 * its name and an example (ValueChip), the one sentence under it that says
 * what the field will get (pickSentence), and the sheet that changes it
 * (PickOptionsSheet). The web's ValueSlot does the same with the same words.
 *
 * Also used for a value inside a composed text, whose pill cannot be tapped
 * inside the text field: the list of its values under the field opens the
 * same sheet.
 *
 * The pick is shown as stored. A changed choice is written as a new pick of
 * the same source (a stored `label` goes: it named the old choice); choosing
 * what it already is writes nothing, so a legacy binding shown as the pick
 * it lifts to is only rewritten when the author really changes it.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { PickIntent, PickPart, Slot } from '@/shared/mapping';
import { Text } from '@/shared/ui';

import { pickLabel } from './pickLabel';
import { PickOptionsSheet } from './PickOptionsSheet';
import { pickSentence } from './pickSentence';
import { countAt, groupLabelOf, isStale, manyForOne, previewText, resolvePreview, shapeAt, type GroupLike, type Sample } from './slotModel';
import { ValueChip } from './ValueChip';

export interface PickedValueProps {
    pick: PickPart;
    slot: Slot;
    sample?: Sample;
    /** The upstream steps the editor knows (the variable picker's groups). */
    groups?: readonly GroupLike[] | null;
    stepLabelById?: Pick<Map<string, string>, 'get'> | null;
    /** A changed choice: take/as/join for the same source. */
    onChange: (intent: PickIntent) => void;
    onRemove?: () => void;
    /** The source is gone: pick the value again. */
    onRepick?: () => void;
    /** Advanced › write it as a formula instead. */
    onFormula?: () => void;
    disabled?: boolean;
    testID?: string;
}

const same = (a: PickIntent, b: PickIntent) => a.take === b.take && a.as === b.as && (a.join || null) === (b.join || null);

export function PickedValue({ pick, slot, sample, groups, stepLabelById, onChange, onRemove, onRepick, onFormula, disabled = false, testID }: PickedValueProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const label = pickLabel(t, pick, groupLabelOf(pick.from, groups, stepLabelById));
    // Without the value in the sample, a pick that takes from many is about a list.
    const seen = shapeAt(pick.from, sample);
    const shape = (seen === 'unknown' || seen === 'missing') && pick.take !== 'one' ? 'list' : seen;
    const count = countAt(pick.from, sample);
    const stale = isStale(pick.from, groups, sample);
    const preview = previewText(resolvePreview(pick.from, pick, sample));
    const sentence = pickSentence(t, pick, count);
    const amber = manyForOne(pick, shape);

    return (
        <View style={styles.box}>
            <ValueChip
                label={label}
                state={stale ? 'stale' : 'ok'}
                count={pick.take === 'all' || pick.take === 'each' ? count : null}
                preview={preview}
                onOpen={() => setOpen(true)}
                onRemove={onRemove}
                onRepick={onRepick}
                disabled={disabled}
                testID={testID}
            />
            {sentence ? (
                <Text variant="caption" tone={amber ? 'warning' : 'tertiary'} testID={testID ? `${testID}-sentence` : undefined}>
                    {sentence}
                </Text>
            ) : null}
            <PickOptionsSheet
                visible={open}
                onClose={() => setOpen(false)}
                source={pick.from}
                sample={sample}
                slot={slot}
                shape={shape}
                value={pick}
                label={label}
                onSelect={(intent) => {
                    if (!same(intent, pick)) onChange(intent);
                }}
                onFormula={onFormula}
                testID={testID ? `${testID}-options` : undefined}
            />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.xs } satisfies ViewStyle,
});
