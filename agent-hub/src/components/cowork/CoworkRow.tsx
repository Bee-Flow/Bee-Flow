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
import { relativeTime } from './coworkFormat';
import { cadenceLine, describeMoment } from './coworkSchedule';
import { coworkStatus } from './coworkStatus';
import { describeMailTrigger, isMailTriggerItem } from './mailTrigger';
import { howLine } from './coworkHomeModel';
import { goalCountText } from './coworkGoalModel';
import useTranslation from '../../hooks/useTranslation';
import { statusLabel } from '../shared/statusTokens';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { CoworkItem } from '../../api/cowork.types';
import type { HowItWorks } from '../../api/coworkHome';
import ReviewCountPill from './ReviewCountPill';

// The list header shows the same pill, over every item.
export { ReviewCountPill };

interface CoworkRowProps {
    item: CoworkItem;
    selected: boolean;
    onSelect: (id: string) => void;
    /** How it works ("4 fixed steps, 2 AI, asks before sending"), from Cowork's home. */
    how?: HowItWorks | null;
}

/** The left half of the meta line: when this runs. */
function whenText(item: CoworkItem, t: TranslateFn): string {
    // Started by a new email, not by a clock: there is no moment to print.
    if (isMailTriggerItem(item)) return describeMailTrigger(item.trigger, t);
    // A days-of-week spec with no interval is still a repeat: it is how the server stores "every Monday at 07:00"
    // (routes/cowork.js counts it as repeating for exactly this reason).
    if (item.repeatInterval || (Array.isArray(item.daysOfWeek) && item.daysOfWeek.length > 0)) return cadenceLine(item, t);
    // A one-off. Its moment is only a promise while it is still switched on;
    // a paused item keeps a stale `nextRunAt` the server will never honour.
    if (item.isActive && item.nextRunAt) return describeMoment(item.nextRunAt);
    return '';
}

/** The right half of the meta line: how it has been going. */
function historyText(item: CoworkItem, t: TranslateFn): string {
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

export default function CoworkRow({ item, selected, onSelect, how = null }: CoworkRowProps) {
    const { t } = useTranslation();
    const status = coworkStatus(item);
    const word = statusLabel(t, status);
    // The neutral rows (paused, queued, idle) carry no token of their own —
    // "this state makes no claim" is what tertiary grey looks like.
    const tone = status.cssVar || 'var(--text-tertiary)';
    const meta = [whenText(item, t), historyText(item, t)].filter(Boolean).join(' · ');
    const reviews = item.openReviewCount || 0;
    const works = howLine(how, t);
    // The goal's latest count, the thing a reader of the list wants to see move.
    const goal = how?.goal ? t('cowork_goals.row', 'Goal: {count}', { count: goalCountText(how.goal, t) }) : '';

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
                <span className="text-[12.5px] font-medium truncate text-[var(--text-primary)]">
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

            {(meta || reviews > 0) && (
                <p
                    className="mt-1.5 flex items-center gap-1.5 min-w-0 truncate text-[11px] text-[var(--text-tertiary)]"
                >
                    {/* Runs waiting for the owner: the thing to notice on this row. */}
                    <ReviewCountPill count={reviews} testId="cowork-row-review-count" />
                    <span className="truncate">{meta}</span>
                </p>
            )}
            {works && <p className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary)]" data-testid="cowork-row-how">{works}</p>}
            {goal && <p className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)]" data-testid="cowork-row-goal">{goal}</p>}
        </button>
    );
}
