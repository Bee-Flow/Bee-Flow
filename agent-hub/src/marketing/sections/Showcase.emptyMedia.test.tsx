/**
 * A showcase with no image renders no skeleton pane on the published site;
 * the editor preview keeps the placeholder frame so an image can be added.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import Showcase from './Showcase';

afterEach(() => window.history.replaceState({}, '', '?'));

const base = { enabled: true, title: 'Product tour' };

describe('showcase with empty media', () => {
    it('renders no media pane on the published site', () => {
        const { container } = render(<Showcase data={{ ...base, media: { src: '' } }} />);
        expect(container.querySelector('.showcase-single')).toBeNull();
        expect(container.querySelector('.framed-media')).toBeNull();
    });

    it('keeps the placeholder in the editor preview', () => {
        window.history.replaceState({}, '', '?preview=1');
        const { container } = render(<Showcase data={{ ...base, media: { src: '' } }} />);
        expect(container.querySelector('.showcase-single')).not.toBeNull();
    });

    it('renders a media pane when there is a source', () => {
        const { container } = render(<Showcase data={{ ...base, media: { src: '/x.png', alt: 'x' } }} />);
        expect(container.querySelector('.showcase-single')).not.toBeNull();
    });
});
