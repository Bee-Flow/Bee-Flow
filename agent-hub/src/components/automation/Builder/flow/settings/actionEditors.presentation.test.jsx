import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlideFields, PresentationFields } from './actionEditors';

/**
 * The slide's Visual picker reveals only the fields of the chosen visual,
 * and the deck's Look section carries the logo and the "more" options.
 */

beforeEach(() => cleanup());

describe('SlideFields — visuals', () => {
    it('opens on the visual the step carries and shows that visual\'s fields only', () => {
        const set = vi.fn();
        render(<SlideFields draft={{ title: 'Omzet', visual: 'chart', chartType: 'line', chartData: '{{steps.q.output.rows}}' }} set={set} groups={[]} />);
        expect(screen.getByTestId('slide-visual').value).toBe('chart');
        expect(screen.getByTestId('slide-chart-type').value).toBe('line');
        expect(screen.getByTestId('slide-chart-labels')).toBeTruthy();
        expect(screen.queryByText('Tiles')).toBeNull();
        fireEvent.change(screen.getByTestId('slide-chart-type'), { target: { value: 'donut' } });
        expect(set).toHaveBeenCalledWith('chartType', 'donut');
        fireEvent.change(screen.getByTestId('slide-visual'), { target: { value: 'stats' } });
        expect(set).toHaveBeenCalledWith('visual', 'stats');
    });

    it('stats shows the tiles field, timeline a note, none nothing extra; the slide style select sits under Options', () => {
        const set = vi.fn();
        const { rerender } = render(<SlideFields draft={{ title: 'T', visual: 'stats', stats: '' }} set={set} groups={[]} />);
        expect(screen.getByText('Tiles')).toBeTruthy();
        rerender(<SlideFields draft={{ title: 'T', visual: 'timeline' }} set={set} groups={[]} />);
        expect(screen.getByText(/become numbered steps/)).toBeTruthy();
        rerender(<SlideFields draft={{ title: 'T', visual: 'none', style: 'accent' }} set={set} groups={[]} />);
        expect(screen.queryByTestId('slide-chart-type')).toBeNull();
        if (!screen.queryByTestId('slide-style')) fireEvent.click(screen.getByRole('button', { name: /options/i }));
        expect(screen.getByTestId('slide-style').value).toBe('accent');
        fireEvent.change(screen.getByTestId('slide-style'), { target: { value: 'dark' } });
        expect(set).toHaveBeenCalledWith('style', 'dark');
    });
});

describe('PresentationFields — look', () => {
    it('carries logo, placement and the "more" options, each writing its own key', () => {
        const set = vi.fn();
        render(<PresentationFields draft={{ slidesMode: 'source', slides: 'x', logo: 'none', logoPlacement: 'corner', slideNumbers: 'false', background: '#16191F' }} set={set} />);
        expect(screen.getByTestId('presentation-logo-placement').value).toBe('corner');
        fireEvent.change(screen.getByTestId('presentation-logo-placement'), { target: { value: 'footer' } });
        expect(set).toHaveBeenCalledWith('logoPlacement', 'footer');
        expect(screen.getByTestId('presentation-slide-numbers').value).toBe('false');
        fireEvent.change(screen.getByTestId('presentation-slide-numbers'), { target: { value: '' } });
        expect(set).toHaveBeenCalledWith('slideNumbers', '');
        expect(screen.getByLabelText('Background colour').value).toBe('#16191f');
        expect(screen.getByText('More look options')).toBeTruthy();
    });
});
