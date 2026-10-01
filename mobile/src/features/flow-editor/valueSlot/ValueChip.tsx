/**
 * A field's value from an earlier step, as one chip — the web's
 * Builder/valueSlot/ValueChip.tsx at a phone's touch size, with its words:
 * the value's name, and for a list how many it holds
 * ("Product of all orderregels · 12").
 *
 *   ok       the chip, with an example of the value beside it in grey
 *   stale    amber: the source is gone (a step was removed, a field renamed):
 *            "No longer available: E-mail of customer · Pick again"
 *   formula  grey "Formula" chip with a one-line summary, for a stored
 *            binding that does not read as one value (pickLabel.ts
 *            formulaSummary words it)
 *
 * Presentational: what a tap does is the caller's.
 */

import React from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Text, tint } from '@/shared/ui';

export type ValueChipState = 'ok' | 'stale' | 'formula';

export interface ValueChipProps {
    label: string;
    state?: ValueChipState;
    /** Values in the list, shown as "· 12"; null or undefined for one value. */
    count?: number | null;
    /** A short example of the value from the sample or the last run. */
    preview?: string | null;
    /** The formula in words (state 'formula'). */
    summary?: string;
    /** A tap on the chip: how the value is used (PickOptionsSheet), or the formula editor. */
    onOpen?: () => void;
    onRemove?: () => void;
    /** state 'stale': pick the value again. */
    onRepick?: () => void;
    disabled?: boolean;
    testID?: string;
}

const id = (testID: string | undefined, suffix: string) => (testID ? `${testID}-${suffix}` : undefined);

type Styles = ReturnType<typeof makeStyles>;

function RemoveButton({ name, onRemove, testID }: { name: string; onRemove: () => void; testID?: string }) {
    const t = useTranslation();
    return (
        <IconButton
            icon={<Icon name="X" size={16} />}
            tone="danger"
            accessibilityLabel={t('mapping.slot.remove', 'Remove {label}', { label: name })}
            onPress={onRemove}
            testID={id(testID, 'remove')}
        />
    );
}

/** The grey example (or the formula in words) beside a chip. */
function Aside({ text, testID, styles }: { text?: string | null; testID?: string; styles: Styles }) {
    if (!text) return null;
    return (
        <Text variant="caption" tone="tertiary" numberOfLines={2} style={styles.aside} testID={id(testID, 'preview')}>
            {text}
        </Text>
    );
}

interface ChipProps {
    open?: () => void;
    /** What a screen reader says for a chip that opens something. */
    a11y: string;
    words: string;
    tone: 'ok' | 'stale' | 'formula';
    children?: React.ReactNode;
    styles: Styles;
    testID?: string;
}

/** The pressable chip itself. */
function Chip({ open, a11y, words, tone, children, styles, testID }: ChipProps) {
    const ink = tone === 'stale' ? styles.staleInk : tone === 'formula' ? styles.formulaInk : null;
    return (
        <Pressable
            onPress={open}
            disabled={!open}
            accessibilityRole={open ? 'button' : undefined}
            accessibilityLabel={open ? a11y : words}
            style={[styles.chip, styles[tone]]}
            testID={id(testID, 'open')}
        >
            {tone === 'stale' ? <Icon name="TriangleAlert" size={14} color={styles.staleInk.color} /> : null}
            {tone === 'formula' ? <Icon name="Sigma" size={14} color={styles.formulaInk.color} /> : null}
            <Text variant="caption" weight="medium" numberOfLines={1} style={[styles.words, ink]}>
                {words}
            </Text>
            {children}
        </Pressable>
    );
}

type Part = Omit<ValueChipProps, 'state' | 'disabled'> & { styles: Styles; remove: React.ReactNode };

function PickChip({ label, count, preview, onOpen, remove, styles, testID }: Part) {
    const t = useTranslation();
    const counted = typeof count === 'number' && Number.isFinite(count);
    return (
        <>
            <Chip open={onOpen} a11y={t('mapping.slot.open_options', 'Change how {label} is used', { label })} words={label} tone="ok" styles={styles} testID={testID}>
                {counted ? (
                    <Text variant="caption" tone="secondary" accessibilityLabel={t('mapping.slot.list_count', '{count} values', { count: count as number })}>
                        {`· ${count}`}
                    </Text>
                ) : null}
            </Chip>
            {remove}
            <Aside text={preview} testID={testID} styles={styles} />
        </>
    );
}

function StaleChip({ label, onOpen, onRepick, remove, styles, testID }: Part) {
    const t = useTranslation();
    const words = t('mapping.slot.stale', 'No longer available: {label}', { label });
    return (
        <>
            <Chip open={onOpen} a11y={t('mapping.slot.open_options', 'Change how {label} is used', { label })} words={words} tone="stale" styles={styles} testID={testID} />
            {onRepick ? (
                <Pressable onPress={onRepick} accessibilityRole="button" testID={id(testID, 'repick')} hitSlop={8}>
                    <Text variant="caption" weight="semibold" tone="warning" style={styles.link}>
                        {t('mapping.slot.repick', 'Pick again')}
                    </Text>
                </Pressable>
            ) : null}
            {remove}
        </>
    );
}

function FormulaChip({ summary, onOpen, remove, styles, testID }: Part) {
    const t = useTranslation();
    const name = t('mapping.slot.formula', 'Formula');
    const a11y = summary ? t('mapping.slot.formula_title', 'Formula: {summary}', { summary }) : name;
    return (
        <>
            <Chip open={onOpen} a11y={a11y} words={name} tone="formula" styles={styles} testID={testID} />
            {remove}
            <Aside text={summary} testID={testID} styles={styles} />
        </>
    );
}

const CHIPS = { ok: PickChip, stale: StaleChip, formula: FormulaChip } as const;

export function ValueChip({ state = 'ok', disabled = false, onOpen, onRemove, onRepick, testID, ...rest }: ValueChipProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const name = state === 'formula' ? t('mapping.slot.formula', 'Formula') : rest.label;
    const remove = onRemove && !disabled ? <RemoveButton name={name} onRemove={onRemove} testID={testID} /> : null;
    const Body = CHIPS[state];
    // Disabled: shown, not tappable.
    return (
        <View style={styles.row} testID={testID}>
            <Body
                {...rest}
                onOpen={disabled ? undefined : onOpen}
                onRepick={disabled ? undefined : onRepick}
                remove={remove}
                styles={styles}
                testID={testID}
            />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        maxWidth: '100%',
        minHeight: theme.minTouch,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
    } satisfies ViewStyle,
    ok: { borderColor: tint(theme.colors.accentPrimary, 35), backgroundColor: tint(theme.colors.accentPrimary, 10) } satisfies ViewStyle,
    stale: { borderColor: theme.colors.warning, backgroundColor: tint(theme.colors.warning, 8) } satisfies ViewStyle,
    formula: { borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgTertiary } satisfies ViewStyle,
    words: { flexShrink: 1 } satisfies TextStyle,
    staleInk: { color: theme.colors.warningInk } satisfies TextStyle,
    formulaInk: { color: theme.colors.textSecondary } satisfies TextStyle,
    link: { textDecorationLine: 'underline' } satisfies TextStyle,
    aside: { flexShrink: 1 } satisfies TextStyle,
});
