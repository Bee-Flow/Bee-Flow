import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import GroupModal from './GroupModal';
import type { GroupFormData } from './types';

/** The self-hosted AI budget per member in the group dialog. */

const EMPTY_GROUP: GroupFormData = { id: 'g', name: 'Team', description: '', permissions: [], roles: [], organizationId: '', allowedAgentTypes: [], perUserCostLimit: '5' };

function GroupHarness({ isSelfHosted }: { isSelfHosted: boolean }) {
    const [groupData, setGroupData] = useState(EMPTY_GROUP);
    const t = ((_k: string, fallback: string) => fallback) as never;
    return <GroupModal open onClose={() => {}} showEditGroup groupData={groupData} setGroupData={setGroupData} organizations={[]} permissions={[]} roles={[]} isFullAdmin isSelfHosted={isSelfHosted} onSubmitAdd={() => {}} onSubmitUpdate={() => {}} t={t} />;
}

describe('group AI budget per member', () => {
    beforeEach(() => cleanup());

    it('shows the field with its "not shared" hint on a self-hosted server', () => {
        render(<GroupHarness isSelfHosted />);
        expect(screen.getByLabelText('AI budget per member per month (€)')).toHaveValue(5);
        expect(screen.getByText(/it is not shared between them/)).toBeInTheDocument();
    });

    it('hides the field otherwise', () => {
        render(<GroupHarness isSelfHosted={false} />);
        expect(screen.queryByLabelText('AI budget per member per month (€)')).not.toBeInTheDocument();
    });
});
