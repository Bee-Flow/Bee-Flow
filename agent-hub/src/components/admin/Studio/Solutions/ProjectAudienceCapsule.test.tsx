import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import ProjectAudienceCapsule, { describeProjectAudience } from './ProjectAudienceCapsule';

/**
 * The audience capsule on a Solution.
 *
 * It looks exactly like the org publish capsule and means something else, so
 * the tests here are almost all about the sentence it REFUSES to say. There is
 * no org-wide project share on the server — `POST /:id/share` takes 'user' or
 * 'group' and the role ladder resolves from exactly those — so a control
 * offering "Entire organisation" would promise access no row grants.
 */

const GROUP_SHARE = { id: 's1', sharedWithType: 'group', sharedWithId: 'g1', permission: 'viewer' };
const USER_SHARE = { id: 's2', sharedWithType: 'user', sharedWithId: 'u1', permission: 'editor' };

describe('what it says', () => {
    it('named people only reads as "Members only"', () => {
        const { getByTestId } = render(<ProjectAudienceCapsule members={[USER_SHARE]} />);
        expect(getByTestId('solution-audience-capsule').textContent).toContain('Members only');
    });

    it('an empty member list is still "Members only" — the owner is always there', () => {
        const { getByTestId } = render(<ProjectAudienceCapsule members={[]} />);
        expect(getByTestId('solution-audience-capsule').textContent).toContain('Members only');
    });

    it('one group share names the group when the name is known', () => {
        const { getByTestId } = render(
            <ProjectAudienceCapsule members={[GROUP_SHARE]} groupNames={{ g1: 'Sales' }} />,
        );
        expect(getByTestId('solution-audience-capsule').textContent).toContain('Sales');
    });

    it('one group share whose name is unknown is counted, not guessed', () => {
        const { getByTestId } = render(<ProjectAudienceCapsule members={[GROUP_SHARE]} />);
        const text = getByTestId('solution-audience-capsule').textContent;
        expect(text).toContain('1 group');
        expect(text).not.toContain('undefined');
    });

    it('several groups are counted', () => {
        const { getByTestId } = render(
            <ProjectAudienceCapsule members={[GROUP_SHARE, { ...GROUP_SHARE, id: 's3', sharedWithId: 'g2' }]} />,
        );
        expect(getByTestId('solution-audience-capsule').textContent).toContain('2 groups');
    });
});

describe('what it refuses to say', () => {
    it('never offers "Entire organisation" — there is no org-wide project share', () => {
        const { container } = render(
            <ProjectAudienceCapsule members={[GROUP_SHARE, USER_SHARE]} groupNames={{ g1: 'Sales' }} />,
        );
        expect(container.textContent).not.toMatch(/organisation|organization/i);
    });

    it('an unloaded member list renders NOTHING rather than the narrower answer', () => {
        const { queryByTestId } = render(<ProjectAudienceCapsule members={null} />);
        expect(queryByTestId('solution-audience-capsule')).toBeNull();
    });

    it('describeProjectAudience returns null for anything that is not a list', () => {
        expect(describeProjectAudience(null)).toBeNull();
        expect(describeProjectAudience(undefined)).toBeNull();
        expect(describeProjectAudience({})).toBeNull();
    });
});
