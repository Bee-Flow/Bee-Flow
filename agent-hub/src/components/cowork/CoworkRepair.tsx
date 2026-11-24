/**
 * A repair Cowork worked out, as one entry of the item's "Needs you" strip (./CoworkNeedsStrip.tsx): "Failed twice at
 * 'Read the order table'. A fix is ready." Opening it shows the steps that change, what the plan may newly do, how
 * the fix did on the past runs, and Approve / Not now. Nothing changes until the owner approves it.
 *
 * The details are ./CoworkProposalDetails.tsx, shared with the fixed-step offer on the Plan tab.
 */
import { useState } from 'react';
import { Wrench } from 'lucide-react';
import CoworkProposalDetails from './CoworkProposalDetails';
import { repairLine } from './coworkProposalModel';
import { useCoworkProposalActions } from '@/api/coworkProposals';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import type { CoworkProposal } from '@/api/coworkProposals';

const SECONDARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';
const PRIMARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)]';

export default function CoworkRepair({ coworkId, proposal }: { coworkId: string; proposal: CoworkProposal }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const { approve, dismiss } = useCoworkProposalActions(coworkId);
    const busy = approve.isPending || dismiss.isPending;
    const error = approve.error || dismiss.error;
    return (
        <div className="rounded-[10px] border px-3.5 py-2.5 flex flex-col gap-2 [border-color:var(--border-default)]" data-testid="cowork-repair">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex-1 min-w-[200px] inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-primary)]" data-testid="cowork-repair-line">
                    <Wrench aria-hidden="true" className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                    {repairLine(proposal, t)}
                </span>
                <button type="button" className={SECONDARY} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                    {open ? t('cowork_proposals.details.hide', 'Hide the fix') : t('cowork_proposals.details.show', 'See the fix')}
                </button>
            </div>
            {open && (
                <>
                    <CoworkProposalDetails proposal={proposal} t={t} />
                    <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_proposals.never_alone', 'Nothing changes until you approve it.')}</p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className={PRIMARY} disabled={busy} onClick={() => { dismiss.reset(); approve.mutate({ proposalId: proposal.id, fingerprint: proposal.fingerprint }); }}>
                            {approve.isPending ? t('cowork_proposals.approving', 'Approving…') : t('cowork_proposals.approve', 'Approve the fix')}
                        </button>
                        <button type="button" className={SECONDARY} disabled={busy} onClick={() => { approve.reset(); dismiss.mutate(proposal.id); }}>
                            {t('cowork_proposals.not_now', 'Not now')}
                        </button>
                    </div>
                </>
            )}
            {error && <p role="alert" className="text-[12.5px] text-[var(--error-ink)]">{errorMessage(error) || t('cowork_proposals.failed', 'That did not work. Try again.')}</p>}
        </div>
    );
}
