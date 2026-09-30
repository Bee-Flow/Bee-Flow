/**
 * "May use" — everything a skill may reach while it is active (the web's
 * CanUseCard): apps (`enabledIntegrations`), routines an agent can call
 * (`allowedAutomationIds`) and knowledge bases (`knowledgeBaseIds`), plus,
 * under "All options", the dynamic-activation switch and the legacy routine
 * note. Grants are re-checked at dispatch; this is where the author SEES them.
 *
 * A list that could not be read is named rather than shown as empty, and a
 * pill whose name is unknown keeps its "Routine {id}" fallback so it does not
 * look deleted.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { INTEGRATION_CATALOG, useUserSettings } from '@/features/integrations';
import { openRoute } from '@/shared/navigation';
import { ActionMenu, Button, Chip, Icon, Section, Text, ToggleRow, type ActionMenuItem, type IconName } from '@/shared/ui';

import { AppsPickerSheet } from './AppsPickerSheet';
import { GrantPill } from './GrantPill';
import type { PickerData } from '../hooks/usePickerData';
import { availableApps, toggleId } from '../model/apps';
import type { SkillDraft } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ pills: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs } });

type Grants = Pick<SkillDraft, 'enabledIntegrations' | 'allowedAutomationIds' | 'knowledgeBaseIds' | 'dynamicActivation'>;

function gapNames(t: TranslateFn, appsFailed: boolean, picker: PickerData): string[] {
    const names: string[] = [];
    if (appsFailed) names.push(t('skills_studio.canuse.gap.apps', 'apps'));
    if (picker.unavailable.includes('routines')) names.push(t('skills_studio.canuse.gap.routines', 'routines'));
    if (picker.unavailable.includes('kbs')) names.push(t('skills_studio.canuse.gap.kbs', 'knowledge bases'));
    return names;
}

type GrantField = 'enabledIntegrations' | 'allowedAutomationIds' | 'knowledgeBaseIds';

interface GrantRow {
    field: GrantField;
    id: string;
    kind: string;
    icon: IconName;
    label: string;
    href: string | null;
}

/** Every grant as a pill, in the web's order: apps, routines, knowledge bases. */
function grantPills(t: TranslateFn, draft: Grants, picker: PickerData): GrantRow[] {
    const nameOf = (rows: readonly { id: string; name: string }[], id: string, key: string, en: string) =>
        rows.find((r) => r.id === id)?.name || t(key, en, { id });
    const apps: GrantRow[] = draft.enabledIntegrations.map((id) => ({
        field: 'enabledIntegrations',
        id,
        kind: 'app',
        icon: 'AppWindow',
        label: INTEGRATION_CATALOG.find((a) => a.id === id)?.label || id,
        href: null,
    }));
    const routines: GrantRow[] = draft.allowedAutomationIds.map((id) => ({
        field: 'allowedAutomationIds',
        id,
        kind: 'automation',
        icon: 'Workflow',
        label: nameOf(picker.routines, id, 'skills_studio.canuse.unknown_routine', 'Routine {id}'),
        href: `/automations/${encodeURIComponent(id)}`,
    }));
    const kbs: GrantRow[] = draft.knowledgeBaseIds.map((id) => ({
        field: 'knowledgeBaseIds',
        id,
        kind: 'kb',
        icon: 'BookOpen',
        label: nameOf(picker.kbs, id, 'skills_studio.canuse.unknown_kb', 'Knowledge base {id}'),
        href: `/knowledge/${encodeURIComponent(id)}`,
    }));
    return [...apps, ...routines, ...kbs];
}

interface LinkMenu {
    draft: Grants;
    picker: PickerData;
    onBrowse: () => void;
    onChange: (next: Partial<Grants>) => void;
}

function linkItems(t: TranslateFn, { draft, picker, onBrowse, onChange }: LinkMenu) {
    const items: ActionMenuItem[] = [{ id: 'apps', label: t('skills_studio.canuse.browse_apps', 'Browse apps…'), icon: 'AppWindow', onPress: onBrowse }];
    if (!picker.loaded) return [...items, { id: 'loading', label: t('skills_studio.canuse.loading', 'Loading…'), disabled: true, onPress: onBrowse }];
    for (const r of picker.routines) {
        if (draft.allowedAutomationIds.includes(r.id)) continue;
        items.push({ id: `a:${r.id}`, label: r.name, icon: 'Workflow', onPress: () => onChange({ allowedAutomationIds: [...draft.allowedAutomationIds, r.id] }) });
    }
    for (const k of picker.kbs) {
        if (draft.knowledgeBaseIds.includes(k.id)) continue;
        items.push({ id: `k:${k.id}`, label: k.name, icon: 'BookOpen', onPress: () => onChange({ knowledgeBaseIds: [...draft.knowledgeBaseIds, k.id] }) });
    }
    if (items.length === 1 && picker.unavailable.length === 0) {
        items.push({
            id: 'none',
            label: t('skills_studio.canuse.nothing', 'Nothing else to link. A routine appears here once its trigger is “an agent calls it”.'),
            disabled: true,
            onPress: onBrowse,
        });
    }
    return items;
}

export function CanUseCard({
    draft,
    picker,
    legacyAutomationId,
    readOnly,
    onChange,
}: {
    draft: Grants;
    picker: PickerData;
    legacyAutomationId: string | null;
    readOnly: boolean;
    onChange: (next: Partial<Grants>) => void;
}) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const [menu, setMenu] = useState(false);
    const [browsing, setBrowsing] = useState(false);
    const settings = useUserSettings();
    const apps = availableApps(INTEGRATION_CATALOG, settings.data?.orgEnabledIntegrations, settings.isSuccess);
    const gaps = gapNames(t, settings.isError, picker);

    return (
        <Section title={t('skills_studio.canuse.title', 'May use')} subtitle={t('skills_studio.canuse.hint', 'within this skill')}>
            <View style={styles.pills}>
                {grantPills(t, draft, picker).map((g) => (
                    <GrantPill
                        key={`${g.field}:${g.id}`}
                        kind={g.kind}
                        icon={g.icon}
                        label={g.label}
                        removeLabel={t('skills_studio.canuse.unlink', 'Unlink {name}', { name: g.label })}
                        onOpen={g.href ? () => openRoute(router, g.href as string) : undefined}
                        onRemove={readOnly ? undefined : () => onChange({ [g.field]: toggleId(draft[g.field], g.id) })}
                    />
                ))}
                {readOnly ? null : (
                    <Chip label={t('skills_studio.canuse.link', 'link')} icon={<Icon name="Plus" size={14} />} onPress={() => setMenu(true)} />
                )}
            </View>
            {gaps.length > 0 ? (
                <>
                    <Text variant="caption" tone="warning">
                        {t('skills_studio.canuse.unread', 'Could not be read: {lists}. That is not “you have none” — what is missing is left out here rather than shown as empty.', { lists: gaps.join(', ') })}
                    </Text>
                    <Button size="sm" variant="secondary" label={t('skills_studio.canuse.retry', 'Try again')} onPress={() => { picker.reload(); void settings.refetch(); }} />
                </>
            ) : null}
            <ToggleRow
                gutter={false}
                label={t('skills_studio.field.dynamic_label', 'Dynamic activation')}
                description={t('skills_studio.field.dynamic_help', 'When on, the agent decides at runtime whether to apply this skill based on the user message.')}
                value={draft.dynamicActivation}
                disabled={readOnly}
                onValueChange={(dynamicActivation) => onChange({ dynamicActivation })}
            />
            {legacyAutomationId ? (
                <Text variant="caption" tone="secondary">
                    {t('skills_studio.options.legacy_automation', 'This skill runs routine {id} instead of its own steps. Steps, rules and examples are ignored while that is set.', { id: legacyAutomationId })}
                </Text>
            ) : null}
            <ActionMenu visible={menu} onClose={() => setMenu(false)} title={t('skills_studio.canuse.link', 'link')}
                items={linkItems(t, { draft, picker, onBrowse: () => setBrowsing(true), onChange })} />
            <AppsPickerSheet visible={browsing} onClose={() => setBrowsing(false)} apps={apps} enabled={draft.enabledIntegrations}
                narrowed={!settings.isSuccess} onToggle={(id) => onChange({ enabledIntegrations: toggleId(draft.enabledIntegrations, id) })} />
        </Section>
    );
}
