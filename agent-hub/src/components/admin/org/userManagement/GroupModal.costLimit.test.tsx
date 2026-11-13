import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import GroupModal from './GroupModal';
import type { GroupFormData } from './types';
import { EMPTY_IMAGE_LIMITS_INPUT } from '@/utils/imageLimits';

/** The self-hosted AI budget and the image limits per member in the group dialog. */

const EMPTY_GROUP: GroupFormData = {
    id: 'g', name: 'Team', description: '', permissions: [], roles: [], organizationId: '', allowedAgentTypes: [], perUserCostLimit: '5',
    perUserImageLimits: { ...EMPTY_IMAGE_LIMITS_INPUT, day: '10' },
};

let latest: GroupFormData = EMPTY_GROUP;

function GroupHarness({ isSelfHosted }: { isSelfHosted: boolean }) {
    const [groupData, setGroupData] = useState(EMPTY_GROUP);
    latest = groupData;
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

describe('group image limits per member', () => {
    beforeEach(() => cleanup());

    it('is shown on cloud too, with the stored window filled in', () => {
        render(<GroupHarness isSelfHosted={false} />);
        expect(screen.getByRole('group', { name: 'Image limits per member' })).toBeInTheDocument();
        expect(screen.getByLabelText('Per 24 hours')).toHaveValue(10);
        expect(screen.getByLabelText('Per hour')).toHaveValue(null);
    });

    it('keeps what is typed per window', async () => {
        render(<GroupHarness isSelfHosted={false} />);
        await userEvent.type(screen.getByLabelText('Per 7 days'), '0');
        expect(latest.perUserImageLimits).toEqual({ hour: '', day: '10', week: '0', month: '' });
    });
});
