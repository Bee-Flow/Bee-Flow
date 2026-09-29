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
 * a "Show raw" toggle, because the first thing anyone does with a failing
 * payload is paste it to a colleague, and because the person debugging at 3am
 * needs the exact bytes rather than a tidied summary. Same doctrine the canvas
 * follows on web: the readable thing is what you see, the exact thing is one
 * tap away.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Text } from '../../../ui/Text';
import { describeValue, previewValue, type ValueShape } from '../format';

/** The raw sheet, and the control that reveals it. */
function RawBlock({ text }: { text: string }) {
    const theme = useTheme();
    return (
        <View
            style={{
                padding: theme.spacing.md,
                borderRadius: theme.radii.sm,
                backgroundColor: theme.colors.bgTertiary,
            }}
        >
            <Text variant="code" tone="secondary" selectable>
                {text}
            </Text>
        </View>
    );
}

/**
 * A table. Horizontally scrollable rather than squeezed: a phone is ~360dp
 * wide and four columns of real data do not fit, so the choice is between
 * scrolling and truncating every cell to uselessness.
 */
function Rows({ shape }: { shape: Extract<ValueShape, { kind: 'rows' }> }) {
    const theme = useTheme();
    const cell = { minWidth: 96, paddingRight: theme.spacing.md };
    return (
        <View style={{ gap: theme.spacing.xs }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ gap: theme.spacing.xs }}>
                    <View style={{ flexDirection: 'row' }}>
                        {shape.columns.map((c) => (
                            <View key={c} style={cell}>
                                <Text variant="label" tone="tertiary">
                                    {c.toUpperCase()}
                                </Text>
                            </View>
                        ))}
                    </View>
                    {shape.rows.map((row, i) => (
                        // rows have no id; order IS their identity here
                        <View key={i} style={{ flexDirection: 'row' }}>
                            {row.map((value, j) => (
                                // column order, same reason
                                <View key={j} style={cell}>
                                    <Text variant="caption" tone="secondary" selectable>
                                        {value}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    ))}
                </View>
            </ScrollView>
            {shape.total > shape.rows.length ? (
                // The count is the honest part. A clipped table that presents
                // itself as the whole answer is how someone concludes a routine
                // dropped their rows.
                <Text variant="label" tone="tertiary">
                    {`Showing ${shape.rows.length} of ${shape.total} rows`}
                </Text>
            ) : (
                <Text variant="label" tone="tertiary">
                    {shape.total === 1 ? '1 row' : `${shape.total} rows`}
                </Text>
            )}
        </View>
    );
}

function Fields({ shape }: { shape: Extract<ValueShape, { kind: 'record' }> }) {
    const theme = useTheme();
    return (
        <View style={{ gap: theme.spacing.xs }}>
            {shape.fields.map((f) => (
                <View key={f.key} style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                    <View style={{ minWidth: 96 }}>
                        <Text variant="label" tone="tertiary">
                            {f.key.toUpperCase()}
                        </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text variant="caption" tone="secondary" selectable>
                            {f.value}
                        </Text>
                    </View>
                </View>
            ))}
        </View>
    );
}

function Items({ shape }: { shape: Extract<ValueShape, { kind: 'list' }> }) {
    const theme = useTheme();
    return (
        <View style={{ gap: theme.spacing.xs }}>
            {shape.items.map((item, i) => (
                // a list of scalars has no stable key but its order
                <Text key={i} variant="caption" tone="secondary" selectable>
                    {`• ${item}`}
                </Text>
            ))}
            {shape.total > shape.items.length ? (
                <Text variant="label" tone="tertiary">
                    {`Showing ${shape.items.length} of ${shape.total}`}
                </Text>
            ) : null}
        </View>
    );
}

export function ValuePreview({ value, label }: { value: unknown; label: string }) {
    const theme = useTheme();
    const [raw, setRaw] = useState(false);
    const shape = describeValue(value);

    if (shape.kind === 'empty') return null;

    // A single value and an already-raw blob have nothing to toggle TO, so
    // they get no control: an affordance that does nothing is worse than none.
    const canToggle = shape.kind === 'rows' || shape.kind === 'record' || shape.kind === 'list';

    let body: React.ReactNode;
    if (raw || shape.kind === 'raw') {
        body = <RawBlock text={shape.kind === 'raw' ? shape.text : (previewValue(value) ?? '')} />;
    } else if (shape.kind === 'scalar') {
        body = <RawBlock text={shape.text} />;
    } else if (shape.kind === 'rows') {
        body = <Rows shape={shape} />;
    } else if (shape.kind === 'record') {
        body = <Fields shape={shape} />;
    } else {
        body = <Items shape={shape} />;
    }

    return (
        <View style={{ gap: theme.spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
                <Text variant="label" tone="tertiary">
                    {label.toUpperCase()}
                </Text>
                {canToggle ? (
                    <Pressable
                        onPress={() => setRaw((v) => !v)}
                        // 44dp is the platform minimum for a touch target; a
                        // 15px label is nowhere near it without the hit slop.
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: raw }}
                        accessibilityLabel={raw ? `Show ${label} as a table` : `Show raw ${label}`}
                    >
                        <Text variant="label" tone="accent">
                            {raw ? 'SHOW TABLE' : 'SHOW RAW'}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
            {body}
        </View>
    );
}
