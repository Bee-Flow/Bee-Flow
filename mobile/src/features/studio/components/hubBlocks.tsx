/**
 * The Studio hub as blocks for BlockList. For a builder, the web Start
 * screen's order (StudioStart.jsx) around the phone's Workspace group:
 * search, what needs a person (one compact card), the Workspace group (Cowork,
 * Apps, Forms, Notebooks — what everyone opens), where you left off, and every
 * section under its Build / AI / Bundle heading with its count and, when
 * locked, the reason. Someone who does not build gets the Workspace group.
 *
 * The groups and their rows come from model/menu.studioMenuGroups — the list
 * the drawer's Studio menu draws too.
 */

import React from 'react';

import type { TranslateFn } from '@/core/i18n';
import { cardRows, type Block } from '@/shared/patterns';
import { navCount, SectionLabel } from '@/shared/ui';

import { AttentionCard } from './AttentionCard';
import { HubRow } from './HubRow';
import { RecentCard } from './RecentCard';
import { SearchEntry } from './SearchEntry';
import { SectionRow } from './SectionRow';
import type { StudioAttention, StudioCounts } from '../model/api';
import { studioMenuGroups, WORKSPACE_GROUP_ID, type StudioMenuGroup, type StudioMenuRow } from '../model/menu';
import type { RecentWork } from '../model/recent';
import type { HubLink, ResolvedSection, StudioGroup } from '../model/types';

export interface HubInput {
    /** The Workspace rows, gated by the host; empty draws no group. */
    workspace: readonly HubLink[];
    /** canSeeStudio: search, attention, recent work and the sections. */
    builder: boolean;
    groups: readonly StudioGroup[];
    counts: StudioCounts | undefined;
    attention: StudioAttention | undefined;
    recent: RecentWork;
    onOpen: (section: ResolvedSection) => void;
    onOpenLink: (link: HubLink) => void;
    t: TranslateFn;
}

const block = (key: string, gap: Block['gap'], render: Block['render']): Block => ({ key, gap, render });

function MenuRow({ row, input }: { row: StudioMenuRow; input: HubInput }) {
    if (row.kind === 'section') {
        const { section } = row;
        return <SectionRow section={section} count={input.counts?.counts[section.countKey]} onPress={() => input.onOpen(section)} />;
    }
    const { link } = row;
    return (
        <HubRow
            testID={`studio-link-${link.id}`}
            icon={link.icon}
            label={link.label}
            description={link.description}
            count={navCount(link.count)}
            onPress={() => input.onOpenLink(link)}
        />
    );
}

function groupBlocks(group: StudioMenuGroup, gap: Block['gap'], input: HubInput): Block[] {
    return [
        block(`heading:${group.id}`, gap, () => <SectionLabel label={input.t(group.labelKey, group.labelFallback)} />),
        ...cardRows({
            key: `rows:${group.id}`,
            rows: group.rows,
            rowKey: (row) => row.id,
            gap: 'none',
            render: (row) => <MenuRow row={row} input={input} />,
        }),
    ];
}

export function hubBlocks(input: HubInput): Block[] {
    const { attention, recent, builder } = input;
    const groups = studioMenuGroups(input);
    const workspace = groups.filter((g) => g.id === WORKSPACE_GROUP_ID);
    const sections = groups.filter((g) => g.id !== WORKSPACE_GROUP_ID);
    if (!builder) return workspace.flatMap((g) => groupBlocks(g, 'none', input));
    return [
        block('search', 'none', () => <SearchEntry />),
        ...(attention ? [block('attention', 'inner', () => <AttentionCard attention={attention} />)] : []),
        ...workspace.flatMap((g) => groupBlocks(g, 'inner', input)),
        block('recent', 'inner', () => <RecentCard work={recent} />),
        ...sections.flatMap((g) => groupBlocks(g, 'inner', input)),
    ];
}
