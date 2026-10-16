import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import Tour from './Tour';

const data = {
    enabled: true,
    title: 'Tour',
    steps: [
        { title: 'Inbox', body: 'Your inbox.', media: { kind: 'image', src: 'cms/a.png', alt: 'Inbox' },
            hotspots: [{ x: 10, y: 20, label: 'Filter bar', body: 'Narrow the list.' }, { x: 80, y: 90, label: 'Compose', body: 'Write a note.' }] },
        { title: 'Reply', body: 'Answer it.', media: { kind: 'image', src: 'cms/b.png', alt: 'Reply' } },
    ],
};

describe('Tour', () => {
    it('shows the first step and walks forward and back with real buttons', async () => {
        render(<Tour data={data} />);
        expect(screen.getByRole('heading', { name: 'Inbox' })).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Previous step' }) as HTMLButtonElement).disabled).toBe(true);
        await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
        expect(screen.getByRole('heading', { name: 'Reply' })).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Next step' }) as HTMLButtonElement).disabled).toBe(true);
        await userEvent.click(screen.getByRole('button', { name: 'Previous step' }));
        expect(screen.getByRole('heading', { name: 'Inbox' })).toBeTruthy();
    });

    it('opens a hotspot\'s explanation from the keyboard and closes it with Escape', async () => {
        render(<Tour data={data} />);
        const spot = screen.getByRole('button', { name: 'Filter bar' });
        expect(spot.getAttribute('aria-expanded')).toBe('false');
        spot.focus();
        await userEvent.keyboard('{Enter}');
        expect(spot.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText('Narrow the list.')).toBeTruthy();
        await userEvent.keyboard('{Escape}');
        expect(spot.getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByText('Your inbox.')).toBeTruthy();
    });

    it('positions a hotspot from its percentages, clamped to the image', () => {
        render(<Tour data={{ ...data, steps: [{ ...data.steps[0], hotspots: [{ x: 140, y: -5, label: 'Edge', body: '' }] }] }} />);
        const spot = screen.getByRole('button', { name: 'Edge' });
        expect(spot.style.getPropertyValue('--tour-x')).toBe('100%');
        expect(spot.style.getPropertyValue('--tour-y')).toBe('0%');
    });

    it('uses the authored button and counter labels', () => {
        render(<Tour data={{ ...data, labels: { next: 'Verder', stepOf: 'Stap {n} van {total}' } }} />);
        expect(screen.getByRole('button', { name: 'Verder' })).toBeTruthy();
        expect(screen.getByText('Stap 1 van 2')).toBeTruthy();
    });
});
