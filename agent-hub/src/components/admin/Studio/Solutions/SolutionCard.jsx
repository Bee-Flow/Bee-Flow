import { AlertTriangle, ArrowUpCircle, CheckCircle2, HelpCircle, Info } from 'lucide-react';
import React from 'react';
import { countPhrase } from './solutionCounts';
import { sectionNames } from './solutionNotices';
import { chipsOf, healthOf, runsOf, updateOf } from './solutionOverviewModel';
import { useTranslation } from '../../../../hooks/useTranslation';
import { kindIcon, kindTileStyle, kindColorVar, kindTint } from '../../../shared/kindColors';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * One Solution, as a card on the overview.
 *
 * Every decision on it was made in solutionOverviewModel.js, which is pure and
 * carries the reasoning; this file turns those states into words and colour and
 * adds nothing to them. The one rule worth repeating here, because it is the
 * rule a renderer breaks by accident: THIS CARD MAY NOT INVENT GOOD NEWS. A
 * tally the server could not read arrives as `null`, and null must never paint
 * as a 0, a missing chip, or a green tick. So each of the three states that
 * mean "we do not know" has a visible treatment of its own:
 *
 *   health `unknown` / `unread`   a grey or red chip that says which
 *   runs `unknown`                a line that says the runs were not counted
 *   a count that came back null   a named gap under the chip row
 *
 * Colour follows index.css's documented rule: the WORDS take the `-ink` token,
 * the tint and the border take the raw one.
 */

const HEALTH_TONE = {
    unknown: { icon: HelpCircle, ink: 'var(--text-tertiary)', raw: 'var(--text-tertiary)' },
    unread: { icon: AlertTriangle, ink: 'var(--error-ink)', raw: 'var(--error)' },
    blocking: { icon: AlertTriangle, ink: 'var(--error-ink)', raw: 'var(--error)' },
    advice: { icon: Info, ink: 'var(--warning-ink)', raw: 'var(--warning)' },
    clear: { icon: CheckCircle2, ink: 'var(--success-ink)', raw: 'var(--success)' },
};

/**
 * The health chip's words.
 *
 * The two counted states go through `nOf` with their key written out, so the
 * `_plural` half exists as a literal the i18n guard can see. The two unknown
 * states carry a `title` as well: the chip has room for three words, and "Not
 * checked" without "so this is not a clean bill of health" is exactly the
 * reading this screen must not invite.
 */
function healthWords(t, health) {
    switch (health.state) {
        case 'blocking':
            return { label: nOf(t, 'solutions.card_health_blocking', health.count, '{count} thing to fix', '{count} things to fix') };
        case 'advice':
            return { label: nOf(t, 'solutions.card_health_advice', health.count, '{count} thing to look at', '{count} things to look at') };
        case 'unread':
            return {
                label: t('solutions.card_health_unread', 'Could not be fully read'),
                title: t('solutions.card_health_unread_hint',
                    'Part of this Solution could not be read, so how much needs fixing is not known.'),
            };
        case 'clear':
            return { label: t('solutions.card_health_clear', 'Complete') };
        default:
            return {
                label: t('solutions.card_health_unknown', 'Not checked'),
                title: t('solutions.card_health_unknown_hint',
                    'The checks did not run for this Solution, so this is not a clean bill of health.'),
            };
    }
}

function HealthChip({ health }) {
    const { t } = useTranslation();
    const tone = HEALTH_TONE[health.state] || HEALTH_TONE.unknown;
    const Icon = tone.icon;
    const { label, title } = healthWords(t, health);
    return (
        <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium flex-shrink-0"
            data-testid="solution-card-health"
            data-state={health.state}
            title={title}
            style={{ background: kindTintOf(tone.raw), color: tone.ink }}
        >
            <Icon className="w-3 h-3" aria-hidden="true" />
            {label}
        </span>
    );
}

/** A 14% tint of a raw status token — the chip recipe index.css documents. */
function kindTintOf(raw) {
    return `color-mix(in srgb, ${raw} 14%, transparent)`;
}

/**
 * "v1.5 available", and the honest silence around it.
 *
 * A chip appears for two of the four answers. `available` is the point of the
 * feature. `unknown` is here because without it the ABSENCE of a chip would
 * mean both "up to date" and "we could not tell", and the second one is the
 * answer this product refuses to round off. `current` and "not installed from a
 * Blueprint at all" render nothing, which now means exactly one thing.
 *
 * What is IN the new version is O4's question, not this screen's.
 */
function UpdateChip({ update }) {
    const { t } = useTranslation();
    if (!update || update.state === 'current') return null;
    if (update.state === 'available') {
        return (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium flex-shrink-0"
                  data-testid="solution-card-update" data-state="available"
                  style={{ background: kindTintOf('var(--warning)'), color: 'var(--warning-ink)' }}>
                <ArrowUpCircle className="w-3 h-3" aria-hidden="true" />
                {update.latestVersion === null
                    ? t('solutions.card_update_any', 'A newer version is available')
                    : t('solutions.card_update_available', 'v{version} available', { version: update.latestVersion })}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5 text-[11px] flex-shrink-0"
              data-testid="solution-card-update" data-state="unknown"
              style={{ color: 'var(--text-tertiary)' }}>
            <HelpCircle className="w-3 h-3" aria-hidden="true" />
            {t('solutions.card_update_unknown', 'Whether there is a newer version could not be checked')}
        </span>
    );
}

/** Icon + number per kind, and the kinds whose number could not be read. */
function CountChips({ row }) {
    const { t } = useTranslation();
    const { chips, unreadable } = chipsOf(row);
    if (chips.length === 0 && unreadable.length === 0) return null;
    return (
        <span className="flex flex-wrap items-center gap-1.5">
            {chips.map(({ section, kind, count }) => {
                const Icon = kindIcon(kind);
                const phrase = countPhrase(t, section, count);
                return (
                    <span
                        key={section}
                        data-testid="solution-card-chip"
                        data-section={section}
                        title={phrase}
                        aria-label={phrase}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-semibold tabular-nums"
                        style={{ background: kindTint(kind, 14), color: kindColorVar(kind) }}
                    >
                        {Icon && <Icon className="w-2.5 h-2.5" aria-hidden="true" />}
                        {count}
                    </span>
                );
            })}
            {/* A count that could not be read is NOT a missing chip. */}
            {unreadable.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px]"
                      data-testid="solution-card-counts-partial"
                      style={{ color: 'var(--text-tertiary)' }}>
                    <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                    {t('solutions.card_counts_partial', 'Not everything could be counted: {sections}',
                        { sections: sectionNames(unreadable, t).join(', ') })}
                </span>
            )}
        </span>
    );
}

/** How often this Solution ran today — including "nobody could tell". */
function RunLine({ row }) {
    const { t } = useTranslation();
    const runs = runsOf(row);
    if (runs.state === 'unknown') {
        return (
            <span className="inline-flex items-center gap-1.5" data-testid="solution-card-runs" data-state="unknown"
                  style={{ color: 'var(--text-tertiary)' }}>
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                {t('solutions.card_runs_unknown', 'Runs could not be counted')}
            </span>
        );
    }
    if (runs.state === 'idle') {
        return (
            <span data-testid="solution-card-runs" data-state="idle" style={{ color: 'var(--text-tertiary)' }}>
                {t('solutions.card_runs_idle', 'Nothing ran today')}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5" data-testid="solution-card-runs" data-state={runs.state}>
            <span style={{ color: 'var(--text-tertiary)' }}>
                {nOf(t, 'solutions.card_runs_today', runs.today, '{count} run today', '{count} runs today')}
            </span>
            {runs.state === 'failed' && (
                <span className="inline-flex items-center gap-1" style={{ color: 'var(--error-ink)' }}>
                    <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                    {/* The two English forms are identical on purpose — this
                        phrase follows "12 runs today", where "3 failed" reads
                        right either way. The PAIR still has to exist: a
                        language whose word for it inflects has nowhere else to
                        put the difference. */}
                    {nOf(t, 'solutions.card_runs_failed', runs.failed, '{count} failed', '{count} failed')}
                </span>
            )}
        </span>
    );
}

const ROLE_LABEL = {
    owner: ['solutions.card_role_owner', 'owner'],
    editor: ['solutions.card_role_editor', 'editor'],
    viewer: ['solutions.card_role_viewer', 'viewer'],
};

/** Role, and where this Solution came from. */
function SubLine({ row, update }) {
    const { t } = useTranslation();
    const role = ROLE_LABEL[row.permission] || ROLE_LABEL.viewer;
    const parts = [t(role[0], role[1])];
    if (row.installedFromBlueprintId) {
        parts.push(update && update.installedVersion !== null
            ? t('solutions.card_installed_at', 'installed at v{version}', { version: update.installedVersion })
            : t('solutions.card_installed_from', 'installed from a Blueprint'));
    }
    return (
        <span className="block text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}
              data-testid="solution-card-sub">
            {parts.join(' · ')}
        </span>
    );
}

export default function SolutionCard({ row, onOpen }) {
    const health = healthOf(row);
    const update = updateOf(row);
    const tile = kindTileStyle('solution', 36);

    return (
        <button
            type="button"
            onClick={() => onOpen?.(row)}
            className="flex flex-col gap-2.5 p-3.5 rounded-xl text-left border w-full"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)' }}
            data-testid="solutions-card"
            data-project={row.id}
        >
            <span className="flex items-start gap-2.5 w-full">
                <span style={tile.tile} aria-hidden="true">
                    <span className="text-lg leading-none">{row.icon || '📦'}</span>
                </span>
                <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {row.name}
                    </span>
                    <SubLine row={row} update={update} />
                </span>
                <HealthChip health={health} />
            </span>

            <CountChips row={row} />

            {row.description && (
                <span className="block text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                    {row.description}
                </span>
            )}

            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] mt-auto">
                <RunLine row={row} />
                <UpdateChip update={update} />
            </span>
        </button>
    );
}
