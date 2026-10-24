import { AlertTriangle, HelpCircle, Info, Loader2 } from 'lucide-react';
import React, { useMemo } from 'react';
import { readInstalls } from './releaseModel';
import type { InstallsBody } from './releaseModel';
import { Strip } from './solutionNotices';
import { useTranslation } from '../../../../hooks/useTranslation';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * Installations — how often this Solution has been installed, and why that number
 * is not a total.
 *
 * ── What is NOT here, and that is the design ───────────────────────────
 *
 * Blueprints are strictly org-scoped. This screen therefore shows only NUMBERS:
 * how many installations in this organisation, and how many elsewhere on this
 * instance. No project name, no owner, no organisation name, no time — and
 * deliberately no breakdown per organisation, because with a single installation,
 * an aggregate over one organisation is no longer an aggregate.
 *
 * That is not only an agreement with the server: `readInstalls` builds the answer
 * from an explicit allow-list of two fields, so a column that is added to the
 * answer next year does not automatically end up on this screen.
 *
 * ── The number is a LOWER BOUND, and it says so ───────────────────────
 *
 * Counted are projects ON THIS INSTANCE whose
 * `projects.installed_from_blueprint_id` points to a Blueprint of this Solution.
 * That is an installation from the gallery, or an installation from a FILE whose
 * origin the server has checked actually belongs to that Blueprint
 * (install.verifyClaimedBlueprint). What falls outside it by definition: a file that
 * someone installs on his own self-host, and an installation whose origin could not
 * be established. “3 installations” would therefore be a claim nobody can
 * substantiate; “at least 3 on this instance” is what can be known. That sentence
 * always appears when there is a number — there is no `complete: true` that could
 * remove it.
 *
 * ── Zero is an answer, unknown is a different answer ───────────────────
 *
 * Both halves can be unknown separately. An unknown half is NEVER zero — that is
 * the difference between “nobody uses this” and “we could not count it”, and
 * someone decides on precisely that difference whether to discard a Solution.
 */

/**
 * The count of this tab for the tab badge.
 *
 * NO BADGE AT ZERO, and that is not cosmetic. On a tab strip the sentence that
 * qualifies the number (“at least this many, on this instance only”) does not fit.
 * A number greater than zero survives that: it is a LOWER BOUND, and a lower bound
 * that is too low remains true. A “0” does not — it reads as “nobody uses this”,
 * while the counter by definition does not see an installation on another instance.
 * So zero, like unknown, does not appear on the tab strip; the tab itself does say
 * which of the two it is. The same shape as `controlBadge` next to it, which also
 * gives no “0” for an empty list of findings.
 */
export function installsBadge(remote: RemoteRead | null | undefined) {
    const { state, here, elsewhere } = readInstalls(remote);
    if (state !== 'ok') return { count: undefined };
    // One unknown half makes the TOTAL unknown: adding as if the other were zero
    // would put an invented sum on the tab.
    if (here === null || elsewhere === null) return { count: undefined };
    const total = here + elsewhere;
    return { count: total > 0 ? total : undefined };
}

/** One half of the count: a large card with a number, or the notice that it is not there. */
interface HalfProps {
    count: number | null;
    label: string;
    unknownPhrase: string;
    testId: string;
}

interface RemoteRead {
    status?: string;
    data?: InstallsBody | null;
}

function Half({ count, label, unknownPhrase, testId }: HalfProps) {
    const known = count !== null;
    return (
        <li className="flex flex-col gap-1 px-4 py-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
            data-testid={testId}>
            <span className={`text-2xl font-semibold tabular-nums ${known ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}
                  aria-hidden="true">
                {known ? count : '–'}
            </span>
            <span className={`text-sm ${known ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]'}`}>
                {known ? label : unknownPhrase}
            </span>
        </li>
    );
}

export default function SolutionInstallsTab({ remote }: { remote?: RemoteRead | null }) {
    const { t } = useTranslation();
    const { state, here, elsewhere } = useMemo(() => readInstalls(remote), [remote]);

    if (state === 'loading') {
        return (
            <div className="flex items-center justify-center py-16 text-[var(--text-tertiary)]">
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    // No answer is not zero. Without this line, a failed count reads as
    // “nobody has installed this”.
    if (state === 'unreadable') {
        return (
            <Strip tone="var(--error)" icon={AlertTriangle} testId="installs-unreadable">
                {t('solutions.installs_unknown',
                    'How often this Solution has been installed could not be read, so this is not "never".')}
            </Strip>
        );
    }

    return (
        <div className="space-y-4">
            <ul className="grid gap-3 sm:grid-cols-2">
                <Half
                    count={here} testId="installs-here"
                    label={nOf(t, 'solutions.installs_here', here || 0,
                        '{count} Solution in your organisation came from this Blueprint',
                        '{count} Solutions in your organisation came from this Blueprint')}
                    unknownPhrase={t('solutions.installs_here_unknown',
                        'How many were installed in your organisation could not be read.')}
                />
                <Half
                    count={elsewhere} testId="installs-elsewhere"
                    label={nOf(t, 'solutions.installs_elsewhere', elsewhere || 0,
                        '{count} other Solution elsewhere on this instance came from it',
                        '{count} other Solutions elsewhere on this instance came from it')}
                    unknownPhrase={t('solutions.installs_elsewhere_unknown',
                        'How many were installed elsewhere on this instance could not be read.')}
                />
            </ul>

            {/* Always stated whenever there is a number: there is no state in which
                this count is complete. */}
            <Strip tone="var(--text-tertiary)" icon={Info} testId="installs-incomplete">
                {t('solutions.installs_incomplete',
                    'These are at least this many — only installations on this instance are counted, and only where the install could be tied back to this Blueprint. A copy installed on another instance is invisible here.')}
            </Strip>

            {here === 0 && elsewhere === 0 && (
                <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="installs-none-yet">
                    {t('solutions.installs_none',
                        'No installation on this instance could be tied back to this Blueprint yet.')}
                </Strip>
            )}
        </div>
    );
}
