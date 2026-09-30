/** The retention rules: which column a window counts from, the patch that always carries it, the typed number, the cutoff. */

import type { TranslateFn } from '@/core/i18n';

import {
    customDays,
    dateColumns,
    defaultRetentionField,
    expiringSoonCutoffIso,
    initialRetentionField,
    MAX_RETENTION_DAYS,
    offersRetention,
    retentionChoice,
    retentionFieldLabel,
    retentionFieldOptions,
    retentionPatch,
} from './retention';
import type { Column } from './types';

const t: TranslateFn = (_key, fallback) => fallback;

const col = (key: string, type: Column['type'], name = ''): Column => ({ id: `fld_${key}`, key, name, type, options: [], required: false, unique: false });
const COLUMNS = [col('email', 'text', 'E-mail'), col('signed_at', 'datetime', 'Signed on'), col('seen_at', 'date', 'Last seen')];

const facts = (over: Partial<{ managedKind: string | null; retentionDays: number | null; retentionField: string | null }> = {}) => ({
    managedKind: null,
    retentionDays: null,
    retentionField: null,
    ...over,
});

describe('which column a window counts from', () => {
    it('only a date or date-and-time column can age a row', () => {
        expect(dateColumns(COLUMNS).map((c) => c.key)).toEqual(['signed_at', 'seen_at']);
    });

    it('offers the first date column, and the date a managed kind stamps', () => {
        expect(defaultRetentionField(facts(), COLUMNS)).toBe('signed_at');
        expect(defaultRetentionField(facts(), [col('email', 'text')])).toBe('');
        expect(defaultRetentionField(facts({ managedKind: 'http_cache' }), COLUMNS)).toBe('fetched_at');
        expect(defaultRetentionField(facts({ managedKind: 'form_answers' }), [col('completed_at', 'datetime')])).toBe('created_at');
    });

    it('never starts on the server’s created_at default when nobody chose it', () => {
        // retention_field is NOT NULL DEFAULT 'created_at': with no window it is not a choice.
        expect(initialRetentionField(facts({ retentionField: 'created_at' }), COLUMNS)).toBe('signed_at');
        // A column chosen before the window was switched off is kept.
        expect(initialRetentionField(facts({ retentionField: 'seen_at' }), COLUMNS)).toBe('seen_at');
        // With a window set, the stored column is the truth, system date or not.
        expect(initialRetentionField(facts({ retentionDays: 30, retentionField: 'created_at' }), COLUMNS)).toBe('created_at');
        expect(initialRetentionField(facts({ managedKind: 'form_answers', retentionField: 'created_at' }), COLUMNS)).toBe('created_at');
    });

    it('shows a live window’s system column beside the date columns, and a managed table its one', () => {
        expect(retentionFieldOptions(facts(), COLUMNS, 'signed_at').map((o) => o.key)).toEqual(['signed_at', 'seen_at']);
        expect(retentionFieldOptions(facts(), COLUMNS, 'created_at')).toEqual([
            { key: 'created_at', label: 'created_at' },
            { key: 'signed_at', label: 'Signed on' },
            { key: 'seen_at', label: 'Last seen' },
        ]);
        expect(retentionFieldOptions(facts({ managedKind: 'http_cache' }), [col('fetched_at', 'datetime', 'Fetched at')], 'fetched_at')).toEqual([{ key: 'fetched_at', label: 'Fetched at' }]);
        expect(retentionFieldOptions(facts(), [col('email', 'text')], '')).toEqual([]);
    });

    it('names the column in a sentence by its name, else its key', () => {
        expect(retentionFieldLabel(t, COLUMNS, 'signed_at')).toBe('Signed on');
        expect(retentionFieldLabel(t, COLUMNS, 'created_at')).toBe('created_at');
        expect(retentionFieldLabel(t, COLUMNS, null)).toBe('no column');
    });

    it('offers no window on a mirror', () => {
        expect(offersRetention({ managedKind: 'nextcloud_table' })).toBe(false);
        expect(offersRetention({ managedKind: 'spreadsheet_file' })).toBe(false);
        expect(offersRetention({ managedKind: 'form_answers' })).toBe(true);
        expect(offersRetention({ managedKind: null })).toBe(true);
    });
});

describe('the patch', () => {
    it('sends the window with its column, and turning it off sends the null alone', () => {
        expect(retentionPatch(30, 'signed_at')).toEqual({ retentionDays: 30, retentionField: 'signed_at' });
        expect(retentionPatch(null, 'signed_at')).toEqual({ retentionDays: null });
    });
});

describe('the choice', () => {
    it('reads a preset as itself and anything else as Other…', () => {
        expect(retentionChoice(null, false)).toBe('off');
        expect(retentionChoice(30, false)).toBe('30');
        expect(retentionChoice(45, false)).toBe('custom');
        expect(retentionChoice(30, true)).toBe('custom');
    });

    it('takes a typed number only as whole days from 1 to the server’s cap', () => {
        expect(customDays(' 45 ')).toBe(45);
        expect(customDays(String(MAX_RETENTION_DAYS))).toBe(3650);
        for (const bad of ['', '0', '3651', '4.5', '-3', 'abc', '1e3']) expect(customDays(bad)).toBeNull();
    });
});

describe('what is about to expire', () => {
    it('is everything dated before the window minus the look-ahead', () => {
        const now = Date.parse('2026-09-27T12:00:00.000Z');
        expect(expiringSoonCutoffIso(30, 7, now)).toBe('2026-09-04T12:00:00.000Z');
        expect(expiringSoonCutoffIso(null, 7, now)).toBeNull();
        expect(expiringSoonCutoffIso(30, 0, now)).toBeNull();
    });
});
