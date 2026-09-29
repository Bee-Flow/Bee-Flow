import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import scopedStorage, { setCurrentUser } from '../../utils/scopedStorage';
import EditorPreferencesSection, { AUTO_MAP_KEY } from './EditorPreferencesSection';

describe('EditorPreferencesSection', () => {
    beforeEach(() => { localStorage.clear(); setCurrentUser('u1'); });

    it('is on by default and writes the same key the builder reads', async () => {
        render(<EditorPreferencesSection />);
        const toggle = screen.getByRole('switch', { name: 'Map fields automatically' });
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        await userEvent.setup().click(toggle);
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        expect(scopedStorage.getItem(AUTO_MAP_KEY)).toBe('0');
        expect(AUTO_MAP_KEY).toBe('autoMapOnConnect');
    });

    it('keeps an earlier "off" from the automation settings', () => {
        scopedStorage.setItem(AUTO_MAP_KEY, '0');
        render(<EditorPreferencesSection />);
        expect(screen.getByRole('switch', { name: 'Map fields automatically' })).toHaveAttribute('aria-checked', 'false');
    });
});
