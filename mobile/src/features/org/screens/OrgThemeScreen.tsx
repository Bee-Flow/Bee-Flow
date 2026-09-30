/**
 * The organisation theme (web: the Theme Studio's Look editor,
 * appearance/studio/look/*): preset, accent, typography, corner roundness and
 * whether members may override it — plus the icon pack switcher.
 *
 * Like the web (useLookForm.js) the form is built from `/api/branding/admin`,
 * the RAW organisation default, never from the merged theme this device
 * shows, so an admin's own override cannot leak into the org's. Only the
 * changed knobs are sent; the server merges them, so the wallpaper and glass
 * knobs (web-only: they apply to the glass presets) keep their values. A
 * save repaints this app at once by refreshing the branding query it reads.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Group, SaveBar, SettingRow, useToast } from '@/shared/ui';

import { AccentGroup } from '../components/AccentGroup';
import { IconPacksSheet } from '../components/IconPacksSheet';
import { OrgSettingsFrame } from '../components/OrgSettingsFrame';
import { ThemeDetailsGroups } from '../components/ThemeDetailsGroups';
import { ThemePresetGroup } from '../components/ThemePresetGroup';
import { useActivateIconPack, useSaveOrgTheme } from '../hooks/sectionMutations';
import { useIconPacks, useOrgTheme } from '../hooks/sectionQueries';
import { useDraft } from '../hooks/useDraft';
import { useOrgContext } from '../hooks/useOrgSections';

export function OrgThemeScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const { orgId, isOrgAdmin } = useOrgContext();
    const allowed = isOrgAdmin && Boolean(orgId);
    const [iconsOpen, setIconsOpen] = useState(false);
    const query = useOrgTheme(allowed);
    const save = useSaveOrgTheme();
    const icons = useIconPacks(allowed);
    const activate = useActivateIconPack();
    const form = useDraft(query.data);

    const onSave = async () => {
        try {
            await save.mutateAsync(form.patch);
            form.reset();
            toast(t('mobile.org.theme_saved', 'Theme saved as organisation default'), 'success');
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    const onPickPack = (packId: string | null) => {
        activate.mutate(packId, {
            onSuccess: () => setIconsOpen(false),
            onError: (err) => toast(describeError(err).message, 'error'),
        });
    };

    const activePack = icons.data?.packs.find((p) => p.id === icons.data?.activeIconPackId);

    return (
        <OrgSettingsFrame
            title={t('mobile.org.section_theme', 'Theme')}
            subtitle={t('mobile.org.theme_subtitle', 'The look everyone in the organisation starts from')}
            allowed={allowed}
            query={query}
            onRefresh={() => void icons.refetch()}
            dirty={form.dirty}
            footer={<SaveBar dirty={form.dirty} saving={save.isPending} onSave={() => void onSave()} onDiscard={form.reset} />}
        >
            {(server) => {
                const theme = form.draft ?? server;
                return (
                    <>
                        <ThemePresetGroup value={theme.preset} onChange={(v) => form.set('preset', v)} disabled={save.isPending} />
                        <AccentGroup value={theme.accent} onChange={(v) => form.set('accent', v)} disabled={save.isPending} />
                        <ThemeDetailsGroups theme={theme} onChange={form.set} disabled={save.isPending} />
                        <Group title={t('mobile.org.icons_title', 'Icon pack')}>
                            <SettingRow
                                testID="icon-pack-row"
                                label={t('mobile.org.icons_title', 'Icon pack')}
                                value={activePack?.name ?? t('mobile.org.icons_default', 'Built-in icons')}
                                onPress={() => setIconsOpen(true)}
                            />
                        </Group>
                        <IconPacksSheet
                            visible={iconsOpen}
                            packs={icons.data}
                            saving={activate.isPending}
                            onPick={onPickPack}
                            onClose={() => setIconsOpen(false)}
                        />
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
