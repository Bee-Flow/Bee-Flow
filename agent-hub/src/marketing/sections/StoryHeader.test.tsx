/**
 * Customer story header: semantics (one h1, a figure list, a real quote) and
 * the published-site rule that empty fields render nothing.
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/StoryHeader.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import StoryHeader from './StoryHeader';

const data = {
    enabled: true,
    customer: 'Acme Test Co',
    sector: 'Finance',
    title: 'How Acme cut review time',
    lead: 'A short summary.',
    logo: { src: 'https://cdn.example.test/logo.png', alt: '' },
    quote: 'It just works.',
    quoteBy: 'Pat Example, CTO',
    metrics: [{ stat: '60%', label: 'less review time' }, { stat: '3 weeks', label: 'to go live' }],
};

afterEach(() => window.history.replaceState({}, '', '/'));

describe('StoryHeader', () => {
    it('has the story headline as the one h1 and the figures as a description list', () => {
        const { container } = render(<StoryHeader data={data} />);
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('How Acme cut review time');
        const terms = [...container.querySelectorAll('dt')].map((e) => e.textContent);
        const figures = [...container.querySelectorAll('dd')].map((e) => e.textContent);
        expect(terms).toEqual(['less review time', 'to go live']);
        expect(figures).toEqual(['60%', '3 weeks']);
    });

    it('marks up the quote with its attribution and gives the logo a text alternative', () => {
        const { container } = render(<StoryHeader data={data} />);
        expect(container.querySelector('figure blockquote')?.textContent).toBe('It just works.');
        expect(container.querySelector('figcaption')?.textContent).toBe('Pat Example, CTO');
        expect(container.querySelector('img')?.getAttribute('alt')).toBe('Acme Test Co');
    });

    it('renders no empty headline, quote or figures on the published site', () => {
        const { container } = render(<StoryHeader data={{ enabled: true, customer: 'Acme Test Co', metrics: [{ stat: '', label: '' }] }} />);
        expect(container.querySelector('h1')).toBeNull();
        expect(container.querySelector('figure')).toBeNull();
        expect(container.querySelector('dl')).toBeNull();
    });

    it('renders nothing when disabled', () => {
        expect(render(<StoryHeader data={{ ...data, enabled: false }} />).container.innerHTML).toBe('');
    });
});
