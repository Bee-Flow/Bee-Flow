/**
 * Whether the request keeps its answers, and in which table — the web's
 * CacheIntoRow. A table this account can no longer reach keeps showing as
 * such, rather than silently pointing elsewhere.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { CatalogDatatable } from '@/features/flow-editor/api';
import { NumberField, SelectField, ToggleField } from '@/features/flow-editor/components/fields';

import { answerTables, AUDIENCE_ANY, cacheDays, cacheForDays, cacheTable, TABLE_AUDIENCE, type CacheInto } from './httpModel';
import { say } from '../declarative/runtime';
import { Note } from '../shared/Note';

export function CacheIntoRow({
    current,
    onChange,
    tables: all,
    disabled,
    reason: ownReason,
}: {
    current: CacheInto;
    onChange: (next: CacheInto | undefined) => void;
    tables: readonly CatalogDatatable[];
    disabled: boolean;
    reason: string | null;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const tables = answerTables(all);
    const on = !!current?.datatableId;
    // A tick with nowhere to put the answers would read as configured and do nothing.
    const none = tables.length === 0;
    const reason = disabled ? ownReason : none ? t('mobile.flow.http.cache_no_table', 'Make an answers table first — Studio → Datatables → New table → “Web service answers”.') : null;
    const options = [
        ...(on && !tables.some((x) => x.id === current?.datatableId) ? [{ value: current?.datatableId ?? '', label: t('automations.cache_into_row.a_table_you_can_no_longer', '(a table you can no longer reach)') }] : []),
        ...tables.map((x) => ({
            value: x.id,
            label: x.name,
            description: t('mobile.flow.http.readable_by', 'readable by {who}', { who: say(t, TABLE_AUDIENCE[String(x.scope)] ?? AUDIENCE_ANY) }),
        })),
    ];
    return (
        <View style={styles.box}>
            <ToggleField
                label={t('automations.cache_into_row.remember_answers_in_a_table', 'Remember answers in a table')}
                description={
                    reason ??
                    t('mobile.flow.http.remember_hint', 'Each answer is written to a table as an ordinary row, so a later run — days or weeks on — uses it instead of asking again. You can open the table, check the answers, correct them and export them.')
                }
                value={on}
                onChange={(tick) => onChange(cacheTable(current, tick ? (tables[0]?.id ?? '') : ''))}
                disabled={disabled || (none && !on)}
                testID="http-cache-into"
            />
            {on ? (
                <>
                    <SelectField label={t('automations.cache_into_row.which_table', 'Which table')} value={current?.datatableId ?? ''} options={options} onChange={(id) => onChange(cacheTable(current, id))} disabled={disabled} />
                    <NumberField
                        label={t('automations.cache_into_row.reuse_an_answer_for', 'Reuse an answer for')}
                        value={cacheDays(current)}
                        onChange={(n) => onChange(cacheForDays(current, n) ?? undefined)}
                        min={1}
                        max={3650}
                        integer
                        suffix={t('automations.cache_into_row.days', 'days')}
                        disabled={disabled}
                    />
                    <Note>
                        {t('automations.cache_into_row.answers_land_as_ordinary_rows_everyone', 'Answers land as ordinary rows: everyone with access to that table can read and export them. Old rows are removed by the retention window set on the table itself.')}
                    </Note>
                </>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.xs, paddingTop: theme.spacing.xs } satisfies ViewStyle,
});
