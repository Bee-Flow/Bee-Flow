import { CheckCircle2, ClipboardList, Hammer, Loader2 } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';

export interface InlinePlan {
    id?: string | null;
    version?: number | string | null;
    title?: string | null;
    steps?: unknown[] | null;
    status?: string | null;
    pauseAfterStep?: boolean | null;
}

interface PlanInlineCardProps {
    plan?: InlinePlan | null;
    running?: boolean;
    onOpen?: (() => void) | null;
    /** Same call as the overlay's button: the chat is where the user is looking when the plan arrives. */
    onApprove: (pauseAfterStep: boolean) => void;
}

const FRAME = 'flex min-w-0 max-w-full items-center gap-2.5 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3 text-xs';

/** The two states that carry no button: done, and a turn that is building right now. */
function StatusLine({ status, version }: { status: 'built' | 'building'; version: string | number }) {
    const { t } = useTranslation();
    if (status === 'built') {
        return <div data-testid="plan-inline-card" className="flex items-center gap-2 px-1 text-[11px] text-[var(--text-secondary)]"><CheckCircle2 size={13} className="shrink-0 text-[var(--type-ai)]" />{t('automations.assistant.plan_built_short', 'Plan v{version} built', { version })}</div>;
    }
    return <div data-testid="plan-inline-card" role="status" className={FRAME}><Loader2 size={14} className="shrink-0 animate-spin text-[var(--type-ai)]" /><span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{t('automations.assistant.plan_building', 'Building plan v{version}…', { version })}</span></div>;
}

/**
 * The plan in the chat itself. The Build button used to live only in the canvas
 * overlay, which closes with its X; after that nothing in the conversation said a
 * plan was waiting. Only a button builds: a typed "yes" gets one sentence from
 * the model and this card right under it.
 */
export default function PlanInlineCard({ plan, running = false, onOpen = null, onApprove }: PlanInlineCardProps) {
    const { t } = useTranslation();
    if (!plan?.id) return null;
    const version = plan.version ?? '';
    const count = plan.steps?.length ?? 0;
    if (plan.status === 'built') return <StatusLine status="built" version={version} />;
    // `building` with no turn running is a build that was stopped half way: a
    // card with no button would leave the user in "Building plan" with no way on.
    if (plan.status === 'building' && running) return <StatusLine status="building" version={version} />;
    if (running || !['review', 'paused', 'building'].includes(plan.status ?? '')) return null;
    return <div data-testid="plan-inline-card" className={`${FRAME} flex-wrap`}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--type-ai)_10%,transparent)] text-[var(--type-ai)]"><ClipboardList size={16} /></span>
        <div className="min-w-0 flex-1 basis-40">
            {plan.title && <p className="truncate font-semibold text-[var(--text-primary)]">{plan.title}</p>}
            <p className="text-[11px] text-[var(--text-tertiary)]">{t('automations.assistant.plan_card_summary', 'Plan v{version} · {count} steps', { version, count })}</p>
        </div>
        <div className="flex items-center gap-2">
            {onOpen && <button type="button" onClick={onOpen} className="rounded-xl px-3 py-2 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">{t('automations.assistant.plan_open', 'Open plan')}</button>}
            <button type="button" onClick={() => onApprove(!!plan.pauseAfterStep)} className="flex items-center gap-2 rounded-xl bg-[var(--text-primary)] px-3 py-2 font-semibold text-[var(--bg-primary)] transition-opacity hover:opacity-90"><Hammer size={13} />{plan.status === 'review' ? t('automations.assistant.build_plan', 'Build this plan') : t('automations.assistant.continue_plan', 'Continue plan')}</button>
        </div>
    </div>;
}
