import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import LicenseContext from '@/components/licensing/LicenseContext';
import GroupSettings from './GroupSettings';
import OrgMemberRow from './OrgMemberRow';
import type { OrgGroups } from '../useOrgGroups';
import type { OrgMemberRoles } from '../useOrgMemberRoles';

const GROUP_LABEL = 'AI budget per member per month (€)';
const USER_LABEL = 'Monthly AI budget (€)';

function withMode(mode: string, ui: React.ReactNode) {
    return render(<LicenseContext.Provider value={{ deploymentMode: mode } as never}>{ui}</LicenseContext.Provider>);
}

const groupUi = (
    <GroupSettings
        group={{ id: 'g1', name: 'Team', perUserCostLimit: 25 }}
        customTiersMeta={[]}
        groupsState={{ handleUpdateGroupCostLimit: vi.fn(), handleUpdateGroupRole: vi.fn(), handleUpdateGroupAllowedTiers: vi.fn() } as unknown as OrgGroups}
    />
);

const rowUi = (
    <OrgMemberRow
        member={{ id: 'u1', username: 'jan', status: 'active', monthlyCostLimit: 10 }}
        orgGroups={[]}
        usage={undefined}
        groupsState={{} as OrgGroups}
        memberRoles={{ editingUserRole: null, handleUpdateUserCostLimit: vi.fn() } as unknown as OrgMemberRoles}
        onCreateGroup={vi.fn()}
    />
);

describe('budget editor placement', () => {
    it('GroupSettings shows it when self-hosted', () => {
        withMode('self-hosted', groupUi);
        expect(screen.getByText(GROUP_LABEL)).toBeInTheDocument();
        expect(screen.getByText('€25.00')).toBeInTheDocument();
    });

    it('GroupSettings hides it on cloud', () => {
        withMode('cloud', groupUi);
        expect(screen.queryByText(GROUP_LABEL)).not.toBeInTheDocument();
    });

    it('OrgMemberRow shows it when self-hosted', () => {
        withMode('self-hosted', rowUi);
        expect(screen.getByText('€10.00/mo')).toBeInTheDocument();
    });

    it('OrgMemberRow hides it on cloud', () => {
        withMode('cloud', rowUi);
        expect(screen.queryByTitle(USER_LABEL)).not.toBeInTheDocument();
    });
});
