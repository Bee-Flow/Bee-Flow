/**
 * One Solution's header — the web's StudioSectionHeader for a Solution: the
 * kind tile, the name, the Blueprint version chip (only when one publisher's
 * series exists), Publish as the one primary action, the overflow menu, and
 * the tab strip with the Check and Installs counts.
 *
 * Publish is shown to the owner on a plan with Blueprint packaging, and is
 * live only when the checks said `blocked: false` — a failed or unfinished
 * check keeps it shut.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Button, Icon, IconButton, ObjectHeader, resolveAppIcon, type TabBarItem } from '@/shared/ui';

import type { SolutionState } from '../hooks/useSolution';
import { roleLabel } from '../model/people';
import type { SolutionTab } from '../model/tabs';

function tabLabel(tab: SolutionTab, t: TranslateFn): string {
    switch (tab) {
        case 'content':
            return t('solutions.tab_content', 'Content');
        case 'control':
            return t('solutions.tab_control', 'Check');
        case 'versions':
            return t('solutions.tab_versions', 'Versions');
        case 'installs':
            return t('solutions.tab_installs', 'Installs');
        case 'flow':
            return t('solutions.tab_flow', 'Flow');
        case 'overview':
            return t('solutions.tab_overview', 'Overview');
        case 'chats':
            return t('mobile.projects.tab_chats', 'Chats');
        case 'members':
            return t('mobile.projects.tab_members', 'Members');
        default:
            return t('mobile.projects.tab_activity', 'Activity');
    }
}

export function SolutionHeader({
    name,
    icon,
    sol,
    tabs,
    active,
    onTab,
    onPublish,
    onMenu,
}: {
    name: string;
    icon: string | null;
    sol: SolutionState;
    tabs: readonly SolutionTab[];
    active: SolutionTab;
    onTab: (tab: SolutionTab) => void;
    onPublish: () => void;
    onMenu: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const counts: Partial<Record<SolutionTab, number | null>> = { control: sol.checkCount, installs: sol.installCount };
    const items: TabBarItem<SolutionTab>[] = tabs.map((tab) => ({ id: tab, label: tabLabel(tab, t), count: counts[tab] ?? null }));
    const glyph = resolveAppIcon(icon, 'Package');
    const status = sol.version
        ? t('solutions.blueprint_version', 'Blueprint v{version}', { version: sol.version })
        : roleLabel(sol.role, t);

    return (
        <ObjectHeader
            kind="solution"
            icon={glyph.kind === 'icon' ? glyph.name : null}
            title={name}
            status={status}
            backLabel={t('solutions.back', 'All Solutions')}
            tabs={items}
            activeTab={active}
            onTab={onTab}
            primary={
                sol.isOwner && sol.packaging ? (
                    <Button
                        label={t('solutions.publish', 'Publish')}
                        iconName="Upload"
                        size="sm"
                        disabled={!sol.canPublish}
                        onPress={onPublish}
                        accessibilityHint={sol.canPublish ? undefined : t('solutions.publish_blocked', 'Not while there are things to fix — or while the checks could not be run.')}
                        testID="solution-publish"
                    />
                ) : undefined
            }
            extras={
                <IconButton
                    icon={<Icon name="EllipsisVertical" size={20} color={theme.colors.textSecondary} />}
                    accessibilityLabel={t('common.actions', 'Actions')}
                    onPress={onMenu}
                    testID="solution-menu"
                />
            }
        />
    );
}
