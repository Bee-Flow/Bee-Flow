import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import CookieBannerEditor from './CookieBannerEditor';

describe('CookieBannerEditor layout', () => {
    afterEach(() => cleanup());

    it('offers card, bar and corner, with the card selected when nothing is stored', () => {
        render(<CookieBannerEditor data={{ enabled: true, text: {} }} onChange={() => {}} />);
        expect(screen.getByRole('button', { name: 'Card' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Bar' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Corner' })).toBeInTheDocument();
    });

    it('writes the chosen layout and keeps the rest of the banner untouched', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const data = { enabled: true, text: { en: { message: 'Hello' } } };
        render(<CookieBannerEditor data={data} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: 'Bar' }));
        expect(onChange).toHaveBeenCalledWith({ ...data, layout: 'bar' });
    });
});
