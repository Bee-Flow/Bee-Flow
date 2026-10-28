// The Nextcloud trigger's "also react to events of colleagues" switch (#191):
// shown only on events the catalog marks `colleagues`, off by default, and
// stored as filter.includeColleagues (cleared, not false, when switched off).

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { AppEventFields } from './AppEventFields';
import type { AppEventFieldsProps } from './triggerEditors.types';

const catalog = {
    triggers: [{
        kind: 'app_event',
        providers: [{
            id: 'nextcloud', label: 'Nextcloud', defaultEvent: 'talk.message.received',
            events: [
                { id: 'talk.message.received', label: 'Talk message received', deliverability: 'ok', colleagues: true },
                { id: 'calendar.event.created', label: 'Calendar event created', deliverability: 'ok' },
            ],
        }],
    }],
} as unknown as AppEventFieldsProps['catalog'];

function setup(event: string, filter: Record<string, unknown> = {}) {
    const setNested = vi.fn();
    const props = {
        draft: { appProvider: 'nextcloud', appEventName: event, filter },
        set: vi.fn(),
        setNested,
        catalog,
    } as unknown as AppEventFieldsProps;
    render(<AppEventFields {...props} />);
    return { setNested };
}

describe('AppEventFields: colleagues switch', () => {
    it('is offered, unticked, on an event a colleague may trigger, and stores includeColleagues', async () => {
        const { setNested } = setup('talk.message.received');
        const box = screen.getByRole('checkbox', { name: /Also react to events of colleagues/i });
        expect((box as HTMLInputElement).checked).toBe(false);
        await userEvent.click(box);
        expect(setNested).toHaveBeenCalledWith('filter', 'includeColleagues', true);
    });

    it('clears the key when switched off', async () => {
        const { setNested } = setup('talk.message.received', { includeColleagues: true });
        const box = screen.getByRole('checkbox', { name: /Also react to events of colleagues/i });
        expect((box as HTMLInputElement).checked).toBe(true);
        await userEvent.click(box);
        expect(setNested).toHaveBeenCalledWith('filter', 'includeColleagues', undefined);
    });

    it('is absent where the event stays with the person who caused it', () => {
        setup('calendar.event.created');
        expect(screen.queryByRole('checkbox', { name: /Also react to events of colleagues/i })).toBeNull();
    });
});
