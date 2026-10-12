/**
 * The run log's filters — the web's ExecutionsFilterBar for a phone: status
 * pills with their counts from the facets, the date range, and three chips
 * that open a choice each (trigger, live or test, which automation). Under them,
 * in one sentence, what is narrowing the list and a way to undo it all.
 *
 * Presentational: the screen owns the filters.
 */

import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Chip, FilterPills, Segmented, Text } from '@/shared/ui';

import { ChoiceSheet, type Choice } from './ChoiceSheet';
import {
    EVERYTHING,
    RANGES,
    STATUS_CHIPS,
    isNarrowed,
    statusCount,
    type ModeFilter,
    type RangeKey,
    type RunFilters,
    type StatusChip,
} from '../model/filters';
import { triggerLabel, triggerWords } from '../model/runLanguage';
import type { RunFacets } from '../model/types';

type Picker = 'trigger' | 'mode' | 'automation' | null;

function statusWord(chip: StatusChip, t: TranslateFn): string {
    switch (chip) {
        case 'success': return t('common.success', 'Success');
        case 'error': return t('mobile.runs.filter.error', 'Failures');
        case 'running': return t('automations.run_progress_banner.running', 'Running');
        case 'awaiting': return t('mobile.runs.filter.awaiting', 'Awaiting');
        case 'cancelled': return t('mobile.runs.filter.cancelled', 'Stopped');
        default: return t('common.all', 'All');
    }
}

function rangeWord(range: RangeKey, t: TranslateFn): string {
    return range === 'all' ? t('common.all', 'All') : range;
}

function modeWord(mode: ModeFilter, t: TranslateFn): string {
    if (mode === 'dry_run') return t('mobile.runs.filter.mode_test', 'Tests only');
    if (mode === 'both') return t('mobile.runs.filter.mode_both', 'Live runs and tests');
    return t('mobile.runs.filter.mode_live', 'Live runs');
}

function triggerWord(kind: string | null, t: TranslateFn): string {
    if (!kind) return t('mobile.runs.filter.any_trigger', 'Any trigger');
    const words = triggerWords(kind);
    return words ? t(words.key, words.en) : triggerLabel(kind);
}

/** The automations the facets name, titled from the rollup where it has one. */
function automationChoices(facets: RunFacets | null | undefined, t: TranslateFn): Choice[] {
    const titles = new Map((facets?.automations ?? []).map((r) => [r.automationId, r.title]));
    const ids = Object.keys(facets?.automationId ?? {});
    return [
        { value: '', label: t('mobile.runs.filter.all_automations', 'All automations') },
        ...ids.map((id) => ({ value: id, label: titles.get(id) || t('runs.now.untitled', 'An automation without a name') })),
    ];
}

export function RunFilterBar({
    filters,
    onChange,
    facets,
    automationFacets,
}: {
    filters: RunFilters;
    onChange: (next: RunFilters) => void;
    /** Counts narrowed like the list, automation included. */
    facets: RunFacets | null | undefined;
    /** The same window not narrowed by automation: the picker's choices. */
    automationFacets: RunFacets | null | undefined;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [picker, setPicker] = useState<Picker>(null);
    const set = (patch: Partial<RunFilters>) => onChange({ ...filters, ...patch });
    const triggers: Choice[] = [
        { value: '', label: triggerWord(null, t) },
        ...Object.keys(facets?.triggerKind ?? {}).sort().map((kind) => ({ value: kind, label: triggerWord(kind, t) })),
    ];
    const modes: Choice[] = (['live', 'dry_run', 'both'] as const).map((m) => ({ value: m, label: modeWord(m, t) }));
    const automations = automationChoices(automationFacets ?? facets, t);
    const automationLabel = automations.find((c) => c.value === (filters.automationId ?? ''))?.label ?? automations[0]!.label;
    return (
        <View style={styles.bar}>
            <FilterPills
                scroll
                value={filters.status}
                onChange={(status) => set({ status })}
                accessibilityLabel={t('mobile.runs.filter.status', 'Outcome')}
                options={STATUS_CHIPS.map((chip) => ({ value: chip, label: statusWord(chip, t), count: statusCount(facets, chip) }))}
                testID="runs-status"
            />
            <Segmented
                value={filters.range}
                onChange={(range) => set({ range })}
                accessibilityLabel={t('mobile.runs.filter.range', 'When')}
                options={RANGES.map((range) => ({ value: range, label: rangeWord(range, t) }))}
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                <Chip label={triggerWord(filters.trigger, t)} selected={Boolean(filters.trigger)} onPress={() => setPicker('trigger')} testID="runs-trigger" />
                <Chip label={modeWord(filters.mode, t)} selected={filters.mode !== 'live'} onPress={() => setPicker('mode')} testID="runs-mode" />
                <Chip label={automationLabel} selected={Boolean(filters.automationId)} onPress={() => setPicker('automation')} testID="runs-automation" />
            </ScrollView>
            <Standing filters={filters} onReset={() => onChange({ ...EVERYTHING })} />
            <ChoiceSheet visible={picker === 'trigger'} title={t('mobile.runs.filter.trigger', 'Started by')} choices={triggers} value={filters.trigger ?? ''} onPick={(v) => set({ trigger: v || null })} onClose={() => setPicker(null)} />
            <ChoiceSheet visible={picker === 'mode'} title={t('mobile.runs.filter.mode', 'Live or test runs')} choices={modes} value={filters.mode} onPick={(v) => set({ mode: v as ModeFilter })} onClose={() => setPicker(null)} />
            <ChoiceSheet visible={picker === 'automation'} title={t('mobile.runs.filter.automation', 'Which automation')} choices={automations} value={filters.automationId ?? ''} onPick={(v) => set({ automationId: v || null })} onClose={() => setPicker(null)} />
        </View>
    );
}

/** What narrows the list, and what the counts cover. */
function Standing({ filters, onReset }: { filters: RunFilters; onReset: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (!isNarrowed(filters) && filters.range !== 'all') return null;
    return (
        <View style={styles.standing}>
            {filters.range === 'all' ? (
                <Text variant="label" tone="tertiary" style={styles.grow}>
                    {t('mobile.runs.filter.counts_30d', 'Counts cover the last 30 days.')}
                </Text>
            ) : (
                <View style={styles.grow} />
            )}
            {isNarrowed(filters) ? (
                <Button size="sm" variant="ghost" label={t('mobile.runs.filter.show_everything', 'Show everything')} onPress={onReset} />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    bar: { gap: theme.spacing[2.5] },
    chips: { gap: theme.spacing[2] },
    standing: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[2] },
    grow: { flex: 1 },
});
