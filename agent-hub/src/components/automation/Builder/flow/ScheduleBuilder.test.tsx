import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScheduleBuilder from './ScheduleBuilder';

/** The trigger editor's wiring: every edit goes into the draft and comes straight back as props. */
function Harness({ initial, onCron }: { initial: string; onCron: (cron: string) => void }) {
    const [value, setValue] = useState({ cron: initial, tz: 'Europe/Amsterdam' });
    return (
        <ScheduleBuilder
            cron={value.cron}
            tz={value.tz}
            onChange={(next) => { setValue(next); onCron(next.cron); }}
        />
    );
}

describe('ScheduleBuilder — the custom pattern field', () => {
    beforeEach(() => {
        // The next-runs preview is the server's; these tests are about the field.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ valid: true, next: [] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        })));
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('keeps the field while a pattern is typed that passes through a preset shape', async () => {
        const user = userEvent.setup();
        const onCron = vi.fn();
        render(<Harness initial="0 9 * * *" onCron={onCron} />);

        await user.selectOptions(screen.getByDisplayValue('Daily'), 'custom');
        const field = screen.getByPlaceholderText('0 9 * * 1');
        await user.clear(field);
        // `0 9 * * 1` is a weekly preset on the way to weekdays-only.
        await user.type(field, '0 9 * * 1-5');

        expect(screen.getByPlaceholderText('0 9 * * 1')).toHaveValue('0 9 * * 1-5');
        expect(onCron).toHaveBeenLastCalledWith('0 9 * * 1-5');
    });

    it('still follows a pattern that changes from outside', async () => {
        const { rerender } = render(<ScheduleBuilder cron="0 9 * * *" tz="Europe/Amsterdam" onChange={() => {}} />);
        expect(screen.getByDisplayValue('Daily')).toBeInTheDocument();
        rerender(<ScheduleBuilder cron="30 8 * * 1,3" tz="Europe/Amsterdam" onChange={() => {}} />);
        expect(await screen.findByDisplayValue('Weekly')).toBeInTheDocument();
    });
});
