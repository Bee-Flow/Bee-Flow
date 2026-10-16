import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import lazySection from './lazySection';
import { EXTRA_SECTIONS } from './extraSections';

describe('lazySection', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('holds the space with a placeholder, then renders the loaded section with its props', async () => {
        let resolve: (m: { default: (p: { data: { title: string } }) => ReactElement }) => void = () => undefined;
        const Section = lazySection<{ data: { title: string } }>(() => new Promise((r) => { resolve = r; }));
        const { container } = render(<Section data={{ title: 'Loaded' }} />);
        expect(container.querySelector('.cms-lazy-section')).not.toBeNull();
        resolve({ default: ({ data }) => <h2>{data.title}</h2> });
        expect(await screen.findByRole('heading', { name: 'Loaded' })).toBeTruthy();
        expect(container.querySelector('.cms-lazy-section')).toBeNull();
    });

    it('the motion blocks in the registry render through their own chunk', async () => {
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        const Mockup = EXTRA_SECTIONS['product-mockup'];
        render(<Mockup data={{ enabled: true, title: 'See it work', prompt: 'Hi', steps: [] }} />);
        expect(await screen.findByRole('heading', { name: 'See it work' })).toBeTruthy();
    });
});
