/**
 * Classic hero with align "left" must left-align the lead and the buttons too
 * (a hero--align-left class drives the CSS); the cta block must not render a
 * secondary button whose label is blank, except in the editor preview.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import Hero from './Hero';
import CTA from './CTA';

afterEach(() => window.history.replaceState({}, '', '?'));

const hero = { enabled: true, titleParts: [{ text: 'Title' }], lead: 'Lead' };

describe('hero alignment', () => {
    it('adds hero--align-left to a left-aligned classic hero', () => {
        const { container } = render(<Hero data={{ ...hero, align: 'left' }} />);
        expect(container.querySelector('section.hero')?.classList.contains('hero--align-left')).toBe(true);
    });

    it('adds nothing for the default (centred) hero', () => {
        const { container } = render(<Hero data={hero} />);
        expect(container.querySelector('section.hero')?.classList.contains('hero--align-left')).toBe(false);
    });
});

describe('cta secondary button', () => {
    const cta = { enabled: true, title: 'T', button: { label: 'Go', href: '/a' } };

    it('does not render a blank secondary button', () => {
        const { container } = render(<CTA data={{ ...cta, secondaryCta: { label: '  ' } }} />);
        expect(container.querySelectorAll('.cta-actions .btn')).toHaveLength(1);
    });

    it('renders a secondary button with a label', () => {
        const { container } = render(<CTA data={{ ...cta, secondaryCta: { label: 'More', href: '/b' } }} />);
        expect(container.querySelectorAll('.cta-actions .btn')).toHaveLength(2);
    });

    it('keeps the empty button clickable in the editor preview', () => {
        window.history.replaceState({}, '', '?preview=1');
        const { container } = render(<CTA data={{ ...cta, secondaryCta: { label: '' } }} />);
        expect(container.querySelectorAll('.cta-actions .btn')).toHaveLength(2);
    });
});
