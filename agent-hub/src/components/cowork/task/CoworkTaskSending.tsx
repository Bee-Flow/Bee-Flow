/**
 * "Before it sends something", in an opened task with approved steps that can reach other people: Ask me or Don't ask,
 * which are the existing levels of independence (server usecases/coworkIndependence.mts): Ask me is "ask before
 * anything leaves Bee Flow", Don't ask is "on its own", open only after enough runs were let through. Under Ask me,
 * trust grows per recipient: a step and address that earned it can be let go (Send without asking), and asked about
 * again at any time (server PUT /api/cowork/:id/plan/trust).
 */
import SegmentedControl from '../../shared/SegmentedControl';
import { FIELD, Failure, META, SECTION_H } from './taskUi';
import { useCoworkIndependence, useCoworkTrust, type TrustEntry, type TrustState } from '@/api/coworkIndependence';
import type { TranslateFn } from '@/hooks/useTranslation';

type Choice = 'ask' | 'go';

function RecipientRow({ entry, state, ask, busy, onChoose, t }: { entry: TrustEntry; state: TrustState; ask: boolean; busy: boolean; onChoose: (trusted: boolean) => void; t: TranslateFn }) {
    const to = entry.recipient === '*' ? t('cowork_task.send.anyone', 'the addresses it picks') : entry.recipient;
    const id = `cowork-task-trust-${entry.stepId}-${entry.recipient}`;
    const counting = !entry.trusted && !entry.canTrust
        ? t('cowork_task.send.counting', 'You let it through {count} of {needed} times. After that you can let it go.', { count: entry.letThrough, needed: state.needed })
        : null;
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px]" data-testid="cowork-task-trust-row">
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

/** What the choice means now, in one line. */
function choiceLine(ask: boolean, t: TranslateFn): string {
    if (ask) return t('cowork_task.send.ask_line', 'You see the message first. One tap to send.');
    return t('cowork_task.send.go_line', 'It sends on its own, as you approved.');
}

export default function CoworkTaskSending({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const { query, choose } = useCoworkIndependence(coworkId, true);
    const trust = useCoworkTrust(coworkId);
    const state = query.data;
    if (!state) return null;
    const ask = (state.chosen ?? state.level) !== 'on_its_own';
    const goOption = state.options.find((o) => o.level === 'on_its_own');
    const onChoose = (next: Choice) => {
        if ((next === 'ask') === ask) return;
        choose.mutate(next === 'ask' ? 'asks_before_sending' : 'on_its_own');
    };
    const entries = Array.isArray(trust.query.data?.entries) ? trust.query.data.entries : [];
    return (
        <section className="flex flex-col gap-2.5" aria-labelledby="cowork-task-send-h" data-testid="cowork-task-sending">
            <h3 id="cowork-task-send-h" className={SECTION_H}>{t('cowork_task.send.heading', 'Before it sends something')}</h3>
            <div>
                <SegmentedControl<Choice>
                    ariaLabel={t('cowork_task.send.heading', 'Before it sends something')}
                    value={ask ? 'ask' : 'go'}
                    onChange={onChoose}
                    disabled={choose.isPending}
                    options={[
                        { value: 'ask', label: t('cowork_task.send.ask', 'Ask me') },
                        { value: 'go', label: t('cowork_task.send.go', "Don't ask"), disabled: !goOption?.open },
                    ]}
                />
            </div>
            <p className={META}>{choiceLine(ask, t)}</p>
            {goOption && !goOption.open && ask && (
                <p className={META}>{t('cowork_task.send.opens_after', "Don't ask opens after {needed} runs you let through without stopping one ({count} so far).", { needed: state.needed, count: state.letThrough })}</p>
            )}
            {entries.length > 0 && trust.query.data && (
                <ul className="flex flex-col list-none m-0 p-0">
                    {entries.map((entry) => (
                        <RecipientRow key={`${entry.stepId}|${entry.recipient}`} entry={entry} state={trust.query.data as TrustState} ask={ask} busy={trust.choose.isPending}
                            onChoose={(trusted) => trust.choose.mutate({ stepId: entry.stepId, recipient: entry.recipient, trusted })} t={t} />
                    ))}
                </ul>
            )}
            {ask && entries.length > 0 && <p className={META}>{t('cowork_task.send.grows', 'Trust grows per person: after the messages you let through, you can allow that address for good. Stop a message and it goes back to asking.')}</p>}
            <Failure error={choose.error || trust.choose.error} t={t} />
        </section>
    );
}
