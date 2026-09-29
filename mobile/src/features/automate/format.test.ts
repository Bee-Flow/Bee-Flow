/**
 * The elapsed formatter, pinned.
 *
 * The other half of the argument made in features/recording/format.test.ts:
 * this `formatDuration` and that one share a name and a signature and cannot
 * share an implementation. What is written down here is the half that would be
 * lost by merging into a clock — sub-second resolution, and a null that reads
 * as "has not run" rather than as a zero.
 */

import {
    formatDuration,
    isLiveStatus,
    runElapsedMs,
    skipGroupOfStep,
    statusLabel,
    statusToken,
    tokenForSkip,
    tokenForStep,
    SKIP_REASONS,
    type SkipGroup,
} from './format';

describe('formatDuration (milliseconds → spoken elapsed)', () => {
    it('reports anything under a second in milliseconds', () => {
        // Not "0.4s", which this function's own doc comment claimed for as long
        // as it existed. A step that took 400ms is the kind of thing someone
        // reads while deciding whether a run is stuck, and rounding it into
        // seconds is exactly where the interesting resolution lives.
        expect(formatDuration(400)).toBe('400ms');
        expect(formatDuration(999)).toBe('999ms');
        expect(formatDuration(0)).toBe('0ms');
    });

    it('spends a decimal on the first ten seconds and then stops', () => {
        expect(formatDuration(1000)).toBe('1.0s');
        expect(formatDuration(9500)).toBe('9.5s');
        expect(formatDuration(12_000)).toBe('12s');
        expect(formatDuration(45_000)).toBe('45s');
    });

    it('switches to minutes and seconds, zero-padded', () => {
        expect(formatDuration(184_000)).toBe('3m 04s');
        expect(formatDuration(60_000)).toBe('1m 00s');
    });

    it('drops the seconds once it is counting hours', () => {
        // "1h 12m 30s" is more precision than anyone reads off a finished run,
        // and it wraps the meta slot on a narrow phone.
        expect(formatDuration(4_320_000)).toBe('1h 12m');
    });

    it('reads a missing duration as an em dash, not as zero', () => {
        // Deliberately NOT the recording copy's "0:00". `durationMs` is only
        // written when a run settles, so null here means "still going, or never
        // went" — and printing 0 for that claims a run finished instantly.
        expect(formatDuration(null)).toBe('—');
        expect(formatDuration(undefined)).toBe('—');
        expect(formatDuration(Number.NaN)).toBe('—');
    });

    it('never reports a negative elapsed', () => {
        expect(formatDuration(-40)).toBe('0ms');
    });
});

describe('runElapsedMs', () => {
    it('prefers the settled duration the server wrote', () => {
        expect(
            runElapsedMs({ durationMs: 1234, startedAt: null, finishedAt: null }),
        ).toBe(1234);
    });

    it('measures a finished run from its own timestamps', () => {
        expect(
            runElapsedMs({
                durationMs: null,
                startedAt: '2026-03-12T12:00:00.000Z',
                finishedAt: '2026-03-12T12:00:05.000Z',
            }),
        ).toBe(5000);
    });

    it('measures a running one against now, so the row is not "—" while it is interesting', () => {
        jest.useFakeTimers().setSystemTime(Date.parse('2026-03-12T12:00:30.000Z'));
        expect(
            runElapsedMs({
                durationMs: null,
                startedAt: '2026-03-12T12:00:00.000Z',
                finishedAt: null,
            }),
        ).toBe(30_000);
        jest.useRealTimers();
    });

    it('gives up rather than guessing when there is no start', () => {
        expect(runElapsedMs({ durationMs: null, startedAt: null, finishedAt: null })).toBeNull();
        expect(
            runElapsedMs({ durationMs: null, startedAt: 'not a date', finishedAt: null }),
        ).toBeNull();
    });
});

/**
 * The status vocabulary.
 *
 * A port of the web table, and until now an unchecked one: `pinned` and `info`
 * were simply absent, so a pinned step read as "Idle" on the phone and as
 * "Frozen data" on the desktop. statusLockstep.test.ts is the drift guard;
 * these are the behaviours the port owns on its own.
 */
describe('statusToken', () => {
    it('degrades an unknown status to idle rather than throwing', () => {
        expect(statusToken('weird_future_status').labelKey).toBe('run_status.idle');
        expect(statusToken(null).labelKey).toBe('run_status.idle');
        expect(statusToken(undefined).labelKey).toBe('run_status.idle');
        expect(statusToken('').labelKey).toBe('run_status.idle');
    });

    it('counts Object.prototype\'s own words among the unknowns', () => {
        // `TOKENS['constructor']` is truthy on every object literal, so the
        // `?? idle` never fired and the caller got the Object constructor back
        // — a "token" whose tone and labelKey are undefined, from the function
        // whose whole point is that an unknown status cannot break a screen.
        for (const status of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
            // (jest's expect takes one argument, so the loop variable stays
            // out of it — a failure names the line, and there are five.)
            expect([status, statusToken(status as never).labelKey]).toEqual([status, 'run_status.idle']);
            expect([status, statusToken(status as never).tone]).toEqual([status, 'neutral']);
        }
    });

    it('maps the three server aliases, case-insensitively', () => {
        expect(statusToken('failed').labelKey).toBe('run_status.error');
        expect(statusToken('FAILED').labelKey).toBe('run_status.error');
        expect(statusToken('awaiting_confirm').labelKey).toBe('run_status.awaiting_approval');
        expect(statusToken('paused_breakpoint').labelKey).toBe('run_status.paused');
    });

    it('knows the states the port used to be missing', () => {
        // A pinned step reading as "Idle" was not a small thing: it is the one
        // status that means "this output is not from this run".
        expect(statusToken('pinned').labelEn).toBe('Frozen data');
        // Its twin: same tone, different word — typed is not captured.
        expect(statusToken('edited').labelEn).toBe('Edited');
        expect(statusToken('edited').tone).toBe(statusToken('pinned').tone);
        expect(statusToken('info').labelEn).toBe('Info');
        expect(statusToken('nothing_to_do').labelEn).toBe('Nothing to do');
    });

    it('separates running from paused (CW-04)', () => {
        const running = statusToken('running');
        const paused = statusToken('paused');
        expect(running.tone).not.toBe(paused.tone);
        expect(running.icon).not.toBe(paused.icon);
        expect(running.labelKey).not.toBe(paused.labelKey);
        // Doing work is not a warning. While it was, the phone had no colour
        // left for the states that genuinely want attention.
        expect(running.tone).toBe('ai');
        expect(paused.tone).toBe('neutral');
    });

    it('agrees with the Cowork tab, which already drew a paused schedule grey', () => {
        expect(statusToken('paused').tone).toBe(statusToken('idle').tone);
    });
});

describe('statusLabel', () => {
    it('asks the translator for the key and offers the English as the fallback', () => {
        const seen: [string, string][] = [];
        const t = (key: string, fallback: string) => {
            seen.push([key, fallback]);
            return `NL:${key}`;
        };
        expect(statusLabel(t, statusToken('running'))).toBe('NL:run_status.running');
        expect(seen).toEqual([['run_status.running', 'Running']]);
    });

    it('renders the English when the catalogue has no entry', () => {
        expect(statusLabel((_k, fallback) => fallback, statusToken('success'))).toBe('Finished');
    });
});

describe('isLiveStatus', () => {
    it('is true only while a run can still move', () => {
        for (const status of ['running', 'queued', 'awaiting_approval', 'awaiting_form']) {
            expect(isLiveStatus(status)).toBe(true);
        }
        for (const status of ['success', 'error', 'cancelled', 'paused', 'skipped', 'idle']) {
            expect(isLiveStatus(status)).toBe(false);
        }
    });
});

describe('the skip matrix', () => {
    const EXPECTED: Record<string, SkipGroup> = {
        disabled: 'configured',
        note: 'configured',
        arrayref_unresolved: 'no_work',
        overref_unresolved: 'no_work',
        aggregate_field_absent: 'no_work',
        summarize_field_absent: 'no_work',
        datetime_unresolved_input: 'no_work',
        datatable_column_unknown: 'no_work',
        datatable_filter_unresolved: 'no_work',
        datatable_values_unresolved: 'no_work',
        knowledge_write_empty: 'no_work',
        knowledge_write_no_kb: 'no_work',
        knowledge_write_too_long: 'no_work',
        knowledge_write_refused: 'no_work',
        no_service_email: 'no_work',
        no_owner_email: 'no_work',
        not_sent: 'no_work',
        pinned: 'pinned',
    };

    it('classifies every reason code the runner can emit', () => {
        for (const [reason, group] of Object.entries(EXPECTED)) {
            expect([reason, SKIP_REASONS[reason]]).toEqual([reason, group]);
        }
        expect(Object.keys(SKIP_REASONS).sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    it('turns each code into the right token', () => {
        for (const [reason, group] of Object.entries(EXPECTED)) {
            const key = tokenForSkip(SKIP_REASONS[reason]).labelKey;
            const want =
                group === 'no_work'
                    ? 'run_status.nothing_to_do'
                    : group === 'pinned'
                      ? 'run_status.pinned'
                      : 'run_status.skipped';
            expect([reason, key]).toEqual([reason, want]);
        }
    });

    it('keeps a switched-off step out of the warning colour', () => {
        expect(statusToken('skipped').tone).toBe('neutral');
        expect(statusToken('nothing_to_do').tone).toBe('warning');
    });
});

describe('skipGroupOfStep / tokenForStep', () => {
    it('believes an explicit skippedReason first', () => {
        expect(skipGroupOfStep({ status: 'skipped', skippedReason: 'disabled' })).toBe('configured');
        expect(skipGroupOfStep({ status: 'skipped', skippedReason: 'knowledge_write_empty' })).toBe('no_work');
        expect(skipGroupOfStep({ status: 'skipped', skippedReason: 'invented_later' })).toBeNull();
    });

    it('does not read a reason off Object.prototype', () => {
        for (const reason of ['constructor', '__proto__', 'toString', 'valueOf']) {
            expect(skipGroupOfStep({ status: 'skipped', skippedReason: reason })).toBeNull();
            expect(tokenForStep({ status: 'skipped', skippedReason: reason }).labelKey).toBe('run_status.skipped');
        }
    });

    it('reads the shape of the output when the reason is missing', () => {
        expect(skipGroupOfStep({ status: 'skipped', output: { disabled: true } })).toBe('configured');
        expect(skipGroupOfStep({ status: 'skipped', output: { skipped: 'nothing to write' } })).toBe('no_work');
    });

    it('never decides on the words of the sentence, only on its presence', () => {
        expect(skipGroupOfStep({ status: 'skipped', output: { skipped: 'niets te doen' } })).toBe('no_work');
        expect(skipGroupOfStep({ status: 'skipped', output: { skipped: '  ' } })).toBeNull();
        expect(skipGroupOfStep({ status: 'skipped', output: { skipped: 7 } })).toBeNull();
    });

    it('leaves a skip it cannot explain grey', () => {
        for (const step of [null, undefined, {}, { status: 'skipped' }, { status: 'skipped', output: null }]) {
            expect(skipGroupOfStep(step)).toBeNull();
        }
        expect(tokenForStep({ status: 'skipped' }).labelKey).toBe('run_status.skipped');
    });

    it('separates the two skips, and passes every other status through', () => {
        expect(tokenForStep({ status: 'skipped', output: { disabled: true } }).labelKey).toBe('run_status.skipped');
        expect(tokenForStep({ status: 'skipped', output: { skipped: 'nothing' } }).labelKey).toBe('run_status.nothing_to_do');
        for (const status of ['success', 'error', 'running', 'pinned', 'weird_future_status']) {
            expect(tokenForStep({ status, output: { skipped: 'ignored' } })).toBe(statusToken(status));
        }
        expect(tokenForStep(null).labelKey).toBe('run_status.idle');
    });
});
