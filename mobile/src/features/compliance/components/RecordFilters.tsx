/**
 * A register's filter pills (web: the register pages' status filter row):
 * one row of FilterPills per group, each option with the number of rows it
 * would leave. The active options of all groups are ANDed (model/filters.ts).
 * Rendered above the list, so the pills stay when a filter leaves no rows.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FilterPills, type ChipTone } from '@/shared/ui';

import { labelText } from '../model/fields';
import { filterCounts, type ActiveFilters } from '../model/filters';
import type { Formatter, Rec, RecordFilterGroup, RecordTone } from '../model/types';

const PILL_TONE: Record<RecordTone, ChipTone> = { success: 'success', warning: 'warning', error: 'error', neutral: 'neutral', info: 'neutral' };

export interface RecordFiltersProps {
    groups: readonly RecordFilterGroup[];
    rows: readonly Rec[];
    active: ActiveFilters;
    onChange: (groupId: string, optionId: string) => void;
    fmt: Formatter;
}

export function RecordFilters({ groups, rows, active, onChange, fmt }: RecordFiltersProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.wrap}>
            {groups.map((g) => {
                const counts = filterCounts(g, rows, fmt.now);
                return (
                    <FilterPills
                        key={g.id}
                        testID={`filter-${g.id}`}
                        scroll
                        value={active[g.id] ?? g.options[0]?.id ?? ''}
                        onChange={(next) => onChange(g.id, next)}
                        options={g.options.map((o) => ({
                            value: o.id,
                            label: labelText(o.label, fmt.t),
                            count: counts[o.id],
                            tone: o.tone ? PILL_TONE[o.tone] : undefined,
                        }))}
                    />
                );
            })}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ wrap: { gap: theme.spacing.sm } });
