import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TriggerProviderPicker from './Builder/flow/TriggerProviderPicker';

/**
 * The routine builder's overlays, now that they are dialogs. (The version
 * diff dialog that lived here was replaced by the Versions tab, which asks
 * its restore question without a dialog underneath.)
 */
describe('routine builder overlays, once they are dialogs', () => {
    beforeEach(() => {
        cleanup();
    });

    it('the app picker is a named dialog: its search field gets the focus and Escape closes it once', () => {
        // `providers = []` in the JS signature infers as never[]; say what it takes.
        const Picker = TriggerProviderPicker as unknown as React.ComponentType<{
            providers: Array<{ id: string; label: string; events: Array<{ id: string; label: string }> }>;
            onPick: (id: string) => void;
            onClose: () => void;
        }>;
        const onClose = vi.fn();
        render(
            <Picker
                providers={[{ id: 'gmail', label: 'Gmail', events: [{ id: 'new_mail', label: 'New email' }] }]}
                onPick={vi.fn()}
                onClose={onClose}
            />,
        );
        expect(screen.getByRole('dialog', { name: 'Choose an app to trigger on' })).toBeInTheDocument();
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search apps' }));

        fireEvent.keyDown(document, { key: 'Escape' });
        // Its own document listener is gone; Modal's is the only one left.
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
