/**
 * What a proposal of Cowork's own would change, in plain words: the steps that change, what the plan may newly do (the
 * server's `widens` sentences), and how it did on the past runs. Presentation only; ./CoworkRepair.tsx and
 * ./CoworkPlanOffer.tsx decide when it shows and what can be done with it.
 */
import { replayLine } from './coworkProposalModel';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { CoworkProposal, ProposalChange } from '@/api/coworkProposals';

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';
const CHANGE_FALLBACK: Record<ProposalChange['change'], string> = { added: 'New', changed: 'Changed', removed: 'Removed' };

export default function CoworkProposalDetails({ proposal, t, compact = false }: { proposal: CoworkProposal; t: TranslateFn; compact?: boolean }) {
    return (
        <div className="flex flex-col gap-2.5" data-testid="cowork-proposal-details">
            {proposal.changes.length > 0 && (
                <div className="flex flex-col gap-1">
                    <span className={LABEL}>{t('cowork_proposals.changes_heading', 'What changes')}</span>
                    <ul className="flex flex-col gap-0.5">
                        {proposal.changes.map((c) => (
                            <li key={c.id} className="text-[12px] text-[var(--text-secondary)]" data-testid={`cowork-proposal-change-${c.id}`}>
                                <span className="font-medium text-[var(--text-primary)]">{t(`cowork_proposals.change.${c.change}`, CHANGE_FALLBACK[c.change])}</span> · {c.title}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <div className="flex flex-col gap-1">
                <span className={LABEL}>{t('cowork_proposals.widens.heading', 'What it may newly do')}</span>
                {proposal.widens.length === 0
                    ? <span className="text-[12px] text-[var(--text-secondary)]">{t('cowork_proposals.widens.none', 'Nothing it could not do before.')}</span>
                    : (
                        <ul className="flex flex-col gap-0.5" data-testid="cowork-proposal-widens">
                            {proposal.widens.map((w) => <li key={w} className="text-[12px] text-[var(--warning-ink)]">{w}</li>)}
                        </ul>
                    )}
            </div>
            {(!compact || proposal.replay) && <div className="flex flex-col gap-1">
                <span className={LABEL}>{t('cowork_proposals.replay.heading', 'On the past runs')}</span>
                <span className="text-[12px] text-[var(--text-secondary)]" data-testid="cowork-proposal-replay">{replayLine(proposal.replay, t)}</span>
            </div>}
        </div>
    );
}
