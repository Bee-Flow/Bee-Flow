import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActionCard from './ActionCard';

const SIBLINGS = [{ name: 'nc_read', label: 'Read file' }, { name: 'nc_list', label: 'Files in folder' }];

describe('ActionCard — the action as a readable card (round 4)', () => {
    beforeEach(cleanup);

    it('reads "App · Action" and switches to another action of the app', async () => {
        const onSwitch = vi.fn();
        render(<ActionCard tool="nc_read" appLabel="Nextcloud" action={SIBLINGS[0]} siblings={SIBLINGS} onSwitch={onSwitch} />);
        expect(screen.getByText('Nextcloud · Read file')).toBeTruthy();
        // The help moved into the button's tooltip: one quiet line, no second row.
        expect(screen.getByRole('button', { name: /Switch/ }).getAttribute('title')).toBe('Choose another Nextcloud action');
        await userEvent.click(screen.getByRole('button', { name: 'Switch' }));
        expect(screen.getByRole('menuitemradio', { name: /Read file/ }).getAttribute('aria-checked')).toBe('true');
        await userEvent.click(screen.getByRole('menuitemradio', { name: /Files in folder/ }));
        expect(onSwitch).toHaveBeenCalledWith('nc_list');
    });

    it('offers no Switch when the app has one action', () => {
        render(<ActionCard tool="nc_read" appLabel="Nextcloud" action={SIBLINGS[0]} siblings={[SIBLINGS[0]]} onSwitch={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Switch' })).toBeNull();
    });
});
