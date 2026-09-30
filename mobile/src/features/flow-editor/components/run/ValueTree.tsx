/**
 * A value on a test-run card, drawn the way the Automations screens draw the
 * same run: readable first (outputView — a table, fields, a list, the text,
 * or a tree in words for a value too nested for those), the exact JSON tree
 * behind "Show raw". The tree is the web's OutputView/JsonTree inside the
 * dry-run drawer: top-level keys visible, containers open on a tap, a long
 * press copies a row. Built from the node editor's tree rows
 * (nodeEditor/jsonTree.ts), capped so one step's output cannot flood the
 * sheet; the step editor's Output tab has the whole of it.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { RawToggle, ValuePreview } from '@/features/automations';
import { Text, useToast } from '@/shared/ui';

import { JsonRow } from '../nodeEditor/JsonRow';
import { copyText, treeRows, treeWords, type TreeRow } from '../nodeEditor/jsonTree';
import { outputView } from '../nodeEditor/outputView';

/** Rows shown at most; the step editor shows the rest. */
export const TREE_ROW_LIMIT = 60;

const makeStyles = (theme: Theme) => ({
    stack: { gap: theme.spacing.sm } satisfies ViewStyle,
    toggle: { flexDirection: 'row', justifyContent: 'flex-end' } satisfies ViewStyle,
    box: {
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgPrimary,
        overflow: 'hidden',
    } satisfies ViewStyle,
    more: { paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.xs } satisfies ViewStyle,
});

function Tree({ value, readable, testID }: { value: unknown; readable: boolean; testID?: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const rows = treeRows(value, expanded, TREE_ROW_LIMIT + 1, readable ? treeWords(t) : null);
    const toggle = (id: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const copy = (row: TreeRow) => {
        void Clipboard.setStringAsync(copyText(row.value));
        toast(t('common.copied', 'Copied to clipboard'), 'success');
    };
    return (
        <View style={styles.box} testID={testID}>
            {rows.slice(0, TREE_ROW_LIMIT).map((row) => (
                <JsonRow key={row.id} row={row} onToggle={toggle} onCopy={copy} readable={readable} />
            ))}
            {rows.length > TREE_ROW_LIMIT ? (
                <View style={styles.more}>
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.flow.run.tree_more', 'More in the step’s Output tab')}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

export function ValueTree({ value, testID }: { value: unknown; testID?: string }) {
    const styles = useThemedStyles(makeStyles);
    const [raw, setRaw] = useState(false);
    const view = outputView(value, raw);
    if (view.body === 'none') return null;
    return (
        <View style={styles.stack}>
            {view.canToggle ? (
                <View style={styles.toggle}>
                    <RawToggle value={value} raw={raw} onToggle={() => setRaw((v) => !v)} testID={testID ? `${testID}-raw` : undefined} />
                </View>
            ) : null}
            {view.body === 'preview' ? (
                <View testID={testID}>
                    <ValuePreview value={value} bare />
                </View>
            ) : (
                <Tree value={value} readable={view.readableTree} testID={testID} />
            )}
        </View>
    );
}
