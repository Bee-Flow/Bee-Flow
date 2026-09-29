/**
 * One row in the Cowork list.
 *
 * Two lines, and no more (CW-03): the title with its status WORD on the right,
 * and under it one grey line saying when the thing runs and how it has been
 * going — "Every weekday 08:00 · ran 42 times", "Monday 07:00 · last run 2d
 * ago".
 *
 * What went, and why:
 *
 *   - the two-line prompt preview. It was there because titles are derived
 *     from the brief and half of them start the same way — but six items of
 *     four lines each turn a 330px column into a wall, and the brief in full
 *     is one click away in the detail. The list's job is "is anything wrong,
 *     and when does this next happen".
 *   - the four loose chips (repeat, next run, "ran 3h ago", agent). They
 *     wrapped onto a second row the moment an agent name was long, which made
 *     rows different heights for no reason the reader could see. One sentence
 *     says the same two facts and always fits.
 *
 * What arrived: the status as a WORD, not only a coloured mark. A colour alone
 * told a screen reader nothing at all, and told a colour-blind reader almost
 * nothing — `running` and `paused` were the identical amber until CW-04, and
 * even after that split, telling two greys apart is not decoding anyone should
 * have to do to learn that their work is switched off.
 */
import React from 'react';
import { relativeTime } from './coworkFormat';
import { describeMoment, repeatLabel } from './coworkSchedule';
import { coworkStatus } from './coworkStatus';
import useTranslation from '../../hooks/useTranslation';
import { statusLabel } from '../shared/statusTokens';

/** Weekday tokens exactly as the server stores them, Sunday first. */
const DOW_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * "Monday, Thursday" for a `daysOfWeek` spec, in the reader's own locale.
 *
 * Always in WEEK order, never the order the array happened to arrive in: the
 * composer builds the list from whatever the user said, so `['thu','mon']` is
 * an ordinary payload and "Thursday, Monday" would be an odd way to read it
 * back. Noon on the anchor dates, not midnight — a DST jump that lands exactly
 * on midnight (Chile, Brazil) would otherwise name the wrong day.
 */
function weekdayNames(days) {
    const set = new Set(days.map(d => String(d).toLowerCase()));
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
    return DOW_TOKENS
        .map((tok, i) => (set.has(tok) ? fmt.format(new Date(2024, 0, 7 + i, 12)) : null))
        .filter(Boolean)
        .join(', ');
}

/** The left half of the meta line: when this runs. */
function whenText(item, t) {
    if (item.repeatInterval) {
        const label = repeatLabel(item.repeatInterval, t);
        return item.timeOfDay ? `${label} ${item.timeOfDay}` : label;
    }
    // A days-of-week spec with no interval is still a repeat — it is how the
    // server stores "every Monday at 07:00" (see routes/cowork.js, which
    // counts it as repeating for exactly this reason).
    if (Array.isArray(item.daysOfWeek) && item.daysOfWeek.length > 0) {
        const days = weekdayNames(item.daysOfWeek);
        return item.timeOfDay ? `${days} ${item.timeOfDay}` : days;
    }
    // A one-off. Its moment is only a promise while it is still switched on;
    // a paused item keeps a stale `nextRunAt` the server will never honour.
    if (item.isActive && item.nextRunAt) return describeMoment(item.nextRunAt);
    return '';
}

/** The right half of the meta line: how it has been going. */
function historyText(item, t) {
    // While something is running, "last run 3h ago" is about the run BEFORE
    // this one — true, and the wrong thing to read beside a live status. The
    // tally is the fact that still means something there.
    const running = item.lastStatus === 'running';
    if (!running && item.lastRunAt) {
        return t('cowork.row.last_run', 'last run {when}', { when: relativeTime(item.lastRunAt) });
    }
    if (item.runCount > 0) {
        return t(
            item.runCount === 1 ? 'cowork.row.run_count_one' : 'cowork.row.run_count',
            item.runCount === 1 ? 'ran once' : 'ran {count} times',
            { count: item.runCount },
        );
    }
    // Never run and nothing scheduled to say — better an empty line than a
    // "ran 0 times" that reads as a failure.
    return '';
}

export default function CoworkRow({ item, selected, onSelect }) {
    const { t } = useTranslation();
    const status = coworkStatus(item);
    const word = statusLabel(t, status);
    // The neutral rows (paused, queued, idle) carry no token of their own —
    // "this state makes no claim" is what tertiary grey looks like.
    const tone = status.cssVar || 'var(--text-tertiary)';
    const meta = [whenText(item, t), historyText(item, t)].filter(Boolean).join(' · ');

    return (
        <button
            type="button"
            data-testid="cowork-row"
            data-cowork-id={item.id}
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(item.id)}
            className="w-full text-left px-3 py-2.5 rounded-[10px] transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{
                background: selected ? 'var(--bg-card)' : 'transparent',
                boxShadow: selected ? 'var(--shadow-sm)' : 'none',
            }}
        >
            <div className="flex items-center gap-2 min-w-0">
                <span className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {item.title || t('cowork.row.untitled', 'Untitled cowork')}
                </span>
                <span
                    data-status-key={status.labelKey}
                    className={`ml-auto flex-shrink-0 inline-flex items-center gap-1.5 text-[10.5px] ${status.solid}`}
                >
                    <span
                        aria-hidden="true"
                        className="w-[7px] h-[7px] rounded-full flex-shrink-0"
                        style={{ background: tone }}
                    />
                    {word}
                </span>
            </div>

            {meta && (
                <p
                    className="mt-1.5 text-[11px] truncate"
                    style={{ color: 'var(--text-tertiary)' }}
                >
                    {meta}
                </p>
            )}
        </button>
    );
}
