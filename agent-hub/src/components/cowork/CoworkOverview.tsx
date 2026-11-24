/**
 * The Overview of one item (./CoworkDetail.tsx): what a regular user needs, calm and in plain words. Under the "Needs
 * you" strip, top to bottom:
 *
 *   1. one sentence of what it does and when, and what holds about sending (./coworkOverviewModel.ts);
 *   2. the goal line (./CoworkGoal.tsx);
 *   3. the last runs as plain lines: when, a status word, and the run's own one-line outcome, the same words the run
 *      list uses (./CoworkRunHistory.tsx RunOutcomeText). A line opens that run under Advanced → Runs;
 *   4. offers, one line and one button each, only when they apply: make it routine, and a step that can run without AI.
 *      A ready repair is a need, so it is in the strip above. Each opens Advanced → Plan, where it is decided.
 *   5. a slot for notes about the item (`notes`), such as a change Cowork made on its own.
 *
 * Everything here reads data the detail already reads (one runs request, one plan request); nothing technical: no
 * step ids, no tool names, no raw data.
 */
import type { ReactNode } from 'react';
import CoworkGoal from './CoworkGoal';
import { RunOutcomeText } from './CoworkRunHistory';
import { fullTimestamp } from './coworkFormat';
import { overviewSentence } from './coworkOverviewModel';
import type { OverviewFacts } from './coworkOverviewModel';
import { offerLine, openOffer } from './coworkProposalModel';
import { runStatusToken } from './coworkStatus';
import { statusLabel } from '../shared/statusTokens';
import { useEntitlements } from '../licensing/EntitlementsContext';
import { useCoworkIndependence } from '@/api/coworkIndependence';
import { useCoworkProposals } from '@/api/coworkProposals';
import { isRoutineWorthIt, useCoworkRoutine } from '@/api/coworkRoutine';
import { useCoworkPlanQuery } from '@/api/queries/coworkPlan';
import { useCoworkRunsQuery } from '@/api/queries/coworkReads';
import type { CoworkAgent, CoworkItem, CoworkRun } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const RECENT = 5;
const HEADING = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';
const BUTTON = 'flex-shrink-0 inline-flex items-center px-2.5 py-1 rounded-lg border text-[12px] font-medium border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]';

/** What the sentence is built from: the item, its plan and how independent that plan runs. */
function useOverviewFacts(item: CoworkItem, agents: CoworkAgent[] | undefined): OverviewFacts {
    const plan = useCoworkPlanQuery(item.id).data;
    const approved = plan?.approved ?? null;
    const level = useCoworkIndependence(item.id, !!approved).query.data?.level ?? null;
    const agent = item.agentId ? agents?.find((a) => a.id === item.agentId) : null;
    return {
        item,
        plan: plan?.automationId ? { steps: plan.draft?.view.steps.filter((s) => s.depth === 0).length ?? 0, approved: !!approved } : null,
        sends: approved?.permissions.sends ?? null,
        level,
        agentName: agent?.name ?? null,
    };
}

function RunLine({ run, t, onOpen }: { run: CoworkRun; t: TranslateFn; onOpen: (runId: string) => void }) {
    const status = runStatusToken(run.status);
    return (
        <li>
            <button
                type="button"
                data-testid="cowork-overview-run"
                onClick={() => onOpen(run.id)}
                className="w-full flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 py-1.5 text-left text-[12.5px] rounded-md hover:bg-[var(--bg-card-hover)]"
            >
                <span className="w-[120px] flex-shrink-0 truncate text-[var(--text-primary)]">{fullTimestamp(run.startedAt, t)}</span>
                <span className="w-[110px] flex-shrink-0 font-medium text-[var(--text-secondary)]" data-status-key={status.labelKey}>{statusLabel(t, status)}</span>
                <span className="flex-1 min-w-[10rem] line-clamp-2 break-words text-[var(--text-secondary)]"><RunOutcomeText run={run} /></span>
            </button>
        </li>
    );
}

function RecentRuns({ itemId, reloadKey, t, onOpenRun }: { itemId: string; reloadKey?: number; t: TranslateFn; onOpenRun: (runId: string) => void }) {
    const runs = useCoworkRunsQuery(itemId, reloadKey).data?.runs;
    if (!runs) return null;
    return (
        <div className="flex flex-col gap-1" data-testid="cowork-overview-runs">
            <h3 className={HEADING}>{t('cowork_overview.recent', 'Last runs')}</h3>
            {runs.length === 0
                ? <p className="text-[12.5px] text-[var(--text-tertiary)]">{t('cowork_overview.no_runs', 'It has not run yet.')}</p>
                : <ul className="flex flex-col">{runs.slice(0, RECENT).map((run) => <RunLine key={run.id} run={run} t={t} onOpen={onOpenRun} />)}</ul>}
        </div>
    );
}

interface Offer { key: string; line: string; button: string }

/** The offers that apply now: each one line with one button, all deciding under Advanced → Plan. */
function Offers({ itemId, hasPlan, t, onOpenPlan }: { itemId: string; hasPlan: boolean | null; t: TranslateFn; onOpenPlan: () => void }) {
    const ent = useEntitlements() as { loading: boolean; can: (id: string) => boolean };
    const mayPlan = !ent.loading && typeof ent.can === 'function' && ent.can('automations');
    const routine = useCoworkRoutine(itemId, mayPlan && hasPlan === false).data;
    const fixed = openOffer(useCoworkProposals(itemId).data);
    const offers: Offer[] = [];
    if (hasPlan === false && isRoutineWorthIt(routine) && routine?.signals) {
        offers.push({ key: 'routine', line: t('cowork_overview.offer.routine', 'It went the same way in its last {count} runs, so it can run as fixed steps.', { count: routine.signals.runs }), button: t('cowork_overview.offer.routine_button', 'See how') });
    }
    if (fixed) offers.push({ key: 'fixed_step', line: offerLine(fixed, t), button: t('cowork_overview.offer.fixed_button', 'See the proof') });
    if (offers.length === 0) return null;
    return (
        <ul className="flex flex-col gap-1.5" data-testid="cowork-overview-offers">
            {offers.map((offer) => (
                <li key={offer.key} data-testid={`cowork-overview-offer-${offer.key}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="flex-1 min-w-[200px] text-[12.5px] text-[var(--text-secondary)]">{offer.line}</span>
                    <button type="button" className={BUTTON} onClick={onOpenPlan}>{offer.button}</button>
                </li>
            ))}
        </ul>
    );
}

interface CoworkOverviewProps {
    item: CoworkItem;
    agents?: CoworkAgent[];
    reloadKey?: number;
    t: TranslateFn;
    /** Open a run under Advanced → Runs. */
    onOpenRun: (runId: string) => void;
    /** Open Advanced → Plan, where an offer is decided. */
    onOpenPlan: () => void;
    /** Notes about the item, such as a change Cowork made on its own; nothing when there are none. */
    notes?: ReactNode;
}

export default function CoworkOverview({ item, agents, reloadKey, t, onOpenRun, onOpenPlan, notes = null }: CoworkOverviewProps) {
    const facts = useOverviewFacts(item, agents);
    const planRead = useCoworkPlanQuery(item.id);
    const hasPlan = planRead.data ? !!planRead.data.automationId : null;
    return (
        <section
            className="rounded-[10px] border px-[18px] py-4 flex flex-col gap-3.5 [background:var(--bg-card)] [border-color:var(--border-subtle)] [box-shadow:var(--shadow-sm)]"
            data-testid="cowork-overview"
            aria-label={t('cowork_overview.heading', 'Overview')}
        >
            <p className="text-[13.5px] leading-[21px] max-w-[820px] text-[var(--text-primary)]" data-testid="cowork-overview-sentence">
                {overviewSentence(facts, t)}
            </p>
            <CoworkGoal coworkId={item.id} />
            {notes && <div className="flex flex-col gap-1.5" data-testid="cowork-overview-notes">{notes}</div>}
            <RecentRuns itemId={item.id} reloadKey={reloadKey} t={t} onOpenRun={onOpenRun} />
            <Offers itemId={item.id} hasPlan={hasPlan} t={t} onOpenPlan={onOpenPlan} />
        </section>
    );
}
