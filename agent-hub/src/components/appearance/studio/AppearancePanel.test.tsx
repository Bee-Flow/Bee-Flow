// Admin → Appearance is a StudioShell: Look and Icons are rows of a named
// section nav (the label it had as a tab strip), the open one carries
// aria-current, and switching swaps the editor in the main pane. The editors'
// reads never answer here, so only the chrome is under test.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import AppearancePanel from './AppearancePanel';

beforeEach(() => { setDemoTransport(() => new Promise<Response>(() => {})); });
afterEach(() => { setDemoTransport(null); });

describe('AppearancePanel', () => {
    it('lists Look and Icons in the "Appearance sections" nav and opens Look', () => {
        render(<AppearancePanel />);
        const nav = screen.getByRole('navigation', { name: 'Appearance sections' });
        expect(nav).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Look' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Icons' })).not.toHaveAttribute('aria-current');
    });

    it('switches to Icons from the nav', async () => {
        const user = userEvent.setup();
        render(<AppearancePanel />);
        await user.click(screen.getByRole('button', { name: 'Icons' }));
        expect(screen.getByRole('button', { name: 'Icons' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByText('Loading icon packs...')).toBeInTheDocument();
    });
});
