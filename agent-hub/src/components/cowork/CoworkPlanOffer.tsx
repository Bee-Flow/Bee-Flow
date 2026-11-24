/**
 * Cheaper with age, on the Plan tab: one quiet line, never in "Needs you" (an offer is not a need).
 *
 *   - An open offer: "One step can run without AI: the same in 20 of 20. See the proof." The proof is the step that
 *     becomes fixed and how the change did on the past runs, with "Make it a fixed step" and "Not now".
 *   - After it was approved, while it is still the plan: "Made fixed on 3 Dec 2026 · Undo". Undo approves the version
 *     before it again, through the normal checks.
 *
 * Says nothing otherwise. Reads the item's proposals itself (../../api/coworkProposals.ts).
 */
import { useState } from 'react';
import CoworkProposalDetails from './CoworkProposalDetails';
import { madeFixed, offerLine, openOffer } from './coworkProposalModel';
import { useCoworkProposalActions, useCoworkProposals } from '@/api/coworkProposals';
import { formatDate } from '@/utils/dateFormatters';
import { errorMessage } from '@/utils/caughtError';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { CoworkProposal } from '@/api/coworkProposals';

const LINK = 'underline underline-offset-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50';
const SECONDARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';

type Actions = ReturnType<typeof useCoworkProposalActions>;

function Offer({ offer, actions, t }: { offer: CoworkProposal; actions: Actions; t: TranslateFn }) {
    const [proof, setProof] = useState(false);
    const busy = actions.approve.isPending || actions.dismiss.isPending;
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-plan-offer">
            <p className="text-[12px] text-[var(--text-secondary)]">
                {offerLine(offer, t)}{' '}
                <button type="button" className={LINK} aria-expanded={proof} onClick={() => setProof((v) => !v)}>
                    {proof ? t('cowork_proposals.offer.hide_proof', 'Hide the proof') : t('cowork_proposals.offer.proof', 'See the proof')}
                </button>
            </p>
            {proof && (
                <div className="flex flex-col gap-2 pl-3 border-l border-[var(--border-subtle)]">
                    <p className="text-[12px] text-[var(--text-primary)]">
                        {t('cowork_proposals.offer.step', "'{step}' becomes a fixed step. It hands on what the AI handed on, without asking a model.", { step: offer.stepTitle ?? '' })}
                    </p>
                    <CoworkProposalDetails proposal={offer} t={t} />
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className={SECONDARY} disabled={busy} onClick={() => actions.approve.mutate({ proposalId: offer.id, fingerprint: offer.fingerprint })}>
                            {actions.approve.isPending ? t('cowork_proposals.approving', 'Approving…') : t('cowork_proposals.offer.approve', 'Make it a fixed step')}
                        </button>
                        <button type="button" className={SECONDARY} disabled={busy} onClick={() => actions.dismiss.mutate(offer.id)}>
                            {t('cowork_proposals.not_now', 'Not now')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function MadeFixed({ made, actions, t }: { made: CoworkProposal; actions: Actions; t: TranslateFn }) {
    const version = made.undoVersion;
    return (
        <p className="text-[12px] text-[var(--text-secondary)]" data-testid="cowork-plan-made-fixed">
            {t('cowork_proposals.offer.made_fixed', 'Made fixed on {date}', { date: formatDate(made.decidedAt) })}
            {version !== null && (
                <>
                    {' · '}
                    <button type="button" className={LINK} disabled={actions.restore.isPending} onClick={() => actions.restore.mutate(version)}>
                        {actions.restore.isPending ? t('cowork_proposals.offer.undoing', 'Undoing…') : t('cowork_proposals.offer.undo', 'Undo')}
                    </button>
                </>
            )}
        </p>
    );
}

export default function CoworkPlanOffer({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const list = useCoworkProposals(coworkId).data;
    const actions = useCoworkProposalActions(coworkId);
    const offer = openOffer(list);
    const made = offer ? null : madeFixed(list);
    const error = actions.approve.error || actions.dismiss.error || actions.restore.error;
    if (!offer && !made) return null;
    return (
        <div className="flex flex-col gap-1.5">
            {offer ? <Offer offer={offer} actions={actions} t={t} /> : made && <MadeFixed made={made} actions={actions} t={t} />}
            {error && <p role="alert" className="text-[12.5px] text-[var(--error-ink)]">{errorMessage(error) || t('cowork_proposals.failed', 'That did not work. Try again.')}</p>}
        </div>
    );
}
