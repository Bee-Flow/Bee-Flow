/**
 * How a picked value is used, as a bottom sheet — the web's
 * Builder/valueSlot/PickOptions.tsx on a phone, with the same choices and
 * words: "All, one per line", "All, with commas", "Only the first", "The
 * number", … The choices are the shared core's (optionsFor), from what the
 * value is in the sample and what the field wants. Each one shows what the
 * field would get, LIVE: the pick is resolved by the same core the run uses,
 * on the sample (or the last run) the editor has, so a table shows one row
 * per line ("Stoel · 1 · 99.5"), never JSON and never "[object Object]".
 *
 * "Advanced" holds what most people never need: writing the value as a
 * formula instead (only offered where the field has a formula spelling of it).
 */

import React, { useMemo, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { optionsFor, type MappingSource, type PickIntent, type PickOption, type Shape, type Slot } from '@/shared/mapping';
import { Button, OptionRow, Sheet } from '@/shared/ui';

import { previewText, resolvePreview, shapeAt, type Sample } from './slotModel';

/**
 * Each option's words: the web's key (`mapping.slot.options.<id>`), with the
 * dictionary's English — valueSlot.lockstep.test.ts checks every id the core
 * offers. A table, not a template string, so the i18n guard sees the keys.
 */
const OPTION_WORDS: Readonly<Record<string, readonly [key: string, english: string]>> = {
    one: ['mapping.slot.options.one', 'The value'],
    all: ['mapping.slot.options.all', 'All of them'],
    all_lines: ['mapping.slot.options.all_lines', 'All, one per line'],
    all_comma: ['mapping.slot.options.all_comma', 'All, with commas'],
    all_bullets: ['mapping.slot.options.all_bullets', 'All, as a bulleted list'],
    first: ['mapping.slot.options.first', 'Only the first'],
    last: ['mapping.slot.options.last', 'Only the last'],
    count: ['mapping.slot.options.count', 'The number'],
    each: ['mapping.slot.options.each', 'One per run, for each item'],
};

/** An option's name in the current language. */
export function optionLabel(t: TranslateFn, id: string): string {
    const words = OPTION_WORDS[id];
    return words ? t(words[0], words[1]) : id;
}

const sameIntent = (a: PickIntent, b: PickIntent | null | undefined) =>
    !!b && a.take === b.take && a.as === b.as && (a.join || null) === (b.join || null);

export interface PickOptionsSheetProps {
    visible: boolean;
    onClose: () => void;
    source: MappingSource;
    /** The runState the previews resolve against: the sample, or the last run. */
    sample?: Sample;
    /** What the field wants (core slotShape). */
    slot?: Partial<Slot> | null;
    /** The source's shape, when the caller knows it better than the sample does. */
    shape?: Shape;
    /** The current choice; the default (the first option) when absent. */
    value?: PickIntent | null;
    /** The value's name, for the heading. */
    label?: string;
    /** The step repeats over this source: offer "one per run, for each item". */
    repeating?: boolean;
    onSelect: (intent: PickIntent) => void;
    /** Advanced › edit the value as a formula instead. */
    onFormula?: () => void;
    testID?: string;
}

function Advanced({ onFormula }: { onFormula: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    return (
        <View style={styles.advanced}>
            <Button
                size="sm"
                variant="ghost"
                iconName={open ? 'ChevronDown' : 'ChevronRight'}
                label={t('mapping.slot.options.advanced', 'Advanced')}
                onPress={() => setOpen((v) => !v)}
            />
            {open ? (
                <Button size="sm" variant="ghost" iconName="Sigma" label={t('mapping.slot.options.formula_hint', 'Write a formula instead')} onPress={onFormula} />
            ) : null}
        </View>
    );
}

export function PickOptionsSheet({
    visible, onClose, source, sample, slot, shape, value, label, repeating = false, onSelect, onFormula, testID,
}: PickOptionsSheetProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const sourceShape: Shape = useMemo(() => shape || shapeAt(source, sample), [shape, source, sample]);
    const options: PickOption[] = useMemo(() => optionsFor(sourceShape, slot, { repeat: repeating }), [sourceShape, slot, repeating]);
    const previews = useMemo(
        () => options.map((o) => (o.take === 'each' ? null : previewText(resolvePreview(source, o, sample)))),
        [options, source, sample],
    );
    const chosen = options.find((o) => sameIntent(o, value)) || (value ? null : options[0]);
    const example = (preview: string | null) => {
        if (preview === null) return t('mapping.slot.options.no_example', 'No example yet');
        return preview === '' ? t('mapping.slot.options.empty_example', '(empty)') : preview;
    };
    const select = (o: PickOption) => {
        onSelect(o.join ? { take: o.take, as: o.as, join: o.join } : { take: o.take, as: o.as });
        onClose();
    };

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mapping.slot.options.title', 'How should {label} be used?', { label: label || t('mapping.slot.label.value', 'Value') })}
        >
            <View accessibilityRole="radiogroup" style={styles.list} testID={testID}>
                {options.map((o, i) => (
                    <OptionRow
                        key={o.id}
                        label={optionLabel(t, o.id)}
                        description={o.take === 'each' ? undefined : example(previews[i] ?? null)}
                        selected={chosen === o}
                        onPress={() => select(o)}
                        testID={testID ? `${testID}-${o.id}` : undefined}
                    />
                ))}
            </View>
            {onFormula ? (
                <Advanced
                    onFormula={() => {
                        onClose();
                        onFormula();
                    }}
                />
            ) : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    list: { marginHorizontal: -theme.spacing.lg } satisfies ViewStyle,
    advanced: { alignItems: 'flex-start', gap: theme.spacing.xs, marginTop: theme.spacing.sm } satisfies ViewStyle,
});
