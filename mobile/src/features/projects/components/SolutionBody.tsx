/**
 * The open tab of a Solution. Each tab owns its queries, so a tab that is
 * never opened never fetches (the graph, the history, the activity trail).
 */

import React from 'react';

import { ActivityTab } from './ActivityTab';
import { ChatsTab } from './ChatsTab';
import { CheckTab } from './CheckTab';
import { ContentTab } from './ContentTab';
import { FlowTab } from './FlowTab';
import { InstallsTab } from './InstallsTab';
import { MembersTab } from './MembersTab';
import { OverviewTab } from './OverviewTab';
import { VersionsTab } from './VersionsTab';
import { useOpenLink } from '../hooks/useOpenLink';
import type { SolutionState } from '../hooks/useSolution';
import type { SolutionTab } from '../model/tabs';

export function SolutionBody({ id, tab, sol, onTab }: { id: string; tab: SolutionTab; sol: SolutionState; onTab: (tab: SolutionTab) => void }) {
    const openLink = useOpenLink();
    switch (tab) {
        case 'control':
            return <CheckTab sol={sol} />;
        case 'versions':
            return <VersionsTab id={id} />;
        case 'installs':
            return <InstallsTab id={id} />;
        case 'flow':
            return <FlowTab id={id} onOpen={openLink} />;
        case 'overview':
            return <OverviewTab id={id} sol={sol} onTab={onTab} />;
        case 'chats':
            return <ChatsTab id={id} />;
        case 'members':
            return <MembersTab id={id} sol={sol} />;
        case 'activity':
            return <ActivityTab id={id} />;
        default:
            return <ContentTab id={id} sol={sol} />;
    }
}
