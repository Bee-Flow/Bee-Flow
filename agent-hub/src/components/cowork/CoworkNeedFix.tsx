/**
 * The card of ./CoworkNeedCard.tsx for something that went wrong (`fix`): with the task's steps (their order, steps
 * that cannot run or are gone, a test that did not pass), or with its last run (an app that is no longer allowed, a
 * sign-in that ran out, a step that could not read from another or did not work, a list that never arrived, the AI's
 * own verdict, a run that took too long, or one that just failed).
 *
 * Always in plain words that name the step and the cause (./coworkNeedsModel.ts hands over the titles; never an error
 * text, an id or a tool's name), with ONE primary action that resolves it and a secondary way out. "Let the AI work it
 * out every run" can always be undone for a few seconds (./CoworkNeedSetup.tsx).
 */
import { NeedFrame, useNeedAct, type NeedKindProps } from './CoworkNeedFrame';
import { AiChosen, useAiChoice } from './CoworkNeedSetup';
import type { NeedProblem, NeedWords } from './coworkNeedsModel';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from './coworkUi';
import { settingsPathForTab } from '@/authedApp/settingsRoutes';
import { runCoworkNow } from '@/api/coworkApi';
import { fixCoworkPlanWiring } from '@/api/coworkPlanApi';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

/** What a button of the card does: fix the order, open the task (at its steps, or as it is), the AI, run, sign in. */
type FixMove = 'fix_wiring' | 'check' | 'see' | 'open' | 'ai' | 'run' | 'sign_in';
type Copy = readonly [string, string];

/** One way to say a problem: the words it needs (a step's title, an app's name), and the sentence. */
type Wording = readonly [needs: ReadonlyArray<keyof NeedWords>, copy: Copy];

/** Per problem its sentences, most specific first; the last one needs no words. */
const TITLES: Readonly<Record<NeedProblem, readonly Wording[]>> = {
    wiring: [[[], ['cowork_home.fix.wiring', 'The steps are in the wrong order, so it cannot run.']]],
    blocked: [[[], ['cowork_home.fix.blocked', 'The steps cannot run as they are.']]],
    tried_failed: [[[], ['cowork_home.fix.tried_failed', 'The test of the steps did not pass.']]],
    gone: [[[], ['cowork_home.fix.gone', 'The steps of this task are gone.']]],
    incomplete: [
        [['step'], ['cowork_home.fix.incomplete_step', '‘{step}’ found nothing to work on in the last run.']],
        [[], ['cowork_home.fix.incomplete', 'The last run did not do its work: a step found nothing to work on.']],
    ],
    ai_failed: [[[], ['cowork_home.fix.ai_verdict', 'The AI said it could not do the last run.']]],
    permission: [
        [['app'], ['cowork_home.fix.permission', '{app} is no longer allowed for this task.']],
        [[], ['cowork_home.fix.permission_some', 'An app this task uses is no longer allowed.']],
    ],
    signed_out: [
        [['app'], ['cowork_home.fix.signed_out', 'The sign-in of {app} ran out.']],
        [[], ['cowork_home.fix.signed_out_some', 'The sign-in of an app ran out.']],
    ],
    reads: [
        [['step', 'source'], ['cowork_home.fix.reads', '‘{step}’ could not read what it needs from ‘{source}’.']],
        [['step'], ['cowork_home.fix.reads_step', '‘{step}’ could not read what it needs.']],
        [[], ['cowork_home.fix.reads_some', 'A step could not read what it needs from an earlier step.']],
    ],
    step: [
        [['step'], ['cowork_home.fix.step', '‘{step}’ did not work in the last run.']],
        [[], ['cowork_home.fix.step_some', 'A step did not work in the last run.']],
    ],
    timeout: [[[], ['cowork_home.fix.timeout', 'The last run took too long and was stopped.']]],
    failed: [[[], ['cowork_home.fix.failed', 'The last run failed.']]],
};

const SEE_OR_AI: Copy = ['cowork_home.fix.see_or_ai', 'Open the task to see what is wrong, or let the AI work it out every run.'];
const SEE: Copy = ['cowork_home.fix.see', 'Open the task to see what is wrong.'];

interface Plan {
    /** The line under the sentence: with the AI as a way out (`ai`), or without. */
    sub: { ai: Copy | null; plain: Copy | null };
    primary: FixMove;
    /** The way out: for a task with fixed steps (`ai`), or for any other. */
    secondary: { ai: FixMove; plain: FixMove };
}

const both = (move: FixMove) => ({ ai: move, plain: move });

/** Per problem: the line under its sentence, the primary action and the way out. */
const PLANS: Readonly<Record<NeedProblem, Plan>> = {
    wiring: {
        sub: { ai: ['cowork_home.fix.wiring_sub', 'Cowork can fix the order of the steps. What the task may read and send stays the same.'], plain: null },
        primary: 'fix_wiring', secondary: both('ai'),
    },
    blocked: { sub: { ai: SEE_OR_AI, plain: SEE }, primary: 'check', secondary: { ai: 'ai', plain: 'run' } },
    tried_failed: { sub: { ai: SEE_OR_AI, plain: SEE }, primary: 'check', secondary: { ai: 'ai', plain: 'run' } },
    gone: { sub: { ai: ['cowork_home.fix.gone_ai', 'The AI can work it out every run instead.'], plain: null }, primary: 'ai', secondary: both('open') },
    incomplete: { sub: { ai: SEE, plain: SEE }, primary: 'check', secondary: both('run') },
    ai_failed: { sub: { ai: ['cowork_home.fix.ai_failed_sub', 'Open the task to read why.'], plain: ['cowork_home.fix.ai_failed_sub', 'Open the task to read why.'] }, primary: 'see', secondary: both('run') },
    permission: {
        sub: { ai: ['cowork_home.fix.permission_sub', 'Allow it again under Uses, or let the AI work it out every run.'], plain: ['cowork_home.fix.permission_sub_plain', 'Allow it again under Uses.'] },
        primary: 'see', secondary: { ai: 'ai', plain: 'run' },
    },
    signed_out: { sub: { ai: ['cowork_home.fix.signed_out_sub', 'Sign in again, then run it again.'], plain: ['cowork_home.fix.signed_out_sub', 'Sign in again, then run it again.'] }, primary: 'sign_in', secondary: both('run') },
    reads: { sub: { ai: SEE_OR_AI, plain: SEE }, primary: 'check', secondary: { ai: 'ai', plain: 'run' } },
    step: { sub: { ai: SEE, plain: SEE }, primary: 'check', secondary: both('run') },
    timeout: { sub: { ai: null, plain: null }, primary: 'run', secondary: both('see') },
    failed: { sub: { ai: ['cowork_home.fix.failed_sub', 'Open the task to see what happened.'], plain: ['cowork_home.fix.failed_sub', 'Open the task to see what happened.'] }, primary: 'see', secondary: both('run') },
};

const LABELS: Readonly<Record<FixMove, Copy>> = {
    fix_wiring: ['cowork_home.fix.fix_it', 'Fix it for me'],
    check: ['cowork_home.need.see_wrong', 'See what is wrong'],
    see: ['cowork_home.need.see_wrong', 'See what is wrong'],
    open: ['cowork_home.need.open_task', 'Open the task'],
    ai: ['cowork_home.fix.ai_every_run', 'Let the AI work it out every run'],
    run: ['cowork_home.fix.run_again', 'Run it again'],
    sign_in: ['cowork_home.need.sign_in', 'Sign in again'],
};

/** The sentence of a problem, with the step and the app it can name. */
export function fixTitle(problem: NeedProblem, words: NeedWords | undefined, t: TranslateFn): string {
    const has = (word: keyof NeedWords): boolean => !!words?.[word];
    const options = TITLES[problem] ?? TITLES.failed;
    const [, copy] = options.find(([needs]) => needs.every(has)) ?? options[options.length - 1] ?? TITLES.failed[0];
    return t(copy[0], copy[1], { step: words?.step ?? '', source: words?.source ?? '', app: words?.app ?? '' });
}

/** Something went wrong with the steps or the last run: what, in plain words, the action that resolves it, and the other way. */
export function FixCard(props: NeedKindProps) {
    const { need, onOpenTask, onDone } = props;
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const ai = useAiChoice(need.itemId, act);
    if (ai.chosen) return <AiChosen {...props} onBack={ai.back} />;
    const problem = need.problem ?? 'blocked';
    const plan = PLANS[problem] ?? PLANS.failed;
    const way = need.hasSteps ? 'ai' : 'plain';
    const id = need.itemId;
    const go = (move: FixMove) => {
        if (move === 'fix_wiring') act.mutate({ run: () => fixCoworkPlanWiring(id), done: t('cowork_home.done.fixed', 'Fixed. Cowork is testing the steps once; nothing is sent.') });
        else if (move === 'ai') ai.choose();
        else if (move === 'run') act.mutate({ run: () => runCoworkNow(id), done: t('cowork_home.done.running', 'Running. The result lands in your notifications.') });
        else onOpenTask(id, move === 'check' ? 'steps' : undefined);
    };
    const button = (move: FixMove, className: string) => (move === 'sign_in'
        ? <a className={className} href={settingsPathForTab('integrations')}>{t(...LABELS[move])}</a>
        : <button type="button" className={className} disabled={act.isPending} onClick={() => go(move)}>{t(...LABELS[move])}</button>);
    const sub = plan.sub[way];
    return (
        <NeedFrame
            {...props} title={fixTitle(problem, need.words, t)} sub={sub ? t(...sub) : null} error={act.error}
            actions={<>{button(plan.primary, BUTTON_PRIMARY)}{button(plan.secondary[way], BUTTON_SECONDARY)}</>}
        />
    );
}
