/**
 * One Solution — a project, opened as the object it is: the web's Studio
 * SolutionDetail (Content, Check, Versions, Installs, Flow, Overview) and the
 * collaboration half of its project page (Chats, Members, Activity) under one
 * ObjectHeader, because on a phone they are one thing with one back button.
 *
 * The publish gate is read before any tab opens — it is not a property of the
 * tab that happens to be showing — and the update banner sits above every
 * tab, because "a newer version exists" is about the Solution.
 *
 * Route param `tab` opens a section directly (a deep link, a notification).
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { QueryScreen, type DetailQuery } from '@/shared/patterns';
import { ScreenHeader } from '@/shared/ui';

import { ProjectFormSheet } from '../components/ProjectFormSheet';
import { PublishSheet } from '../components/PublishSheet';
import { SolutionBody } from '../components/SolutionBody';
import { SolutionHeader } from '../components/SolutionHeader';
import { SolutionMenu, type SolutionSheet } from '../components/SolutionMenu';
import { UpdateBanner } from '../components/UpdateBanner';
import { UpgradeSheet } from '../components/UpgradeSheet';
import { useUpdateProject } from '../hooks/mutations';
import { useSolution, type SolutionState } from '../hooks/useSolution';
import { draftFrom } from '../model/form';
import { activeTab, isSolutionTab, visibleTabs, type SolutionTab } from '../model/tabs';
import type { ProjectDetail } from '../model/types';

/** The three sheets the header and the menu open. A new key per opening re-seeds each. */
function Sheets({ detail, sol, open, onClose }: { detail: ProjectDetail; sol: SolutionState; open: { sheet: SolutionSheet; key: number } | null; onClose: () => void }) {
    const update = useUpdateProject(detail.id, detail.version);
    const upgrade = open?.sheet === 'upgrade' ? sol.availability : null;
    return (
        <>
            <ProjectFormSheet
                key={`edit-${open?.key ?? 0}`}
                visible={open?.sheet === 'edit'}
                initial={draftFrom(detail)}
                onClose={onClose}
                onSubmit={(draft) => update.mutateAsync(draft).then(onClose)}
            />
            <PublishSheet key={`publish-${open?.key ?? 0}`} projectId={detail.id} visible={open?.sheet === 'publish'} onClose={onClose} />
            <UpgradeSheet
                key={`upgrade-${open?.key ?? 0}`}
                projectId={detail.id}
                blueprintId={upgrade?.blueprintId ?? null}
                latestVersion={upgrade?.latestVersion ?? null}
                onClose={onClose}
            />
        </>
    );
}

export function ProjectDetailScreen({ id, initialTab }: { id: string; initialTab?: string }) {
    const t = useTranslation();
    const sol = useSolution(id);
    const [wanted, setWanted] = useState<SolutionTab>(isSolutionTab(initialTab) ? initialTab : 'content');
    const [menu, setMenu] = useState(false);
    const [open, setOpen] = useState<{ sheet: SolutionSheet; key: number } | null>(null);
    const tabs = visibleTabs(sol);
    const tab = activeTab(wanted, tabs);
    const showSheet = (sheet: SolutionSheet) => setOpen({ sheet, key: Date.now() });

    const { project } = sol;
    const query: DetailQuery<ProjectDetail> = {
        data: project.data ?? undefined,
        isLoading: project.isLoading,
        isError: project.isError || (project.isSuccess && !project.data),
        error: project.error ?? new Error(t('mobile.projects.not_found', 'This Solution could not be loaded.')),
        refetch: project.refetch,
    };

    return (
        <QueryScreen
            query={query}
            scroll={false}
            header={(detail) =>
                detail ? (
                    <SolutionHeader
                        name={detail.name}
                        icon={detail.icon}
                        sol={sol}
                        tabs={tabs}
                        active={tab}
                        onTab={setWanted}
                        onPublish={() => showSheet('publish')}
                        onMenu={() => setMenu(true)}
                    />
                ) : (
                    <ScreenHeader title={t('solutions.title', 'Solutions')} />
                )
            }
        >
            {(detail) => (
                <>
                    <UpdateBanner availability={sol.availability} onOpen={sol.isOwner ? () => showSheet('upgrade') : undefined} />
                    <SolutionBody id={id} tab={tab} sol={sol} onTab={setWanted} />
                    <SolutionMenu id={id} name={detail.name} sol={sol} visible={menu} onClose={() => setMenu(false)} onSheet={showSheet} />
                    <Sheets detail={detail} sol={sol} open={open} onClose={() => setOpen(null)} />
                </>
            )}
        </QueryScreen>
    );
}
