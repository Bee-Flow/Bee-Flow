/**
 * The helpers that the feature modules now share.
 *
 * These are pinned rather than spot-checked because collapsing six copies into
 * one changed what four screens render, and the whole point of the collapse was
 * that nobody could say what any of them rendered. The boundary cases below are
 * the ones the old copies disagreed about.
 */

import { formatBytes } from './bytes';
import { plural } from './format';
import { FUTURE_SLACK, relativeTime } from './time';

const NOW = Date.parse('2026-03-12T12:00:00.000Z');

function ago(seconds: number): string {
    return new Date(NOW - seconds * 1000).toISOString();
}

describe('relativeTime', () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it('says nothing at all when there is no timestamp', () => {
        // Empty, not "—" or "unknown": these land in meta slots beside other
        // facts, and the row reads better with the slot collapsed.
        expect(relativeTime(null)).toBe('');
        expect(relativeTime(undefined)).toBe('');
        expect(relativeTime('')).toBe('');
        expect(relativeTime('not a date')).toBe('');
    });

    it('reads as a bare token by default', () => {
        expect(relativeTime(ago(5))).toBe('now');
        expect(relativeTime(ago(59))).toBe('now');
        expect(relativeTime(ago(60))).toBe('1m');
        expect(relativeTime(ago(90))).toBe('1m');
        expect(relativeTime(ago(3600))).toBe('1h');
        expect(relativeTime(ago(86_400))).toBe('1d');
    });

    it('reads as a phrase when the caller is writing a sentence', () => {
        // This is the bug the shared copy exists to kill: five call sites wrote
        // `${relativeTime(x)} ago`, which said "started now ago" for every run
        // that had just started — which is most of the runs anyone looks at.
        expect(relativeTime(ago(5), { suffix: true })).toBe('just now');
        expect(relativeTime(ago(120), { suffix: true })).toBe('2m ago');
        expect(relativeTime(ago(7200), { suffix: true })).toBe('2h ago');
        expect(relativeTime(ago(3 * 86_400), { suffix: true })).toBe('3d ago');
    });

    it('floors rather than rounds, so 119 minutes is an hour and not two', () => {
        // The `search` copy rounded and every other copy floored, so the same
        // conversation showed a different age depending on which list you found
        // it in.
        expect(relativeTime(ago(119 * 60))).toBe('1h');
        expect(relativeTime(ago(47 * 3600))).toBe('1d');
    });

    it('switches to an absolute date after a week, with no "ago" on it', () => {
        const old = relativeTime(ago(30 * 86_400));
        expect(old).not.toMatch(/\d+d/);
        expect(relativeTime(ago(30 * 86_400), { suffix: true })).toBe(old);
    });

    it('never counts backwards when the server clock is ahead', () => {
        expect(relativeTime(new Date(NOW + 30_000).toISOString())).toBe('now');
        expect(relativeTime(new Date(NOW + FUTURE_SLACK * 1000).toISOString())).toBe('now');
    });

    it('never calls a date clearly in the future "now", and says so in a dev build', () => {
        // An approval with a week left read "Expires: now" because a future
        // time was clamped to zero. A deadline has no age.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const nextWeek = new Date(NOW + 7 * 86_400_000).toISOString();
            expect(relativeTime(nextWeek)).toBe('');
            expect(relativeTime(nextWeek, { suffix: true })).toBe('');
            expect(relativeTime(new Date(NOW + (FUTURE_SLACK + 60) * 1000).toISOString())).toBe('');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('future time'));
        } finally {
            warn.mockRestore();
        }
    });
});

describe('formatBytes', () => {
    it('returns empty for absent, zero and nonsense sizes', () => {
        expect(formatBytes(undefined)).toBe('');
        expect(formatBytes(null)).toBe('');
        expect(formatBytes(0)).toBe('');
        expect(formatBytes(-1)).toBe('');
        expect(formatBytes(Number.NaN)).toBe('');
    });

    it('spends a decimal only where it says something', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(2_516_582)).toBe('2.4 MB');
        expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    });

    it('carries on past MB, which one of the three old copies did not', () => {
        // The recording outbox capped at MB, so a 1.2 GB meeting read "1229 MB".
        expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.2 GB');
        expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB');
    });

    it('spells the kilobyte one way', () => {
        // The chat composer said "kB" and the upload queue said "KB", on two
        // screens a person moves between while attaching the same file.
        expect(formatBytes(4096)).toBe('4.0 KB');
    });
});

describe('plural', () => {
    it('drops the s at exactly one', () => {
        expect(plural(1, 'step')).toBe('1 step');
        expect(plural(0, 'step')).toBe('0 steps');
        expect(plural(2, 'step')).toBe('2 steps');
    });

    it('takes an irregular plural rather than making the caller write the phrase', () => {
        // The reason this is three arguments and not two: `plural(n, 'entry')`
        // would otherwise have to be spelled out at the call site as
        // `${n} ${n === 1 ? 'entry' : 'entries'}`, which is the duplication
        // this function exists to remove.
        expect(plural(1, 'entry', 'entries')).toBe('1 entry');
        expect(plural(4, 'entry', 'entries')).toBe('4 entries');
    });

    it('does not treat a negative or a fraction as singular', () => {
        expect(plural(0.5, 'source')).toBe('0.5 sources');
        expect(plural(-1, 'source')).toBe('-1 sources');
    });
});
