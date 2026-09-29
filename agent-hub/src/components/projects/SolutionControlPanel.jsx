import { AlertTriangle, ArrowUpRight, CheckCircle2, Info, Loader2 } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { Strip, sectionNames } from './solutionNotices';

/**
 * "To check" — everything in this Solution that needs a person, and why the
 * publish button is or is not available.
 *
 * The list comes from GET /:id/completeness, which runs the app validator, the
 * routine validator on its own draft/activate stage, the dependency graph and
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
 * `blockedAt: 'publish'`. A completeness code on a DRAFT routine is neither: it
 * comes back as a warning tagged `blockedAt: 'activate'`, which is advice about
 * a flow somebody is still building and must not lock a release.
 */

const BLOCKED_AT_LABEL = {
    activate: ['solutions.blocks_activate', 'blocks turning it on'],
    publish: ['solutions.blocks_publish', 'blocks publishing'],
};

/** Does this finding stop a release? The publish gate's own rule, in one place. */
export function isBlocking(finding) {
    return finding?.severity === 'error' || finding?.blockedAt === 'publish';
}

/**
 * De rij van dit paneel — bewust NIET shared/FindingRow.
 *
 * Zelfde Finding-objecten, ander recept: een <li> in een genummerde lijst, een
 * zichtbare "Laat zien"-knop in plaats van een rij die zelf klikbaar is, en de
 * blockedAt-ladder ("blokkeert publiceren") die alleen op dit scherm iets
 * betekent. De naam staat er expliciet in, want twee componenten die allebei
 * `FindingRow` heten laten een lezer denken dat een wijziging in de gedeelde
 * rij ook dit scherm raakt — en dat is niet zo.
 */
function SolutionFindingRow({ finding, onOpen, t }) {
    const blocking = isBlocking(finding);
    const ladder = finding.blockedAt ? BLOCKED_AT_LABEL[finding.blockedAt] : null;
    return (
        <li className="flex items-start gap-2.5 px-3 py-2 rounded-lg" data-testid="solution-finding"
            style={{ background: 'var(--bg-secondary)' }}>
            <AlertTriangle
                className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
                style={{ color: blocking ? 'var(--error)' : 'var(--warning)' }}
                aria-hidden="true"
            />
            <span className="flex-1 min-w-0">
                <span className="block text-sm" style={{ color: 'var(--text-primary)' }}>
                    {finding.message}
                </span>
                {(finding.remediation || ladder) && (
                    <span className="block text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {ladder && <span className="mr-1.5">{t(ladder[0], ladder[1])} ·</span>}
                        {finding.remediation}
                    </span>
                )}
            </span>
            {/* A link only where the server could name a row to open. A
                validator that saw only a definition has no id, and a button to
                nowhere is worse than no button. */}
            {finding.deepLink && (
                <button
                    onClick={() => onOpen?.(finding.deepLink)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs flex-shrink-0"
                    style={{ color: 'var(--text-secondary)' }}
                    data-testid="solution-finding-open"
                >
                    {t('solutions.show_me', 'Show me')}
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                </button>
            )}
        </li>
    );
}

function Group({ titleKey, fallback, findings, onOpen, t }) {
    if (findings.length === 0) return null;
    return (
        <div>
            <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                {t(titleKey, fallback)}
            </h3>
            <ul className="space-y-1.5">
                {findings.map((f, i) => (
                    <SolutionFindingRow key={`${f.code}-${f.targetRef?.id || 'x'}-${i}`} finding={f} onOpen={onOpen} t={t} />
                ))}
            </ul>
        </div>
    );
}

export default function SolutionControlPanel({ completeness, loading, error, onOpen }) {
    const { t } = useTranslation();

    if (loading && !completeness) {
        return (
            <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
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

    return (
        <div className="space-y-5">
            {completeness.complete === false && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="solution-control-incomplete">
                    {t('solutions.control_incomplete',
                        'Part of this Solution could not be read, so this list is not the whole story and publishing stays unavailable.')}
                    {gaps.length > 0 && <span className="block text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{gaps.join(', ')}</span>}
                </Strip>
            )}

            {/* The ONLY path to a reassuring sentence: the server said the
                picture was whole and held nothing. */}
            {completeness.complete === true && findings.length === 0 && (
                <Strip tone="var(--text-tertiary)" icon={CheckCircle2} testId="solution-control-clear">
                    {t('solutions.control_clear', 'Nothing needs your attention. Everything here is wired up and owned consistently.')}
                </Strip>
            )}

            <Group titleKey="solutions.control_blocking" fallback="Has to be fixed first"
                   findings={blocking} onOpen={onOpen} t={t} />
            <Group titleKey="solutions.control_advice" fallback="Worth a look"
                   findings={advice} onOpen={onOpen} t={t} />

            {completeness.complete === true && blocking.length === 0 && advice.length > 0 && (
                <Strip tone="var(--text-tertiary)" icon={Info} testId="solution-control-releasable">
                    {t('solutions.control_releasable', 'None of these stop you publishing — they are things to tidy when you get to them.')}
                </Strip>
            )}
        </div>
    );
}
