/**
 * The New form under a composed recipe: the playbook's name, where the rows
 * go (a new table or one that exists — its columns are checked in the first
 * phase), the recipe's own inputs (a Nextcloud folder, a text), who approves
 * when the recipe has an approval phase, and the model tier every phase is
 * built on.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { OptionRow, Segmented, Spinner, Text, TextField } from '@/shared/ui';

import { ApproverPicker } from './ApproverPicker';
import { usePlaybookTiers, useTableChoices } from '../hooks/queries';
import { MAX_TITLE, folderProblem, hasTable, tierEnglish, tierKey, type NewPlaybookForm, type TableMode } from '../model/newPlaybook';
import type { Recipe } from '../model/types';

function TablePicker({ value, onPick }: { value: string; onPick: (id: string) => void }) {
    const t = useTranslation();
    const tables = useTableChoices(true);
    if (tables.isLoading) return <Spinner />;
    return (
        <View>
            {(tables.data ?? []).map((table) => (
                <OptionRow
                    key={table.id}
                    label={table.name || table.id}
                    description={[
                        table.rowCount !== null ? String(table.rowCount) : null,
                        table.managedKind === 'nextcloud_table' ? 'Nextcloud' : null,
                    ].filter(Boolean).join(' · ') || undefined}
                    selected={value === table.id}
                    onPress={() => onPick(table.id)}
                    testID={`playbook-table-${table.id}`}
                />
            ))}
            <Text variant="caption" tone="tertiary">
                {t('playbooks.new.table_existing_hint', 'Own table or a Nextcloud mirror — you need edit rights; its columns are checked in the first phase.')}
            </Text>
        </View>
    );
}

export function PlaybookOptions({
    recipe,
    form,
    onChange,
}: {
    recipe: Recipe;
    form: NewPlaybookForm;
    onChange: (next: NewPlaybookForm) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const tiers = usePlaybookTiers();
    const set = (patch: Partial<NewPlaybookForm>) => onChange({ ...form, ...patch });
    return (
        <View style={styles.form}>
            <TextField
                label={t('playbooks.new.name', 'Name')}
                value={form.title}
                onChangeText={(title) => set({ title })}
                maxLength={MAX_TITLE}
                testID="playbook-title"
            />
            {hasTable(recipe) ? (
                <View style={styles.group}>
                    <Text variant="label" tone="secondary">
                        {t('playbooks.new.table_mode_generic', 'Where the rows go')}
                    </Text>
                    <Segmented<TableMode>
                        value={form.tableMode}
                        onChange={(tableMode) => set({ tableMode })}
                        accessibilityLabel={t('playbooks.new.table_mode_generic', 'Where the rows go')}
                        options={[
                            { value: 'new', label: t('playbooks.new.table_new', 'A new table') },
                            { value: 'existing', label: t('playbooks.new.table_existing', 'An existing table') },
                        ]}
                    />
                    {form.tableMode === 'existing' ? <TablePicker value={form.datatableId} onPick={(datatableId) => set({ datatableId })} /> : null}
                </View>
            ) : null}
            {recipe.inputs.map((input) => (
                <TextField
                    key={input.key}
                    label={input.label}
                    value={form.inputs[input.key] ?? ''}
                    onChangeText={(value) => set({ inputs: { ...form.inputs, [input.key]: value } })}
                    placeholder={input.placeholder ?? (input.kind === 'folder' ? '/Invoices' : undefined)}
                    autoCapitalize="none"
                    error={folderProblem(input, form.inputs[input.key]) ? t('playbooks.new.err_folder', 'The folder is an absolute Nextcloud path, e.g. /Invoices.') : null}
                    testID={`playbook-input-${input.key}`}
                />
            ))}
            {recipe.needsApprover ? <ApproverPicker value={form.approverGroupId} onPick={(approverGroupId) => set({ approverGroupId })} /> : null}
            <View style={styles.group}>
                <Text variant="label" tone="secondary">
                    {t('playbooks.new.tier', 'Model')}
                </Text>
                <Segmented
                    value={tiers.includes(form.tier) ? form.tier : (tiers[0] ?? 'fast')}
                    onChange={(tier) => set({ tier })}
                    accessibilityLabel={t('playbooks.new.tier', 'Model')}
                    options={tiers.map((tier) => ({ value: tier, label: t(tierKey(tier), tierEnglish(tier)) }))}
                />
                <Text variant="caption" tone="tertiary">
                    {t('playbooks.new.tier_hint_generic', 'Every phase of this playbook is built on the tier you pick here; Auto picks one per turn.')}
                </Text>
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    form: { gap: theme.spacing[4] },
    group: { gap: theme.spacing[2] },
});
