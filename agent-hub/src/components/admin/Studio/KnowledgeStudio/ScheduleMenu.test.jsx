import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import ScheduleMenu, { CRON_PRESETS, presetFor } from './ScheduleMenu';

/**
 * The control that decides how often something fetches itself from someone
 * else's server. Two ways it can be wrong that both look fine on screen:
 * offering a mode the server will refuse, and mislabelling a schedule it is
 * about to overwrite.
 */

const anchorRef = { current: document.createElement('button') };

function open(source, onChange = vi.fn()) {
    render(<ScheduleMenu open onClose={() => {}} anchorRef={anchorRef} source={source} onChange={onChange} />);
    return onChange;
}

describe('presetFor', () => {
    it('recognises exactly the crons this menu can produce', () => {
        expect(presetFor('0 6 * * 1').id).toBe('weekly');
        expect(presetFor('0 6 * * *').id).toBe('daily');
        expect(presetFor('0 6 1 * *').id).toBe('monthly');
    });

    it('admits it does not recognise an operator’s own cron', () => {
        // Showing "Every Monday" over `*/5 * * * *` would mislabel the
        // schedule the next click is about to replace.
        expect(presetFor('*/5 * * * *')).toBeNull();
        expect(presetFor('')).toBeNull();
        expect(presetFor(null)).toBeNull();
    });
});

describe('ScheduleMenu', () => {
    it('offers only the modes this kind of source actually has', () => {
        open({ kind: 'webpage', refreshMode: 'manual', supportsModes: ['manual', 'schedule'] });
        expect(screen.getByRole('menuitemradio', { name: /Only when I ask/ })).toBeTruthy();
        expect(screen.getByRole('menuitemradio', { name: /On a schedule/ })).toBeTruthy();
        // A web page has no change event and is not live.
        expect(screen.queryByRole('menuitemradio', { name: /Live/ })).toBeNull();
        expect(screen.queryByRole('menuitemradio', { name: /After every meeting/ })).toBeNull();
    });

    it('falls back to manual-only rather than guessing when the server said nothing', () => {
        open({ kind: 'legacy', refreshMode: 'manual' });
        expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);
    });

    it('hides the cron presets for a kind that cannot be scheduled', () => {
        open({ kind: 'upload', refreshMode: 'manual', supportsModes: ['manual'] });
        for (const p of CRON_PRESETS) {
            expect(screen.queryByRole('menuitemradio', { name: new RegExp(p.labelFallback) })).toBeNull();
        }
    });

    it('marks the mode that is currently in force', () => {
        open({ kind: 'webpage', refreshMode: 'manual', supportsModes: ['manual', 'schedule'] });
        expect(screen.getByRole('menuitemradio', { name: /Only when I ask/ }).getAttribute('aria-checked')).toBe('true');
    });

    it('marks the preset that is currently in force, not just the mode', () => {
        open({ kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 6 * * 1', supportsModes: ['manual', 'schedule'] });
        expect(screen.getByRole('menuitemradio', { name: /Every Monday/ }).getAttribute('aria-checked')).toBe('true');
        // "On a schedule" is not separately checked — a preset IS the schedule.
        expect(screen.getByRole('menuitemradio', { name: /On a schedule/ }).getAttribute('aria-checked')).toBe('false');
    });

    it('names an operator’s custom cron instead of pretending it is a preset', () => {
        open({ kind: 'webpage', refreshMode: 'schedule', refreshCron: '*/5 * * * *', supportsModes: ['manual', 'schedule'] });
        expect(screen.getByText(/Custom schedule/)).toBeTruthy();
        for (const p of CRON_PRESETS) {
            expect(screen.getByRole('menuitemradio', { name: new RegExp(p.labelFallback) }).getAttribute('aria-checked')).toBe('false');
        }
    });

    it('sends a cron AND a timezone, because "06:00" alone means nothing', async () => {
        const onChange = open({ kind: 'webpage', refreshMode: 'manual', supportsModes: ['manual', 'schedule'] });
        fireEvent.click(screen.getByRole('menuitemradio', { name: /Every day at 06:00/ }));
        await waitFor(() => expect(onChange).toHaveBeenCalled());
        const arg = onChange.mock.calls[0][0];
        expect(arg.mode).toBe('schedule');
        expect(arg.cron).toBe('0 6 * * *');
        expect(typeof arg.tz).toBe('string');
        expect(arg.tz.length).toBeGreaterThan(0);
    });

    it('says whose 06:00 it is', () => {
        open({ kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 6 * * 1', refreshTz: 'Europe/Amsterdam', supportsModes: ['manual', 'schedule'] });
        expect(screen.getByText(/Times are in Europe\/Amsterdam/)).toBeTruthy();
    });

    it('sends a bare mode when the mode needs no schedule', async () => {
        const onChange = open({ kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 6 * * 1', supportsModes: ['manual', 'schedule'] });
        fireEvent.click(screen.getByRole('menuitemradio', { name: /Only when I ask/ }));
        await waitFor(() => expect(onChange).toHaveBeenCalledWith({ mode: 'manual' }));
    });

    it('picking "On a schedule" comes with a real cron, never a mode alone', async () => {
        // mode:'schedule' with no cron is a source that claims a schedule and
        // has none — the server would arm it on a default nobody chose.
        const onChange = open({ kind: 'webpage', refreshMode: 'manual', supportsModes: ['manual', 'schedule'] });
        fireEvent.click(screen.getByRole('menuitemradio', { name: /On a schedule/ }));
        await waitFor(() => expect(onChange).toHaveBeenCalled());
        expect(onChange.mock.calls[0][0].cron).toBeTruthy();
    });
});
