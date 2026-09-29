import { AlertCircle, AlertTriangle, Info } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { attentionSourceNames, runAttentionChecks, summarizeAttention } from './attentionChecks';
import { attentionPath } from './attentionLink';
import { useTranslation } from '../../../../hooks/useTranslation';
import FindingRow from '../../../shared/FindingRow';
import { kindColorVar, kindIcon } from '../../../shared/kindColors';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * "Needs attention" — the list at the top of Studio's Start screen.
 *
 * Every row is a shared/FindingRow, the same row the automation canvas draws
 * for a validation record, so a thing that needs a person looks the same
 * wherever it is shown. What is NOT copied from the canvas's pill is its
 * empty behaviour: the pill renders nothing at all when there is nothing to
 * say, because a healthy automation should carry no visual noise. This screen
 * has to say something, because on a front door "no rows" is a sentence
 * people read as "everything is fine", and that is only one of the two ways
 * this list can be short.
 *
 * ── The three states, and their three sentences ─────────────────────────────
 *
 *   nothing found, everything checked   "Nothing needs attention."
 *   nothing found, a check fell over    "…some checks could not run…", WITH the
 *                                       names of the ones that did not answer
 *   nothing found, a check was capped   "…the busiest part…" — nothing broke,
 *                                       the organisation is simply bigger than
 *                                       the budget, and that is a different
 *                                       sentence from a breakdown
 *   rows found, a check fell over       the rows, and above them the warning
 *
 * Naming the gap matters as much as reporting it: a grey line that says "some
 * checks could not run" every single day, without saying which, cannot be
 * acted on and cannot be seen to have changed.
 *
 * The middle one is the one that is usually written as the first, and
 * `complete` (GET /api/studio/attention's own field, carried through
 * attentionChecks.js) is the only thing that tells them apart.
 * StudioSearchOverlay draws the same distinction over the same kind of
 * partial answer; projects/completeness.js is where the rule comes from.
 *
 * ── Rows that are not on the list are counted, not dropped ──────────────────
 *
 * Two things can keep a finding off the screen and both are announced:
 * `hidden` is a kind this build has no tile for, `truncated` is what the
 * endpoint found beyond its per-source cap. The number of things that need a
 * person is not something a client may quietly revise downwards, and the
 * count in the header is the true total, not the drawn one.
 *
 * ── One fetch, on mount ─────────────────────────────────────────────────────
 *
 * No polling. The rail already polls GET /api/studio/counts every 30s for the
 * numbers, and the endpoint behind this list caches for a minute per user;
 * a second timer on the same screen would buy nothing but load. It refreshes
 * when the screen is opened again.
 */

/** The severity of the worst row on the list — the header's tone and glyph. */
function headline(items) {
    if (items.some((i) => i.severity === 'error')) return { tone: 'var(--error)', Icon: AlertCircle };
    if (items.some((i) => i.severity === 'warning')) return { tone: 'var(--warning)', Icon: AlertTriangle };
    return { tone: 'var(--text-tertiary)', Icon: Info };
}

/**
 * The one line under the heading. EXACTLY ONE of three, and the first two are
 * the pair this screen exists to keep apart: "we looked and found nothing" is
 * a different sentence from "we could not look everywhere", and rendering the
 * clean one over a half-read answer is the fail-open O2 phase 1 shipped once.
 */
function StatusLine({ t, locale, total, complete, unavailable, capped }) {
    const broken = attentionSourceNames(unavailable, t, locale);
    const cappedNames = attentionSourceNames(capped, t, locale);
    // Which ones did not answer. Never a bare "some checks": a person who sees
    // that line every day cannot tell whether it is the same source each time.
    // Geen meervoudspaar: de zin somt namen op en verandert niet met het
    // aantal — een tweede sleutel met dezelfde tekst is werk voor de vertaler
    // en niets voor de lezer.
    const which = broken.length > 0
        ? ` ${t('studio.attention.unavailable_named', 'Not checked: {sections}.', { sections: broken.join(', ') })}`
        : '';
    // A cap is a SIZE, not a failure — its own sentence, because "something
    // went wrong" over an organisation that is simply large is a warning
    // people learn to ignore.
    const cappedLine = cappedNames.length > 0
        ? ` ${nOf(t, 'studio.attention.capped', cappedNames.length,
            'One check covered only the busiest part of {sections}.',
            'Some checks covered only the busiest part of {sections}.',
            { sections: cappedNames.join(', ') })}`
        : '';

    if (total === 0 && complete) {
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]" data-testid="studio-attention-empty">
                {t('studio.attention.empty', 'Nothing needs attention.')}
            </p>
        );
    }
    // Nothing found, but not everything was looked at. Which of the two
    // reasons it was decides the sentence.
    if (total === 0) {
        if (broken.length === 0 && cappedNames.length > 0) {
            return (
                <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]" data-testid="studio-attention-empty-capped">
                    {t('studio.attention.empty_capped', 'Nothing was found in the part that was checked — this is not the whole organisation.')}
                    {cappedLine}
                </p>
            );
        }
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]" data-testid="studio-attention-empty-unchecked">
                {t('studio.attention.empty_unchecked', 'Some checks could not run, so this is not the whole picture — not a clean bill of health.')}
                {which}
                {cappedLine}
            </p>
        );
    }
    if (!complete) {
        if (broken.length === 0 && cappedNames.length > 0) {
            return (
                <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]" data-testid="studio-attention-partial-capped">
                    {t('studio.attention.partial_capped', 'This covers the part that was checked, not the whole organisation.')}
                    {cappedLine}
                </p>
            );
        }
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]" data-testid="studio-attention-partial">
                {t('studio.attention.partial', 'Some checks could not run, so this list may be incomplete.')}
                {which}
                {cappedLine}
            </p>
        );
    }
    return null;
}

/** What is NOT on the list above, said out loud: capped, undrawable, or not yours. */
function Footnotes({ t, truncated, hidden, skipped }) {
    return (
        <>
            {truncated > 0 && (
                <p className="mt-1.5 text-[11.5px] text-[var(--text-tertiary)]" data-testid="studio-attention-more">
                    {nOf(t, 'studio.attention.more', truncated,
                        '{count} more was found but is not shown here.',
                        '{count} more were found but are not shown here.')}
                </p>
            )}
            {hidden > 0 && (
                <p className="mt-1.5 text-[11.5px] text-[var(--text-tertiary)]" data-testid="studio-attention-hidden">
                    {nOf(t, 'studio.attention.hidden', hidden,
                        '{count} more thing needs attention that this version cannot show.',
                        '{count} more things need attention that this version cannot show.')}
                </p>
            )}
            {/* Not a gap: a source somebody else is responsible for. Said once,
                quietly, so a short list is not mistaken for a whole one. */}
            {skipped.length > 0 && (
                <p className="mt-1.5 text-[11.5px] text-[var(--text-tertiary)]" data-testid="studio-attention-skipped">
                    {t('studio.attention.skipped', 'Some checks only run for the people who can act on them.')}
                </p>
            )}
        </>
    );
}

export default function AttentionList({ user = null, hasFeature = null, onNavigate = null }) {
    const { t, locale } = useTranslation();
    const [state, setState] = useState(null);

    // The context values change identity on every render of the providers
    // above; the run must not. It is keyed on who is asking, and nothing else.
    const ctxRef = useRef({ user, hasFeature });
    const userId = user?.id || null;

    // Kept fresh in an effect, not during render: a ref written while
    // rendering is a render with a side effect. Declared BEFORE the effect
    // that reads it, which is the order effects run in.
    useEffect(() => { ctxRef.current = { user, hasFeature }; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const result = await runAttentionChecks(ctxRef.current);
            if (!cancelled) setState(result);
        })();
        return () => { cancelled = true; };
    }, [userId]);

    const view = useMemo(() => (state ? summarizeAttention(state) : null), [state]);

    // Nothing is claimed before the first answer lands. A count or a
    // reassurance drawn over an unfinished fetch is a claim this screen cannot
    // back yet — the same rule the rail keeps for its counts.
    if (!view) return null;

    const { items, hidden, truncated, total, complete, skipped, unavailable, capped } = view;
    const { tone, Icon } = headline(items);

    return (
        <section className="mt-6 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3" data-testid="studio-attention">
            <div className="flex items-center gap-2">
                {total > 0 && <Icon className="w-4 h-4 flex-shrink-0" style={{ color: tone }} strokeWidth={1.75} aria-hidden="true" />}
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('studio.attention.title', 'Needs attention')}
                </h2>
                {total > 0 && (
                    <span className="text-[11.5px] text-[var(--text-tertiary)]" data-testid="studio-attention-count">
                        {nOf(t, 'studio.attention.count', total, '{count} thing needs attention', '{count} things need attention')}
                    </span>
                )}
            </div>

            <StatusLine
                t={t} locale={locale} total={total} complete={complete}
                unavailable={unavailable} capped={capped}
            />

            {items.length > 0 && (
                <div className="mt-2 space-y-1.5 text-xs max-h-[40vh] overflow-y-auto custom-scrollbar">
                    {items.map((item) => {
                        const path = attentionPath(item);
                        const KindIcon = kindIcon(item.kind);
                        return (
                            <FindingRow
                                key={item.key}
                                code={item.finding.code}
                                severity={item.severity}
                                // The producer's own sentence, which already
                                // names the object; this client's line for the
                                // source only when the row carried none.
                                message={item.message || t(item.labelKey, item.labelFallback)}
                                hint={item.remediation}
                                icon={KindIcon
                                    ? <KindIcon className="w-3.5 h-3.5 flex-shrink-0 mt-px" style={{ color: kindColorVar(item.kind) }} strokeWidth={1.75} aria-hidden="true" />
                                    : null}
                                onOpen={path && onNavigate ? () => onNavigate(path) : null}
                                openLabel={t('studio.attention.show_me', 'Show me')}
                                testId={`studio-attention-item-${item.finding.code}`}
                            />
                        );
                    })}
                </div>
            )}

            <Footnotes t={t} truncated={truncated} hidden={hidden} skipped={skipped} />
        </section>
    );
}
