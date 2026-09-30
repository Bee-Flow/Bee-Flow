/**
 * Compliance settings (web: pages/SettingsPage + settings/*): the facts every
 * framework reads, one group per framework. A group whose framework is off is
 * folded behind one switch, as the web folds it. The SaveBar sends only the
 * changed columns; before setup is finished the first save also stamps it
 * (POST /settings/onboarded — the web's setup card), and the scan runs.
 * Back with changed columns asks before dropping them.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirmLeave, useUserRefresh } from '@/shared/patterns';
import { Banner, ErrorState, Group, GroupedScroll, LoadingState, SaveBar, ToggleRow, useToast } from '@/shared/ui';

import { SettingInput } from './SettingInput';
import { useFrameworkRelevance, useSaveComplianceSettings } from '../hooks/mutations';
import { useComplianceSettings, useFrameworks, useOrgUsers } from '../hooks/queries';
import { labelText } from '../model/fields';
import { contactCount, normaliseSettings, settingsErrors, settingsPatch, type SettingsForm } from '../model/settings';
import { SETTING_GROUPS, type SettingField } from '../model/settingsFields';

const ROW_KINDS = new Set(['toggle', 'stamp', 'contacts']);

export function SettingsView() {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const settings = useComplianceSettings(true);
    const frameworks = useFrameworks(true);
    const users = useOrgUsers(true);
    const save = useSaveComplianceSettings();
    const relevance = useFrameworkRelevance();
    const refresh = useUserRefresh(() => settings.refetch());
    const [edits, setEdits] = useState<SettingsForm>({});
    const [showOff, setShowOff] = useState(false);
    const base = settings.data ? normaliseSettings(settings.data) : null;
    const form = { ...base, ...edits };
    const patch = base ? settingsPatch(base, form) : {};
    useConfirmLeave(Object.keys(patch).length > 0);

    if (settings.isLoading) return <LoadingState />;
    if (settings.isError || !settings.data) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
    const stored = settings.data;
    const invalid = settingsErrors(form).length > 0;
    const onboarded = Boolean(stored.onboarded_at);
    const fwList = frameworks.data?.frameworks ?? [];
    const isOn = (id: string) => id === 'gdpr' || id === 'aia' || fwList.some((f) => f.id === id && f.enabled);
    const groups = SETTING_GROUPS.filter((g) => showOff || isOn(g.framework));

    const onSave = async () => {
        try {
            await save.mutateAsync({ patch, onboarded });
            setEdits({});
            toast(onboarded ? t('compliance.toast_settings_saved', 'Settings saved — running checks again…') : t('compliance.toast_wizard_done', 'Setup complete — your first compliance scan is running'), 'success');
        } catch (err) {
            toast(describeError(err).message || t('compliance.toast_settings_failed', 'Could not save settings'), 'error');
        }
    };
    const onRelevance = (field: SettingField, next: string) =>
        relevance.mutateAsync({ id: field.name, relevance: next }).catch((err: unknown) => toast(describeError(err).message, 'error'));

    const input = (field: SettingField) => {
        if (field.dependsOn && form[field.dependsOn] !== true) return null;
        const node = (
            <SettingInput
                key={field.name}
                field={field}
                value={form[field.name]}
                onChange={(next) => setEdits((prev) => ({ ...prev, [field.name]: next }))}
                users={users.data ?? []}
                relevance={fwList.find((f) => f.id === field.name)?.relevance ?? null}
                onRelevance={(next) => void onRelevance(field, next)}
                contacts={contactCount(stored, field.name)}
            />
        );
        return ROW_KINDS.has(field.kind) ? node : <View key={field.name} style={styles.inset}>{node}</View>;
    };

    return (
        <>
            <GroupedScroll refresh={refresh} keyboardShouldPersistTaps="handled">
                {onboarded ? null : <Banner tone="info">{t('compliance.setup_finish', 'Finish setup and run the first scan')}</Banner>}
                {groups.map((g) => (
                    <Group key={g.id} title={labelText(g.title, t)} footer={labelText(g.description, t)}>
                        {g.fields.map(input)}
                    </Group>
                ))}
                <Group>
                    <ToggleRow
                        testID="settings-show-off"
                        label={t('mobile.compliance.show_off_groups', 'Show settings of frameworks that are off')}
                        value={showOff}
                        onValueChange={setShowOff}
                    />
                </Group>
            </GroupedScroll>
            <SaveBar
                dirty={Object.keys(patch).length > 0 || !onboarded}
                saving={save.isPending}
                blockedReason={invalid ? t('mobile.compliance.settings_invalid', 'Check the numbers and the dates (YYYY-MM-DD).') : null}
                onSave={() => void onSave()}
                onDiscard={() => setEdits({})}
            />
        </>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ inset: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm } });
