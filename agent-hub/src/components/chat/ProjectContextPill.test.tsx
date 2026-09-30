import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import ProjectContextPill from './ProjectContextPill';

const PROJECT = { id: 'p1', name: 'Onboarding', icon: '🚀', color: '#22c55e' };

describe('ProjectContextPill', () => {
    it('names the project the next message is grounded on', () => {
        render(<ProjectContextPill project={PROJECT} onOpen={() => {}} onLeave={() => {}} />);
        expect(screen.getByText('Onboarding')).toBeInTheDocument();
        expect(screen.getByTestId('project-context-pill')).toHaveAttribute('title', 'Chatting in project Onboarding');
    });

    it('opens the project', async () => {
        const onOpen = vi.fn();
        const onLeave = vi.fn();
        render(<ProjectContextPill project={PROJECT} onOpen={onOpen} onLeave={onLeave} />);
        await userEvent.click(screen.getByRole('button', { name: 'Open project Onboarding' }));
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onLeave).not.toHaveBeenCalled();
    });

    it('leaves the project context from its ✕', async () => {
        const onOpen = vi.fn();
        const onLeave = vi.fn();
        render(<ProjectContextPill project={PROJECT} onOpen={onOpen} onLeave={onLeave} />);
        await userEvent.click(screen.getByRole('button', { name: 'Stop chatting in project Onboarding' }));
        expect(onLeave).toHaveBeenCalledTimes(1);
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('keeps the name in the labels when compact', () => {
        render(<ProjectContextPill project={PROJECT} onOpen={() => {}} onLeave={() => {}} compact />);
        expect(screen.queryByText('Onboarding')).toBeNull();
        expect(screen.getByRole('button', { name: 'Open project Onboarding' })).toBeInTheDocument();
    });

    it('falls back to a folder icon for a project without one', () => {
        render(<ProjectContextPill project={{ id: 'p2', name: 'Plain' }} onOpen={() => {}} onLeave={() => {}} />);
        expect(screen.getByText('📁')).toBeInTheDocument();
    });

    it('never paints a colour that is not a plain hex value', () => {
        render(<ProjectContextPill project={{ ...PROJECT, color: 'red;background:url(https://tracker.example/x)' }} onOpen={() => {}} onLeave={() => {}} />);
        expect(screen.getByText('🚀').getAttribute('style') || '').not.toContain('tracker.example');
    });
});
