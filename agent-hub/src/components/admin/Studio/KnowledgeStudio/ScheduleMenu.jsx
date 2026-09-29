import { Check } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import AnchoredMenu from '../../../shared/AnchoredMenu';

/**
 * How often should this source fetch itself? (Knowledge artboard 1a's ⋯ menu
 * and 1b's "Verversen: <label> ▾" button.)
 *
 * ── PRESETS, NOT A CRON FIELD ───────────────────────────────────────
 * The server accepts any 5- or 6-field cron, and the three presets here are
 * the only ones this menu can produce. That is deliberate: a person choosing
 * how often their price list is re-read is not choosing a cron expression,
 * and a free-text field would let them write `*​/5 * * * *` and DDoS
 * their own supplier on a schedule nobody reviews. An operator who genuinely
 * needs a stranger cadence can PATCH the source; the field is not the
 * default affordance.
 *
 * ── THE MODES OFFERED ARE THE ONES THIS KIND HAS ────────────────────
 * `supportsModes` per kind is the server's list (sources.js
 * REFRESH_MODES_BY_KIND) — a web page cannot be "live" and a table has no
 * "after every meeting". Offering a mode the server refuses gets a 400 and
 * teaches that the product is broken, so the menu shows only what will work.
 *
 * ── AND THE TIMEZONE IS SAID OUT LOUD ───────────────────────────────
 * "Weekly, Monday 06:00" means nothing without saying whose six. The browser's
 * zone is what the schedule is written in, and the menu names it, because
 * someone in another office reading "06:00" would otherwise reasonably assume
 * theirs.
 */

/** What the menu can produce. Anything else came from an operator's PATCH. */
export const CRON_PRESETS = Object.freeze([
    { id: 'daily', cron: '0 6 * * *', labelKey: 'knowledge.schedule.daily', labelFallback: 'Every day at 06:00' },
    { id: 'weekly', cron: '0 6 * * 1', labelKey: 'knowledge.schedule.weekly', labelFallback: 'Every Monday at 06:00' },
    { id: 'monthly', cron: '0 6 1 * *', labelKey: 'knowledge.schedule.monthly', labelFallback: 'The 1st of each month at 06:00' },
]);

/** The zone a schedule is written in — named, never assumed. */
export function browserTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam'; }
    catch { return 'Europe/Amsterdam'; }
}

/**
 * The preset a stored cron corresponds to, or null when an operator wrote
 * something else. Null renders as "custom" rather than being silently shown
 * as one of the presets — a menu that mislabels the schedule it is about to
 * overwrite is worse than one that admits it does not recognise it.
 */
export function presetFor(cron) {
    const c = String(cron || '').trim();
    return CRON_PRESETS.find(p => p.cron === c) || null;
}

export default function ScheduleMenu({ open, onClose, anchorRef, source, onChange, align = 'right' }) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const tz = useMemo(browserTimezone, []);

    const modes = Array.isArray(source?.supportsModes) && source.supportsModes.length
        ? source.supportsModes
        : ['manual'];
    const mode = source?.refreshMode || 'manual';
    const preset = presetFor(source?.refreshCron);

    const choose = async (next) => {
        setBusy(true);
        try { await onChange?.(next); onClose?.(); }
        finally { setBusy(false); }
    };

    return (
        <AnchoredMenu
            open={open}
            onClose={onClose}
            anchorRef={anchorRef}
            align={align}
            width={280}
            role="menu"
            className="py-1.5 text-xs"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
        >
            <div className="px-3 pb-1.5 font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {t('knowledge.schedule.title', 'Refresh')}
            </div>

            {modes.map(m => (
                <Row
                    key={m}
                    selected={mode === m && (m !== 'schedule' || !preset)}
                    disabled={busy}
                    onClick={() => choose(m === 'schedule'
                        ? { mode: 'schedule', cron: CRON_PRESETS[1].cron, tz }
                        : { mode: m })}
                >
                    {t(`knowledge.schedule.mode_${m}`, MODE_EN[m] || m)}
                </Row>
            ))}

            {modes.includes('schedule') && (
                <>
                    <div className="my-1 h-px" style={{ background: 'var(--border-default)' }} />
                    {CRON_PRESETS.map(p => (
                        <Row
                            key={p.id}
                            selected={mode === 'schedule' && preset?.id === p.id}
                            disabled={busy}
                            onClick={() => choose({ mode: 'schedule', cron: p.cron, tz })}
                        >
                            {t(p.labelKey, p.labelFallback)}
                        </Row>
                    ))}
                    {mode === 'schedule' && !preset && (
                        <div className="px-3 py-1.5" style={{ color: 'var(--text-tertiary)' }}>
                            {t('knowledge.schedule.custom', 'Custom schedule ({cron})', { cron: source?.refreshCron || '' })}
                        </div>
                    )}
                    <div className="px-3 pt-1.5" style={{ color: 'var(--text-tertiary)' }}>
                        {t('knowledge.schedule.tz_note', 'Times are in {tz}.', { tz: source?.refreshTz || tz })}
                    </div>
                </>
            )}
        </AnchoredMenu>
    );
}

/**
 * The menu's own words, deliberately NOT the table's.
 *
 * `knowledge.refresh.*` is the 150px "Verversen" CELL — "manual", "live",
 * terse because it is a column. A menu row is a thing you are about to
 * choose, and "manual" is not a choice anyone can act on: "Only when I ask"
 * says what will happen. Two registers, so two key namespaces; sharing one
 * would force whichever screen lost the argument to read wrong.
 */
const MODE_EN = Object.freeze({
    manual: 'Only when I ask',
    schedule: 'On a schedule',
    on_change: 'When it changes',
    after_meeting: 'After every meeting',
    live: 'Live — always current',
});

function Row({ children, selected, disabled, onClick }) {
    return (
        <button
            type="button"
            role="menuitemradio"
            aria-checked={!!selected}
            disabled={disabled}
            onClick={onClick}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[var(--bg-secondary)] disabled:opacity-50"
            style={{ color: 'var(--text-primary)' }}
        >
            <Check
                className="w-3 h-3 shrink-0"
                style={{ opacity: selected ? 1 : 0, color: 'var(--accent-primary)' }}
                aria-hidden="true"
            />
            {children}
        </button>
    );
}
