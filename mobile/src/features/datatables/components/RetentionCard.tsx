/**
 * "Rows are deleted after" — the window and the date column it counts from
 * (the first card of the web's RetentionPanel). Never / 7 / 30 / 90 days /
 * Other…, then the column; the state and every save are useRetentionEditor's.
 *
 * Only someone who may change the table changes this; everyone else reads
 * the rule. A managed table's column is shown, fixed, with the reason.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { formatWhen, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, FilterPills, Section, Text, TextField, type FilterPillOption } from '@/shared/ui';

import { useRetentionEditor, type RetentionEditor } from '../hooks/useRetentionEditor';
import { dateColumns, MAX_RETENTION_DAYS, RETENTION_PRESETS, retentionFieldLabel, retentionFieldOptions, type RetentionChoice } from '../model/retention';
import type { Column, Datatable } from '../model/types';

function windowOptions(t: TranslateFn, disabled: boolean): FilterPillOption<RetentionChoice>[] {
    return [
        { value: 'off', label: t('datatables.retention_never', 'Never'), disabled },
        ...RETENTION_PRESETS.map((n) => ({ value: String(n) as RetentionChoice, label: t('datatables.retention_days', '{n} days', { n }), disabled })),
        { value: 'custom', label: t('datatables.retention_other', 'Other…'), disabled },
    ];
}

function CustomDays({ editor, disabled }: { editor: RetentionEditor; disabled: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.customBlock}>
            <View style={styles.custom}>
                <TextField
                    label={t('datatables.retention_custom_label', 'Days')}
                    value={editor.text}
                    onChangeText={editor.setText}
                    keyboardType="number-pad"
                    editable={!disabled}
                    containerStyle={styles.grow}
                    testID="retention-days"
                />
                <Button label={t('datatables.retention_apply', 'Apply')} disabled={disabled || !editor.canApply} onPress={editor.apply} testID="retention-apply" />
            </View>
            <Text variant="label" tone="tertiary">
                {t('mobile.datatables.retention_custom_hint', 'A whole number of days, from 1 to {max}.', { max: MAX_RETENTION_DAYS })}
            </Text>
        </View>
    );
}

/** What the rule is now, as the server holds it — not the draft. */
function RuleSentence({ table, columns, field }: { table: Datatable; columns: readonly Column[]; field: string }) {
    const t = useTranslation();
    const label = retentionFieldLabel(t, columns, table.retentionField || field);
    const rule = table.retentionDays
        ? t('datatables.retention_on', 'Rows are deleted {n} days after their {field}.', { n: table.retentionDays, field: label })
        : t('datatables.retention_off', 'Rows stay until something deletes them — an automation step, or you.');
    // The web says this of every managed table; it is only true of a cache.
    const cache = table.managedKind === 'http_cache' && !!table.retentionDays;
    return (
        <>
            <Text variant="caption" tone="secondary" testID="retention-rule">
                {cache ? `${rule} ${t('datatables.retention_managed', 'For this table that window is the whole expiry story: it is what makes a remembered answer go stale, so an automation asks the service again. There is no second, hidden clock.')}` : rule}
            </Text>
            {/* The phone's clock in the app's language: the server sends UTC. */}
            {table.lastRetentionAt ? (
                <Text variant="label" tone="tertiary">
                    {t('datatables.retention_last_run', 'Last swept {when}.', { when: formatWhen(table.lastRetentionAt) })}
                </Text>
            ) : null}
        </>
    );
}

export function RetentionCard({ table, columns, canEdit }: { table: Datatable; columns: readonly Column[]; canEdit: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const editor = useRetentionEditor(table, columns);
    const managed = !!table.managedKind;
    const hasDates = dateColumns(columns).length > 0;
    const locked = !canEdit || editor.busy;
    const fields = retentionFieldOptions(table, columns, editor.field);
    const fieldLocked = locked || managed || !hasDates;

    return (
        <Section title={t('datatables.retention_title', 'Rows are deleted after')}>
            <Card>
                <View style={styles.body}>
                    <FilterPills<RetentionChoice>
                        value={editor.choice}
                        onChange={editor.choose}
                        options={windowOptions(t, locked)}
                        accessibilityLabel={t('datatables.retention_title', 'Rows are deleted after')}
                        testID="retention-window"
                    />
                    {editor.custom ? <CustomDays editor={editor} disabled={locked} /> : null}
                    <Text variant="label" tone="secondary">{t('datatables.retention_counted_from', 'Counted from')}</Text>
                    {fields.length ? (
                        <FilterPills<string>
                            value={editor.field}
                            onChange={editor.pickField}
                            options={fields.map((f) => ({ value: f.key, label: f.label, disabled: fieldLocked }))}
                            accessibilityLabel={t('datatables.retention_field', 'Date column the age is measured from')}
                            testID="retention-field"
                        />
                    ) : null}
                    {managed ? (
                        <Text variant="label" tone="tertiary">
                            {t('mobile.datatables.retention_fixed', 'Fixed: the platform fills this table in, so it decides which date the age is counted from.')}
                        </Text>
                    ) : null}
                    {!managed && !hasDates ? (
                        <Text variant="label" tone="tertiary">
                            {t('datatables.retention_no_date_column', 'This table has no date column yet, so there is nothing to count an age from. Add one on the Columns tab first.')}
                        </Text>
                    ) : null}
                    <RuleSentence table={table} columns={columns} field={editor.field} />
                    {editor.feedback ? (
                        <Text variant="caption" tone={editor.feedback.tone === 'error' ? 'warning' : 'secondary'} accessibilityLiveRegion="polite" testID="retention-feedback">
                            {editor.feedback.text}
                        </Text>
                    ) : null}
                </View>
            </Card>
        </Section>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.md } satisfies ViewStyle,
    customBlock: { gap: theme.spacing.xs } satisfies ViewStyle,
    custom: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
    grow: { flex: 1 } satisfies ViewStyle,
});
