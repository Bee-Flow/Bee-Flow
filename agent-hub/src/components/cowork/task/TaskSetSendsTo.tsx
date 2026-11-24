/**
 * "Sends to", the fourth row of a task's Settings (./CoworkTaskSettings.tsx), opened:
 *
 *   - who receives what it sends (./coworkTaskSendsModel.ts recipientsOf);
 *   - the ONE "Ask me" choice: Ask me before every change or message, Show me each message first, or Don't ask. They
 *     are the task's levels of independence (PUT /api/cowork/:id/plan/independence); a level the owner may not choose
 *     yet says why (Don't ask opens after enough runs were let through; an organisation may hold it back);
 *   - right under it, trust per recipient: a step and address that earned it can be let go (Send without asking), and
 *     asked about again at any time (PUT /api/cowork/:id/plan/trust).
 *
 * The row is always there. While the choice cannot apply (the steps are not approved yet, or the AI or an agent does
 * the task), it is shown switched off with one line that says why. Each choice is saved the moment it is made.
 */
import { ASK_LEVELS, askLabel, askLevelOf } from './coworkTaskSendsModel';
import { PART, PART_H } from './taskRows';
import { FIELD, Failure, META } from './taskUi';
import { useCoworkIndependence, useCoworkTrust, type Independence, type IndependenceState, type TrustEntry, type TrustState } from '@/api/coworkIndependence';
import type { TaskMode } from './coworkTaskModel';
import type { TranslateFn } from '@/hooks/useTranslation';

function RecipientRow({ entry, state, ask, busy, onChoose, t }: { entry: TrustEntry; state: TrustState; ask: boolean; busy: boolean; onChoose: (trusted: boolean) => void; t: TranslateFn }) {
    const to = entry.recipient === '*' ? t('cowork_task.send.anyone', 'the addresses it picks') : entry.recipient;
    const id = `cowork-task-trust-${entry.stepId}-${entry.recipient}`;
    const counting = !entry.trusted && !entry.canTrust
        ? t('cowork_task.send.counting', 'You let it through {count} of {needed} times. After that you can let it go.', { count: entry.letThrough, needed: state.needed })
        : null;
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 border-t first:border-t-0 border-[var(--border-subtle)]" data-testid="cowork-task-trust-row">
            <span className="flex-1 basis-[200px] min-w-0 break-words">{t('cowork_task.send.to_step', "{to}, by '{step}'", { to, step: entry.title })}</span>
            {ask ? (
                <span className="flex-[0_1_220px] min-w-0">
                    <label htmlFor={id} className="sr-only">{t('cowork_task.send.to_label', 'Sending to {to}', { to })}</label>
                    <select id={id} className={FIELD} value={entry.trusted ? 'allow' : 'ask'} disabled={busy || (!entry.trusted && !entry.canTrust)} onChange={(e) => onChoose(e.target.value === 'allow')}>
                        <option value="ask">{t('cowork_task.send.ask_each', 'Ask me each time')}</option>
                        <option value="allow">{t('cowork_task.send.allow', 'Send without asking')}</option>
                    </select>
                </span>
            ) : <span className={META}>{t('cowork_task.send.allow', 'Send without asking')}</span>}
            {ask && counting && <span className={`${META} basis-full`}>{counting}</span>}
        </li>
    );
}

/** Trust per recipient: each with Ask me each time or Send without asking. Nothing before a first decision was made. */
function Trust({ coworkId, ask, t }: { coworkId: string; ask: boolean; t: TranslateFn }) {
    const { query, choose } = useCoworkTrust(coworkId);
    const state = query.data;
    const entries = state && Array.isArray(state.entries) ? state.entries : [];
    if (!state || entries.length === 0) return null;
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-task-trust">
            <span className={PART_H}>{t('cowork_task.trust.heading', 'Per person')}</span>
            <ul className="flex flex-col list-none m-0 p-0">
                {entries.map((entry) => (
                    <RecipientRow key={`${entry.stepId}|${entry.recipient}`} entry={entry} state={state} ask={ask} busy={choose.isPending}
                        onChoose={(trusted) => choose.mutate({ stepId: entry.stepId, recipient: entry.recipient, trusted })} t={t} />
                ))}
            </ul>
            {ask && <p className={META}>{t('cowork_task.send.grows', 'Trust grows per person: after the messages you let through, you can allow that address for good. Stop a message and it goes back to asking.')}</p>}
            <Failure error={choose.error} t={t} />
        </div>
    );
}

/** Why a level cannot be chosen now; null for one that can. */
function closedWhy(level: Independence, state: IndependenceState, t: TranslateFn): string | null {
    const option = (Array.isArray(state.options) ? state.options : []).find((o) => o.level === level);
    if (!option || option.open) return null;
    if (level !== 'on_its_own') return t('cowork_task.ask.closed', 'Your organisation has not switched this on.');
    if (state.ceiling && state.ceiling !== 'on_its_own') return t('cowork_task.ask.ceiling', 'Your organisation does not let a task go without asking.');
    return t('cowork_task.send.opens_after', "Don't ask opens after {needed} runs you let through without stopping one ({count} so far).", { needed: state.needed, count: state.letThrough });
}

const LEVEL_LINES: Readonly<Record<Independence, [string, string]>> = {
    asks_everything: ['cowork_task.ask.everything_line', 'Nothing it changes or sends goes ahead until you approve it, under Needs you.'],
    asks_before_sending: ['cowork_task.ask.sending_line', 'You see each message to someone else first. One tap to send.'],
    on_its_own: ['cowork_task.ask.none_line', 'It changes and sends on its own, as you approved.'],
};

/** Why the choice does not apply yet, in one line; null when it does. */
function notYet(mode: TaskMode, hasApprovedSteps: boolean, t: TranslateFn): string | null {
    if (mode !== 'steps') return t('cowork_task.ask.not_steps', 'This applies to fixed steps. Here the AI or your agent does the task and tells you afterwards what it did.');
    if (!hasApprovedSteps) return t('cowork_task.ask.not_yet', 'This starts to apply once you approved its steps. Until then it does not run, so nothing is sent.');
    return null;
}

interface AskMeProps {
    coworkId: string;
    mode: TaskMode;
    hasApprovedSteps: boolean;
    /** It can reach other people; else there is no message of someone else's to show first. */
    othersReached: boolean;
    t: TranslateFn;
}

function AskMe({ coworkId, mode, hasApprovedSteps, othersReached, t }: AskMeProps) {
    const { query, choose } = useCoworkIndependence(coworkId, true);
    const state = query.data;
    const now = askLevelOf(state);
    const waits = notYet(mode, hasApprovedSteps, t);
    const name = `cowork-task-ask-${coworkId}`;
    return (
        <div className={PART} role="radiogroup" aria-labelledby={`${name}-h`} data-testid="cowork-task-ask">
            <span id={`${name}-h`} className={PART_H}>{t('cowork_task.ask.heading', 'Ask me')}</span>
            {waits && <p className={META} data-testid="cowork-task-ask-why">{waits}</p>}
            {!waits && !othersReached && <p className={META} data-testid="cowork-task-ask-why">{t('cowork_task.ask.only_you', 'It sends only to you, so there is no message to someone else to show you first.')}</p>}
            {ASK_LEVELS.map((level) => {
                const why = state ? closedWhy(level, state, t) : null;
                return (
                    <label key={level} htmlFor={`${name}-${level}`} aria-label={askLabel(level, t)} className="grid grid-cols-[auto_1fr] gap-x-3 items-start min-h-11 py-1 cursor-pointer">
                        <input id={`${name}-${level}`} type="radio" name={name} className="mt-1 w-4 h-4" checked={!waits && now === level}
                            disabled={!!waits || !state || !!why || choose.isPending} onChange={() => choose.mutate(level)} />
                        <span className="flex flex-col gap-0.5">
                            <span className="text-[14px] font-medium">{askLabel(level, t)}</span>
                            <span className={META}>{why ?? t(...LEVEL_LINES[level])}</span>
                        </span>
                    </label>
                );
            })}
            <Failure error={choose.error} t={t} />
        </div>
    );
}

interface TaskSetSendsToProps extends AskMeProps {
    /** Who receives what it sends, in words; empty when it sends nothing. */
    recipients: string[];
}

export default function TaskSetSendsTo({ recipients, ...ask }: TaskSetSendsToProps) {
    const { coworkId, hasApprovedSteps, t } = ask;
    const level = askLevelOf(useCoworkIndependence(coworkId, true).query.data);
    return (
        <>
            <div className="flex flex-col gap-2" data-testid="cowork-task-recipients">
                <span className={PART_H}>{t('cowork_task.sends.who', 'Who receives it')}</span>
                {recipients.length > 0
                    ? <ul className="list-none m-0 p-0 flex flex-col gap-1">{recipients.map((who) => <li key={who} className="break-words">{who}</li>)}</ul>
                    : <p>{t('cowork_task.sends.nobody', 'Nobody: it sends nothing')}</p>}
                <p className={META}>{t('cowork_task.sends.change_hint', 'To send it to someone else, say so in the sentence under What.')}</p>
            </div>
            <AskMe {...ask} />
            {hasApprovedSteps && <Trust coworkId={coworkId} ask={level !== 'on_its_own'} t={t} />}
        </>
    );
}
