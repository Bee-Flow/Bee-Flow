import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import ControlFindingGroup, { isBlocking } from './ControlFindingGroup';
import { Strip, sectionNames } from './solutionNotices';

/**
 * "To check" — everything in this Solution that needs a person, and why the
 * publish button is or is not available.
 *
 * The list comes from GET /:id/completeness, which runs the app validator, the
 * automation validator on its own draft/activate stage, the dependency graph and
 * the empty-knowledge-base rule over the same members the graph was drawn from.
 * This file renders that answer and adds nothing to it.
 *
 * ── The one rule this screen must not get wrong ─────────────────────────────
 *
 * An empty list is what a clean Solution looks like AND what a failed request
 * looks like. So "nothing to fix" is only ever said when the server said
 * `complete: true` — never because `findings.length === 0`. Four states reach
 * this component and three of them are not "all clear":
 *
 *   loading           the answer has not arrived
 *   error / null      it did not arrive at all
 *   complete: false   it arrived, and part of the Solution could not be read
 *   complete: true    the only state in which silence means silence
 *
 * The last three all render a strip that says which, and in every one of them
 * the caller keeps the publish button disabled — `blocked !== false`, never
 * `findings.length > 0`.
 *
 * ── Blocking above advice ───────────────────────────────────────────────────
 *
 * The server sorts errors first; this file draws the line where the meaning
 * changes. A finding blocks when it is an error, or when the ladder tagged it
 * `blockedAt: 'publish'`. A completeness code on a DRAFT automation is neither: it
 * comes back as a warning tagged `blockedAt: 'activate'`, which is advice about
 * a flow somebody is still building and must not lock a release.
 */

export { isBlocking };

export default function SolutionControlPanel({ completeness, loading, error, onOpen, readOnly = false }) {
    const { t } = useTranslation();

    if (loading && !completeness) {
        return (
            <div className="flex items-center justify-center py-16 text-[var(--text-tertiary)]" aria-busy="true">
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            </div>
        );
    }

    // No answer at all. NOT "nothing to fix": the checks did not run, and the
    // caller keeps publishing disabled for exactly this reason.
    if (error || !completeness) {
        return (
            <Strip tone="var(--error)" icon={AlertTriangle} testId="solution-control-unreachable">
                {t('solutions.control_unreachable',
                    'The checks could not be run just now, so nothing here is confirmed. Publishing stays unavailable until they can.')}
            </Strip>
        );
    }

    const findings = Array.isArray(completeness.findings) ? completeness.findings : [];
    const blocking = findings.filter(isBlocking);
    const advice = findings.filter(f => !isBlocking(f));
    const gaps = sectionNames(completeness.unavailable, t);

    const summary = findings.length === 0
        ? null
        : blocking.length > 0
            ? { tone: 'bg-[color-mix(in_srgb,var(--error)_12%,transparent)] text-[var(--error)]', text: t('solutions.control_summary_blocking', '{n} to fix before publishing').replace('{n}', String(blocking.length)) }
            : { tone: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]', text: t('solutions.control_summary_advice', '{n} to look at').replace('{n}', String(advice.length)) };

    return (
        <div className="space-y-5">
            {summary && (
                <div className="flex flex-wrap items-center gap-2" data-testid="solution-control-summary">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums ${summary.tone}`}>{summary.text}</span>
                    <span className="text-xs text-[var(--text-tertiary)] tabular-nums">
                        {t('solutions.control_total', '{n} issues in total').replace('{n}', String(findings.length))}
                    </span>
                </div>
            )}
            {/* On a stage the findings are read-only: the part they point at is
                managed, and the way to fix it is in Dev. */}
            {readOnly && (
                <Strip tone="var(--text-tertiary)" icon={Info} testId="solution-control-readonly">
                    {t('solution_stages.control_readonly', 'This stage is read-only. Fix these in Dev and deploy a new release.')}
                </Strip>
            )}
            {completeness.complete === false && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="solution-control-incomplete">
                    {t('solutions.control_incomplete',
                        'Part of this Solution could not be read, so this list is not the whole story and publishing stays unavailable.')}
                    {gaps.length > 0 && <span className="block text-xs mt-1 text-[var(--text-tertiary)]">{gaps.join(', ')}</span>}
                </Strip>
            )}

            {/* The ONLY path to a reassuring sentence: the server said the
                picture was whole and held nothing. */}
            {completeness.complete === true && findings.length === 0 && (
                <Strip tone="var(--text-tertiary)" icon={CheckCircle2} testId="solution-control-clear">
                    {t('solutions.control_clear', 'Nothing needs your attention. Everything here is wired up and owned consistently.')}
                </Strip>
            )}

            <ControlFindingGroup title={t('solutions.control_blocking', 'Has to be fixed first')}
                   findings={blocking} onOpen={onOpen} readOnly={readOnly} t={t} />
            <ControlFindingGroup title={t('solutions.control_advice', 'Worth a look')}
                   findings={advice} onOpen={onOpen} readOnly={readOnly} t={t} />

            {completeness.complete === true && blocking.length === 0 && advice.length > 0 && (
                <Strip tone="var(--text-tertiary)" icon={Info} testId="solution-control-releasable">
                    {t('solutions.control_releasable', 'None of these stop you publishing — they are things to tidy when you get to them.')}
                </Strip>
            )}
        </div>
    );
}
