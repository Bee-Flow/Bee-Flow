/**
 * The variable picker: a full-height sheet over the data the steps before this
 * one produce (computeUpstreamGroups) — the web's VariablePicker popover, as a
 * phone does it. Search, the sample value beside every field, tap to insert.
 * A field that wants a LIST opens it on the lists found upstream only.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { VariableGroup } from '@/features/flow-editor/bindings';
import { SearchField, Sheet } from '@/shared/ui';

import { listRows, pickerRows, toggleExpanded } from './pickerModel';
import { VariableList } from './VariableList';

export interface PickRequest {
    /** The sheet's title; defaults to "Pick data from a step". */
    title?: string;
    /** Offer only the lists found upstream. */
    list?: boolean;
    onPick: (path: string) => void;
}

export function VariablePickerSheet({
    request,
    groups,
    sampleRoot,
    onClose,
}: {
    request: PickRequest | null;
    groups: readonly VariableGroup[];
    sampleRoot: unknown;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

    const close = () => {
        setQuery('');
        onClose();
    };
    const pick = (path: string) => {
        request?.onPick(path);
        close();
    };
    const rows = request?.list ? listRows(groups, { query, sampleRoot }) : pickerRows(groups, { query, expanded, sampleRoot });
    const nothingUpstream = groups.length === 0;
    const empty = nothingUpstream
        ? t('routines.mapping.no_upstream', 'No upstream data yet. Connect this step to a previous one to see its output here.')
        : t('routines.mapping.no_matches', 'No matches.');

    return (
        <Sheet
            visible={request !== null}
            onClose={close}
            title={request?.title ?? t('routines.builder.pick_data', 'Pick data from a step')}
            subtitle={request?.list ? t('routines.builder.lists_detected', 'Lists found in previous steps') : undefined}
            scroll={false}
            tall
        >
            <View style={styles.body}>
                <SearchField
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('routines.mapping.search', 'Search a field…')}
                />
                <VariableList
                    testID="variable-picker-list"
                    rows={rows}
                    onPick={pick}
                    onToggle={(path) => setExpanded((prev) => toggleExpanded(prev, path))}
                    wholeGroup={!request?.list}
                    emptyText={empty}
                />
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    body: {
        flexShrink: 1,
        paddingHorizontal: theme.spacing[5],
        paddingTop: theme.spacing.md,
        gap: theme.spacing.sm,
    } satisfies ViewStyle,
});
