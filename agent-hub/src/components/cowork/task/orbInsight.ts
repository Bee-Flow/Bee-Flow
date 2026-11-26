import type { CoworkItem, CoworkRun } from '@/api/cowork.types';
import type { PlanState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import { fixTitle } from '../CoworkNeedFix';
import { connectionMessage, type NeedCardData } from '../coworkNeedsModel';
import { triedResultOf } from './CoworkTaskTested';
import { runFailed, runLine, runMarkdown } from './coworkTaskModel';

export interface OrbInsight {
    message: string;
    primary?: { view: 'review' | 'result' | 'uses' | 'steps'; label: string };
    hasResult: boolean;
}

function needMessage(need: NeedCardData, t: TranslateFn): string {
    switch (need.kind) {
        case 'fix': return need.reason || fixTitle(need.problem ?? 'failed', need.words, t);
        case 'check': return need.changed ? t('cowork_home.need.check_changed', 'The steps changed and may do more than you approved. Check them again.') : t('cowork_home.need.check', 'The steps are ready and tested. Check them once.');
        case 'first_test': return t('cowork_home.need.first_test', 'Test it once before it starts.');
        case 'sign_in': return connectionMessage(need, t);
        case 'send': return t('cowork_home.need.send_title', 'A message waits for you');
        case 'setup': return t('cowork_home.setup_card.title', 'Cowork could not set up the steps.');
        case 'repair': return t('cowork_home.need.repair_sub', 'Nothing changes until you approve it.');
        default: return need.reason || t('cowork_home.need.review', 'The agent asks you to look at something');
    }
}

function fixInsight(need: NeedCardData, latest: CoworkRun | null, plan: PlanState | undefined, t: TranslateFn): OrbInsight['primary'] {
    if (need.problem === 'permission') return {view: 'uses', label: t('cowork_task.orb.apps_model', 'Apps and model')};
    if (need.problem === 'wiring') return {view: 'review', label: t('cowork_home.fix.fix_it', 'Fix it for me')};
    if (latest && runFailed(latest)) return {view: 'result', label: t('cowork_task.orb.run_details', 'See run details')};
    if (plan?.draft) return {view: 'steps', label: t('cowork_task.orb.tests', 'Tests and permissions')};
    return undefined;
}

function failureInsight(need: NeedCardData, plan: PlanState | undefined, latest: CoworkRun | null, t: TranslateFn, hasResult: boolean): OrbInsight {
    const reason = needMessage(need, t);
    const problem = plan?.tried?.current && plan.tried.status === 'failed' ? plan.tried.problems[0] : undefined;
    const latestReason = latest && runFailed(latest) && need.runId === latest.id ? latest.plain?.trim() : undefined;
    return {message: (problem || latestReason || reason).slice(0, 240), primary: fixInsight(need, latest, plan, t), hasResult};
}

function hasOutput(run: CoworkRun | null, markdown: string) {
    return Boolean(markdown) && run?.producedOutput !== false;
}

export function orbInsight({ item, plan, latest, need, t }: {
    item: CoworkItem; plan?: PlanState; latest: CoworkRun | null; need?: NeedCardData; t: TranslateFn;
}): OrbInsight {
    const preview = triedResultOf(plan);
    const markdown = latest ? runMarkdown(latest) : '';
    const hasResult = hasOutput(latest, markdown);
    if (need?.kind === 'fix') return failureInsight(need, plan, latest, t, hasResult);
    if (need || preview) {
        const label = preview && (!need || need.kind === 'check') ? t('cowork_task.orb.preview', 'Review test preview') : t('cowork_task.orb.review_result', 'Review task');
        return { message: need ? needMessage(need, t) : t('cowork_task.orb.preview_ready', 'Your test preview is ready.'), primary: { view: 'review', label }, hasResult };
    }
    if (latest) {
        const line = runLine(latest, t, markdown);
        const message = line.length > 160 ? line.slice(0, 157).trimEnd() + '…' : line;
        return { message, hasResult, primary: runFailed(latest) ? { view: 'result', label: t('cowork_task.orb.run_details', 'See run details') } : undefined };
    }
    return { message: item.isActive === false ? t('cowork_task.result.paused_line', 'Nothing runs until you resume it.') : t('cowork_task.orb.ready', 'How can I help with this task?'), hasResult: false };
}
