/**
 * The Solutions overview — the web's Studio → Solutions (SolutionsOverview):
 * three tabs and a card per Solution.
 *
 *   From us     the Solutions built here
 *   Installed   the ones that came out of a Blueprint
 *   Catalogue   the Blueprints kept on this instance, ready to install
 *
 * The first two partition everything GET /api/projects/summary returned, on
 * ONE fact — did it come from a Blueprint — so a Solution shared with you
 * lands in "From us" instead of vanishing. A Solution IS a project: the
 * drawer's Projects row and the Studio's Solutions section both open here.
 *
 * Route params: `tab` (ours | installed | catalogue) and `create=1`, which
 * opens the New Solution sheet — the Studio New menu's target.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useHasLicenseFeature } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Screen, ScreenHeader, Segmented, useToast } from '@/shared/ui';

import { CatalogueList } from '../components/CatalogueList';
import { InstallSheet, type InstallChoice } from '../components/InstallSheet';
import { ProjectFormSheet } from '../components/ProjectFormSheet';
import { SolutionList } from '../components/SolutionList';
import { useCreateProject } from '../hooks/mutations';
import { useSolutionSummary } from '../hooks/solutionQueries';
import { pickBlueprintFile } from '../model/blueprintFile';
import { partitionSolutions } from '../model/overview';

type Tab = 'ours' | 'installed' | 'catalogue';

function toTab(value: string | undefined): Tab {
    return value === 'installed' || value === 'catalogue' ? value : 'ours';
}

/** Reads a Blueprint file off the device and says what went wrong in words. */
function useFileInstall(onChoice: (choice: InstallChoice) => void) {
    const t = useTranslation();
    const { toast } = useToast();
    return async () => {
        const picked = await pickBlueprintFile();
        if (picked.kind === 'ok') {
            onChoice({ source: { manifest: picked.manifest }, title: picked.fileName.replace(/\.json$/i, ''), version: null });
        } else if (picked.kind === 'not-a-blueprint') {
            toast(t('projects.blueprint_not_json', 'That file is not a Blueprint.'), 'error');
        } else if (picked.kind === 'too-large') {
            toast(t('mobile.projects.blueprint_too_large', 'That file is too large to be a Blueprint.'), 'error');
        }
    };
}

export function ProjectsScreen({ initialTab, create = false }: { initialTab?: string; create?: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const packaging = useHasLicenseFeature('blueprint_packaging');
    const summary = useSolutionSummary();
    const [tab, setTab] = useState<Tab>(toTab(initialTab));
    // A new key per opening re-seeds the form.
    const [creating, setCreating] = useState<number | null>(create ? 1 : null);
    const [install, setInstall] = useState<{ key: number; choice: InstallChoice } | null>(null);
    const open = (id: string) => router.push(`/projects/${encodeURIComponent(id)}`);
    const created = useCreateProject({
        onSuccess: (project) => {
            setCreating(null);
            open(project.id);
        },
    });
    const choose = (choice: InstallChoice) => setInstall({ key: Date.now(), choice });
    const fromFile = useFileInstall(choose);
    const installed = summary.data ? partitionSolutions(summary.data.rows).installed.length : null;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={t('solutions.title', 'Solutions')}
                subtitle={t('mobile.projects.overview_subtitle', 'Projects, and everything each one bundles')}
            />
            <View style={styles.toolbar}>
                <View style={styles.actions}>
                    <Button label={t('solutions.new', 'New Solution')} iconName="Plus" size="sm" onPress={() => setCreating(Date.now())} testID="solutions-create" />
                    {packaging ? (
                        <Button label={t('projects.blueprint_install', 'Install a Blueprint')} iconName="Import" size="sm" variant="secondary" onPress={() => void fromFile()} />
                    ) : null}
                </View>
                <Segmented
                    value={tab}
                    onChange={setTab}
                    fullWidth
                    accessibilityLabel={t('solutions.title', 'Solutions')}
                    options={[
                        { value: 'ours', label: t('solutions.tab_ours', 'From us') },
                        // No count until the read succeeded: a "0" over a failed request is the claim this screen may not make.
                        { value: 'installed', label: t('solutions.tab_installed', 'Installed'), count: summary.isSuccess ? installed : null },
                        ...(packaging ? [{ value: 'catalogue' as const, label: t('solutions.tab_catalogue', 'Catalogue') }] : []),
                    ]}
                />
            </View>
            {tab === 'catalogue' && packaging ? (
                <CatalogueList onInstall={(b) => choose({ source: { blueprintId: b.id }, title: b.name, version: b.version })} />
            ) : (
                <SolutionList query={summary} tab={tab === 'installed' ? 'installed' : 'ours'} onOpen={(row) => open(row.id)} />
            )}
            <ProjectFormSheet
                key={`create-${creating ?? 0}`}
                visible={creating !== null}
                onClose={() => setCreating(null)}
                onSubmit={(draft) => created.mutateAsync(draft)}
            />
            <InstallSheet
                key={`install-${install?.key ?? 0}`}
                choice={install?.choice ?? null}
                onClose={() => setInstall(null)}
                onOpen={(id) => {
                    setInstall(null);
                    open(id);
                }}
            />
        </Screen>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        toolbar: { gap: theme.spacing.md, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    });
