import { screen } from '@testing-library/react';
import { renderWithClient } from '../../../test/render';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/transcriptionsApi', () => ({
    listOrgGroups: vi.fn().mockResolvedValue([{ id: 'g1', name: 'sales' }]),
    publishTranscription: vi.fn(),
}));

import MeetingVisibility from './MeetingVisibility';

describe('MeetingVisibility', () => {
    it('offers Personal, the organisation and groups for a note that is not in a project', () => {
        renderWithClient(<MeetingVisibility meeting={{ id: 'm1', isPublished: false, sharedGroups: [] }} canManage onChange={() => {}} />);
        expect(screen.getByTestId('visibility-capsule')).toHaveTextContent('Personal');
        expect(screen.queryByTestId('visibility-project-locked')).not.toBeInTheDocument();
    });

    it('shows a note in a project as open to the project, not Personal, and gives no way to share it another way', () => {
        renderWithClient(<MeetingVisibility meeting={{ id: 'm1', projectId: 'p1', isPublished: false, sharedGroups: [] }} canManage onChange={() => {}} />);
        const locked = screen.getByTestId('visibility-project-locked');
        expect(locked).toHaveTextContent('Project members');
        expect(locked).toHaveAttribute('title', expect.stringContaining('cannot be shared another way'));
        expect(screen.queryByTestId('visibility-capsule')).not.toBeInTheDocument();
        expect(screen.queryByText('Personal')).not.toBeInTheDocument();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
});
