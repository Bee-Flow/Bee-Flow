// The time field of Cowork: the 24-hour clock as text, forgiving while typing, and HH:MM in what it hands on.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CoworkTimeField, { parseTime } from './CoworkTimeField';

describe('parseTime', () => {
    it('reads what a person types as a time of day', () => {
        expect(parseTime('09:00')).toBe('09:00');
        expect(parseTime('9')).toBe('09:00');
        expect(parseTime('16')).toBe('16:00');
        expect(parseTime('930')).toBe('09:30');
        expect(parseTime('1630')).toBe('16:30');
        expect(parseTime('9:5')).toBe('09:05');
        expect(parseTime('9.30')).toBe('09:30');
        expect(parseTime(' 23:59 ')).toBe('23:59');
    });

    it('refuses what is no time of day', () => {
        for (const text of ['', ':', '24:00', '12:60', '1:2:3', 'abc', '12345']) expect(parseTime(text), text).toBeNull();
    });
});

describe('CoworkTimeField', () => {
    it('shows the 24-hour time, hands on every text that reads as one, and puts a text that is none back when left', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<><label htmlFor="at">At</label><CoworkTimeField id="at" value="09:00" onChange={onChange} /></>);
        const field = screen.getByLabelText('At');
        expect(field).toHaveValue('09:00');
        await user.clear(field);
        await user.type(field, '16:30');
        expect(onChange).toHaveBeenLastCalledWith('16:30');
        await user.clear(field);
        await user.type(field, 'x');
        await user.tab();
        expect(field).toHaveValue('09:00');
    });
});
