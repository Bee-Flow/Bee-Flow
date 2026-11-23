/**
 * Trust per step and recipient, under the levels of independence (./CoworkIndependence.tsx): "You let 'Mail the
 * supplier' to orders@… through 5 times. Let it go on its own?" A step that earned it can be let go; a trusted one can
 * always be asked about again. Says nothing while no step has been decided on.
 */
import { useCoworkTrust, type TrustEntry, type TrustState } from '../../api/coworkIndependence';
import type { TranslateFn } from '../../hooks/useTranslation';

const BUTTON = 'px-2.5 py-1 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50';

function lineOf(entry: TrustEntry, state: TrustState, t: TranslateFn): string {
    const to = entry.recipient === '*' ? t('cowork_plan.trust.any', 'the addresses it picks') : entry.recipient;
    if (entry.trusted) return t('cowork_plan.trust.on_its_own', '"{step}" to {to} goes on its own.', { step: entry.title, to });
    if (entry.canTrust) return t('cowork_plan.trust.offer', 'You let "{step}" to {to} through {count} times. Let it go on its own?', { step: entry.title, to, count: entry.letThrough });
    if (!state.ceilingAllows) return t('cowork_plan.trust.ceiling', 'Your organisation does not let a cowork act on its own.');
    return t('cowork_plan.trust.counting', '"{step}" to {to}: let through {count} of {needed} times.', { step: entry.title, to, count: entry.letThrough, needed: state.needed });
}

export default function CoworkTrust({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const { query, choose } = useCoworkTrust(coworkId);
    const state = query.data;
    if (!state || !Array.isArray(state.entries) || state.entries.length === 0) return null;
    return (
        <ul className="flex flex-col gap-1.5" data-testid="cowork-trust">
            {state.entries.map((entry) => (
                <li key={`${entry.stepId}|${entry.recipient}`} className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-[var(--text-secondary)]">
                    <span>{lineOf(entry, state, t)}</span>
                    {(entry.canTrust || entry.trusted) && (
                        <button type="button" className={BUTTON} disabled={choose.isPending} onClick={() => choose.mutate({ stepId: entry.stepId, recipient: entry.recipient, trusted: !entry.trusted })}>
                            {entry.trusted ? t('cowork_plan.trust.ask_again', 'Ask me again') : t('cowork_plan.trust.allow', 'Let it go on its own')}
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}
