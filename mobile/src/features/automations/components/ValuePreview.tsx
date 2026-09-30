/**
 * A step's output, drawn.
 *
 * The run screens used to hand every non-string output to `previewValue`,
 * which pretty-prints JSON and clips it at 1200 characters. That is honest and
 * unreadable: the commonest thing a routine step produces is a LIST OF ROWS —
 * search results, datatable rows, the files in a folder — so someone reading a
 * run on their phone got two braces and a wall of quoted keys, where the web
 * builder shows them a table. Web's OutputView has offered Fields / Table /
 * JSON for a while and defaults away from JSON; mobile never got the same
 * treatment, so one run read completely differently depending on which screen
 * you opened it on.
 *
 * The classifier is `describeValue` in ../format — pure, and tested on its own.
 * This file only draws what it decided, which is why the hard rules about what
 * counts as a table live there and not here.
 *
 * THE RAW JSON IS NEVER TAKEN AWAY, only demoted. Every non-trivial shape keeps
 * a "Show raw" toggle (RawToggle), because the first thing anyone does with a failing
 * payload is paste it to a colleague, and because the person debugging at 3am
 * needs the exact bytes rather than a tidied summary. Same doctrine the canvas
 * follows on web: the readable thing is what you see, the exact thing is one
 * tap away.
 *
 * A field or a column is headed by its key made readable ("From email", not
 * FROM_EMAIL): the key is the machine's name for it, and the exact key is in
 * the raw view. The flow editor draws the same preview in a step's Output tab
 * and its test-run cards, with `bare` — it owns the toggle there, because its
 * raw form is a tree rather than this sheet.
 */

import React, { useState } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { humanizeFieldKey } from '@/shared/lib/humanizeKey';
import { Markdown } from '@/shared/markdown';
import { Text } from '@/shared/ui';

import { RawToggle } from './RawToggle';
import { describeValue, isProse, previewValue, type ValueShape } from '../model/format';

const makeStyles = (theme: Theme) => ({
    raw: { padding: theme.spacing.md, borderRadius: theme.radii.sm, backgroundColor: theme.colors.bgTertiary } satisfies ViewStyle,
    stack: { gap: theme.spacing.xs } satisfies ViewStyle,
    row: { flexDirection: 'row' } satisfies ViewStyle,
    cell: { minWidth: 96, paddingRight: theme.spacing.md } satisfies ViewStyle,
    field: { flexDirection: 'row', gap: theme.spacing.md } satisfies ViewStyle,
    fieldKey: { minWidth: 96, maxWidth: '40%' } satisfies ViewStyle,
    fieldValue: { flex: 1 } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md } satisfies ViewStyle,
});

type Styles = ReturnType<typeof makeStyles>;

/** A key as a person reads it: `from_email` → "From email"; a key with no words stays itself. */
const fieldLabel = (key: string) => humanizeFieldKey(key) || key;

/** The raw sheet: the exact characters. */
function RawBlock({ text }: { text: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.raw}>
            <Text variant="code" tone="secondary" selectable>
                {text}
            </Text>
        </View>
    );
}

function rowsCount(shape: Extract<ValueShape, { kind: 'rows' }>, t: TranslateFn): string {
    // The count is the honest part. A clipped table that presents itself as
    // the whole answer is how someone concludes a routine dropped their rows.
    if (shape.total > shape.rows.length) {
        return t('mobile.automations.value.rows_clipped', 'Showing {shown} of {total} rows', { shown: shape.rows.length, total: shape.total });
    }
    return shape.total === 1 ? t('mobile.automations.value.one_row', '1 row') : t('routines.canvas.result.rows', '{n} rows', { n: shape.total });
}

/**
 * A table. Horizontally scrollable rather than squeezed: a phone is ~360dp
 * wide and four columns of real data do not fit, so the choice is between
 * scrolling and truncating every cell to uselessness.
 */
function Rows({ shape, styles }: { shape: Extract<ValueShape, { kind: 'rows' }>; styles: Styles }) {
    const t = useTranslation();
    return (
        <View style={styles.stack}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.stack}>
                    <View style={styles.row}>
                        {shape.columns.map((c) => (
                            <View key={c} style={styles.cell}>
                                <Text variant="label" tone="tertiary" weight="medium">
                                    {fieldLabel(c)}
                                </Text>
                            </View>
                        ))}
                    </View>
                    {shape.rows.map((row, i) => (
                        // rows have no id; order IS their identity here
                        <View key={i} style={styles.row}>
                            {row.map((value, j) => (
                                // column order, same reason
                                <View key={j} style={styles.cell}>
                                    <Text variant="caption" tone="secondary" selectable>
                                        {value}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    ))}
                </View>
            </ScrollView>
            <Text variant="label" tone="tertiary">
                {rowsCount(shape, t)}
            </Text>
        </View>
    );
}

function Fields({ shape, styles }: { shape: Extract<ValueShape, { kind: 'record' }>; styles: Styles }) {
    return (
        <View style={styles.stack}>
            {shape.fields.map((f) => (
                <View key={f.key} style={styles.field}>
                    <View style={styles.fieldKey}>
                        <Text variant="label" tone="tertiary" weight="medium">
                            {fieldLabel(f.key)}
                        </Text>
                    </View>
                    <View style={styles.fieldValue}>
                        <Text variant="caption" tone="secondary" selectable>
                            {f.value}
                        </Text>
                    </View>
                </View>
            ))}
        </View>
    );
}

function Items({ shape, styles }: { shape: Extract<ValueShape, { kind: 'list' }>; styles: Styles }) {
    const t = useTranslation();
    return (
        <View style={styles.stack}>
            {shape.items.map((item, i) => (
                // a list of scalars has no stable key but its order
                <Text key={i} variant="caption" tone="secondary" selectable>
                    {`• ${item}`}
                </Text>
            ))}
            {shape.total > shape.items.length ? (
                <Text variant="label" tone="tertiary">
                    {t('mobile.automations.value.items_clipped', 'Showing {shown} of {total}', { shown: shape.items.length, total: shape.total })}
                </Text>
            ) : null}
        </View>
    );
}

/** What the preview draws: the exact characters when asked, else the shape's readable form. */
function bodyFor(shape: ValueShape, value: unknown, raw: boolean, styles: Styles): React.ReactNode {
    if (shape.kind === 'empty') return null;
    if (raw || shape.kind === 'raw') {
        return <RawBlock text={shape.kind === 'raw' || shape.kind === 'scalar' ? shape.text : (previewValue(value) ?? '')} />;
    }
    if (shape.kind === 'scalar') return isProse(value) ? <Markdown value={shape.text} streaming={false} /> : <RawBlock text={shape.text} />;
    if (shape.kind === 'rows') return <Rows shape={shape} styles={styles} />;
    if (shape.kind === 'record') return <Fields shape={shape} styles={styles} />;
    return <Items shape={shape} styles={styles} />;
}

/**
 * Whether a value has a readable form to switch away from. A single literal
 * and an already-raw blob have nothing to toggle TO, so they get no control:
 * an affordance that does nothing is worse than none.
 */
function hasReadableForm(value: unknown): boolean {
    const kind = describeValue(value).kind;
    return kind === 'rows' || kind === 'record' || kind === 'list' || (kind === 'scalar' && isProse(value));
}

export function ValuePreview({
    value,
    label,
    bare = false,
}: {
    value: unknown;
    /** The heading over the value ("Sent", "Received"). */
    label?: string;
    /** Only the readable form: no heading and no raw toggle — the caller owns both. */
    bare?: boolean;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [raw, setRaw] = useState(false);
    const shape = describeValue(value, { yes: t('common.yes', 'Yes'), no: t('common.no', 'No') });

    if (shape.kind === 'empty') return null;
    // Prose (an AI step's answer, a composed email) is drawn as the markdown
    // it usually is, with its exact characters one tap away like any shape.
    const body = bodyFor(shape, value, raw && !bare, styles);
    if (bare) return <View style={styles.stack}>{body}</View>;

    return (
        <View style={styles.stack}>
            <View style={styles.head}>
                {label ? (
                    <Text variant="label" tone="tertiary">
                        {label.toUpperCase()}
                    </Text>
                ) : null}
                {hasReadableForm(value) ? <RawToggle value={value} raw={raw} onToggle={() => setRaw((v) => !v)} subject={label} /> : null}
            </View>
            {body}
        </View>
    );
}
