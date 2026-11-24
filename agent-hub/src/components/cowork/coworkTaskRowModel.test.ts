// The right-hand line of a row of "Your tasks" (./coworkTaskRowModel.ts): what comes next, in the status's words.
import { describe, expect, it } from 'vitest';
import { momentWords, nextLine } from './coworkTaskRowModel';

const NOW = new Date(2026, 10, 24, 10, 0);
const t = (_key: string | undefined, fallback?: unknown, params?: unknown) => {
    let text = String(fallback);
    for (const [k, v] of Object.entries((params ?? {}) as Record<string, unknown>)) text = text.replace(`{${k}}`, String(v));
    return text;
};
const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();

describe('nextLine', () => {
    it('the next start, today, tomorrow or on a day', () => {
        expect(nextLine({ isActive: true, nextRunAt: at(24, 17), repeatInterval: 'daily' }, 'done', t, 'en-GB', NOW)).toBe('Next: Today, 17:00');
        expect(nextLine({ isActive: true, nextRunAt: at(25, 9), repeatInterval: 'daily' }, 'scheduled', t, 'en-GB', NOW)).toBe('Next: Tomorrow, 09:00');
        expect(nextLine({ isActive: true, nextRunAt: at(30, 9), repeatInterval: 'weekly' }, 'done', t, 'en-GB', NOW)).toMatch(/^Next: Mon.* 30 Nov, 09:00$/);
        // The 24-hour clock of the schedules, also where the reader's language would write 04:00 PM.
        expect(nextLine({ isActive: true, nextRunAt: at(24, 16), repeatInterval: 'daily' }, 'done', t, 'en-US', NOW)).toBe('Next: Today, 16:00');
    });

    it('in the status\'s words: now while it runs or tests, and no second word beside Failed or Paused', () => {
        const item = { isActive: true, nextRunAt: at(25, 9), repeatInterval: 'daily' };
        expect(nextLine(item, 'running', t, 'en-GB', NOW)).toBe('Now');
        expect(nextLine(item, 'testing', t, 'en-GB', NOW)).toBe('Now');
        expect(nextLine(item, 'failed', t, 'en-GB', NOW)).toBe('');
        expect(nextLine({ ...item, isActive: false }, 'paused', t, 'en-GB', NOW)).toBe('');
    });

    it('an event start waits for it; a finished one-off ran once', () => {
        expect(nextLine({ isActive: true, triggerKind: 'app_event', trigger: { provider: 'gmail', event: 'mail.new' } }, 'done', t, 'en-GB', NOW)).toBe('Waits for a new mail');
        expect(nextLine({ isActive: true, triggerKind: 'after_cowork' }, 'scheduled', t, 'en-GB', NOW)).toBe('Waits for the other task');
        expect(nextLine({ isActive: false, nextRunAt: null, repeatInterval: null }, 'done', t, 'en-GB', NOW)).toBe('Ran once');
        expect(nextLine({ isActive: true, nextRunAt: null, repeatInterval: null }, 'scheduled', t, 'en-GB', NOW)).toBe('');
    });

    it('momentWords keeps to the reader\'s clock', () => {
        expect(momentWords(new Date(2026, 10, 24, 6, 30), t, 'en-GB', NOW)).toBe('Today, 06:30');
    });
});
