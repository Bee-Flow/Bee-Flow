/**
 * Studio — the Studio tab. Everyone gets its Workspace group (Cowork, Apps,
 * Forms, Notebooks), handed in by the host as `workspace`. A builder (the
 * web's canSeeStudio) also gets the web's Studio Start (StudioStart.jsx) on a
 * phone: search, what needs attention, what you edited last, every section
 * you may open grouped as the web groups them, and the one "New" menu.
 *
 * The sections come from the registry through one gate resolution
 * (hooks/useStudioNav), so the hub and the tab bar cannot disagree about what
 * this person may build. Every built-in section opens a native screen, and
 * the New menu's AI row opens the building-block picker (DescribeItSheet).
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { BlockList, useUserRefresh } from '@/shared/patterns';
import { Button, Screen, ScreenHeader } from '@/shared/ui';

import { DescribeItSheet } from '../components/DescribeItSheet';
import { hubBlocks } from '../components/hubBlocks';
import { NewMenuSheet } from '../components/NewMenuSheet';
import { useRecentWork, useRefreshStudio, useStudioAttention, useStudioCounts } from '../hooks/queries';
import { useOpenTarget } from '../hooks/useOpenTarget';
import { useStudioNav } from '../hooks/useStudioNav';
import { sectionTarget } from '../model/links';
import { buildNewMenu } from '../model/newMenu';
import { nOf } from '../model/plural';
import type { HubLink, ResolvedSection } from '../model/types';

export interface StudioScreenProps {
    /** The Workspace rows (features/shell decides them); none draws no group. */
    workspace?: readonly HubLink[];
}

const NO_LINKS: readonly HubLink[] = [];
const NO_SECTIONS: readonly ResolvedSection[] = [];

function useMakersLine(makers: number | null | undefined): string | undefined {
    const t = useTranslation();
    if (makers === null || makers === undefined) return undefined;
    if (makers === 0) return t('studio.makers_none', 'Nothing you can see here yet');
    return nOf(t, 'studio.makers', makers, ['{count} maker', '{count} makers']);
}

export function StudioScreen({ workspace = NO_LINKS }: StudioScreenProps) {
    const t = useTranslation();
    const nav = useStudioNav();
    const builder = nav.canSee;
    // Someone without Studio proper pays for none of its reads.
    const counts = useStudioCounts(builder);
    const attention = useStudioAttention(builder);
    const recent = useRecentWork(builder ? nav.sections : NO_SECTIONS);
    // A pull re-reads all of it, "Recently edited" included.
    const refresh = useUserRefresh(useRefreshStudio());
    const open = useOpenTarget();
    // One sheet at a time: the New menu, or the Describe-it sheet its AI row opens.
    const [sheet, setSheet] = useState<'menu' | 'describe' | null>(null);
    const subtitle = useMakersLine(builder ? counts.data?.makers : null);

    const blocks = hubBlocks({
        workspace,
        builder,
        groups: nav.groups,
        counts: counts.data,
        attention: attention.data,
        recent,
        onOpen: (section) => open(sectionTarget(section)),
        onOpenLink: (link) => open({ kind: 'route', href: link.href }),
        t,
    });

    return (
        <Screen edges={['top']}>
            <ScreenHeader
                size="large"
                title={t('studio.sidebar_link', 'Studio')}
                subtitle={subtitle}
                actions={
                    builder ? (
                        <Button
                            label={t('studio.new.button', 'New')}
                            iconName="Plus"
                            size="sm"
                            variant="ghost"
                            onPress={() => setSheet('menu')}
                            accessibilityHint={t('studio.new.open_menu', 'Open the New menu')}
                            testID="studio-new"
                        />
                    ) : undefined
                }
            />
            <BlockList
                testID="studio-hub"
                blocks={blocks}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
            />
            <NewMenuSheet
                visible={sheet === 'menu'}
                onClose={() => setSheet(null)}
                onDescribe={() => setSheet('describe')}
                entries={buildNewMenu(nav.sections)}
            />
            {/* Keyed per opening, so every opening starts with an empty field. */}
            <DescribeItSheet
                key={sheet === 'describe' ? 'describe-open' : 'describe-closed'}
                visible={sheet === 'describe'}
                onClose={() => setSheet(null)}
                sections={nav.sections}
            />
        </Screen>
    );
}
