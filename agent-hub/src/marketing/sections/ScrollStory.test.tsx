import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import ScrollStory from './ScrollStory';

const data = {
    enabled: true,
    title: 'Story',
    steps: [
        { title: 'One', body: 'First.', media: { kind: 'image', src: 'cms/a.png', alt: 'Shot one' } },
        { title: 'Two', body: 'Second.', media: { kind: 'image', src: 'cms/b.png', alt: 'Shot two' } },
        { title: '', body: '', media: { src: '' } },
    ],
};

describe('ScrollStory', () => {
    it('lists the steps in order, drops empty ones and keeps each step\'s image inline for screen readers', () => {
        const { container } = render(<ScrollStory data={data} />);
        expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['One', 'Two']);
        expect(container.querySelectorAll('.scroll-story__step .scroll-story__inline-media img')).toHaveLength(2);
        expect(screen.getAllByAltText('Shot one').length).toBeGreaterThan(0);
    });

    it('hides the sticky panel from assistive technology', () => {
        const { container } = render(<ScrollStory data={data} />);
        expect(container.querySelector('.scroll-story__panel')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('makes the sticky panel inert, so nothing in it can be tabbed to', () => {
        const { container } = render(<ScrollStory data={data} />);
        expect(container.querySelector('.scroll-story__panel')?.hasAttribute('inert')).toBe(true);
    });

    it('shows images only: a clip or video in a step is not rendered', () => {
        const withClip = {
            enabled: true,
            steps: [
                { title: 'Clip', body: 'x', media: { kind: 'clip', src: 'cms/a.mp4', alt: 'A clip' } },
                { title: 'Video', body: 'y', media: { kind: 'video', src: 'cms/b.mp4', alt: 'A video' } },
            ],
        };
        const { container } = render(<ScrollStory data={withClip} />);
        expect(container.querySelectorAll('video, iframe, img')).toHaveLength(0);
        expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    });

    it('makes the focused step the active one, so the keyboard moves the panel', async () => {
        const { container } = render(<ScrollStory data={data} />);
        const steps = container.querySelectorAll<HTMLElement>('.scroll-story__step');
        expect(steps[0].getAttribute('aria-current')).toBe('step');
        await userEvent.tab();
        await userEvent.tab();
        expect(steps[1].getAttribute('aria-current')).toBe('step');
        expect(container.querySelectorAll('.scroll-story__slide')[1].classList.contains('is-active')).toBe(true);
    });

    it('renders nothing without steps or when disabled', () => {
        expect(render(<ScrollStory data={{ enabled: true, steps: [] }} />).container.innerHTML).toBe('');
        expect(render(<ScrollStory data={{ ...data, enabled: false }} />).container.innerHTML).toBe('');
    });
});
