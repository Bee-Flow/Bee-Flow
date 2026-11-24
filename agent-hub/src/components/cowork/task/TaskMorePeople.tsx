/**
 * The rows of More in an opened task (./CoworkTaskMore.tsx) about colleagues:
 *
 *   - Share: who can see the task (Can see) and who also answers what it asks (Can answer, at most one), with the
 *     sharing history from the task's trail (server usecases/coworkShares.mts, usecases/coworkAudit.mts);
 *   - Pass the result to a colleague's task: on a desk, a colleague's task that starts after this one gets each result
 *     once this task's owner allows it; the owner allows it here, or stops it (server usecases/coworkDesks.mts);
 *   - Hand over: a colleague gets a paused copy and this task is deleted, after an in-page confirm.
 */
import { useState } from 'react';
import { fullTimestamp } from '../coworkFormat';
import { BTN_PRIMARY, BTN_QUIET, FIELD, Failure, FoldRow, LABEL, META, ROW_ACTIONS } from './taskUi';
import { useCoworkColleagues, useCoworkHandOver } from '@/api/coworkHandOver';
import { useCoworkShares, type Share, type ShareRole } from '@/api/coworkShares';
import { useCoworkTrail } from '@/api/coworkTrail';
import { useDeskHandOff, useDeskView, useItemDesk, type DeskMember } from '@/api/coworkDesks';
import type { TranslateFn } from '@/hooks/useTranslation';

interface RowProps { coworkId: string; open: boolean; onToggle: (id: string | null) => void; t: TranslateFn }

const ROLE_WORDS = (t: TranslateFn): Record<ShareRole, string> => ({ viewer: t('cowork_task.share.can_see', 'Can see'), approver: t('cowork_task.share.can_answer', 'Can answer') });

function RoleSelect({ id, value, label, onChange, t }: { id: string; value: ShareRole; label: string; onChange: (role: ShareRole) => void; t: TranslateFn }) {
    const words = ROLE_WORDS(t);
    return (
        <span className="flex-[0_1_160px] min-w-0">
            <label htmlFor={id} className="sr-only">{label}</label>
            <select id={id} className={FIELD} value={value} onChange={(e) => onChange(e.target.value as ShareRole)}>
                <option value="viewer">{words.viewer}</option>
                <option value="approver">{words.approver}</option>
            </select>
        </span>
    );
}

function ShareHistory({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const entries = (useCoworkTrail(coworkId, true).data ?? []).filter((e) => e.action === 'cowork.shares_set');
    if (entries.length === 0) return null;
    return (
        <div className="flex flex-col gap-0.5">
            <span className={LABEL}>{t('cowork_task.share.history', 'Sharing history')}</span>
            <ul className="list-none m-0 p-0">
                {entries.map((e, i) => (
                    <li key={`${e.at ?? ''}-${i}`} className={META}>
                        {e.at ? `${fullTimestamp(e.at, t)} · ` : ''}{e.byYou ? t('cowork_task.share.you_changed', 'You changed who it is shared with') : t('cowork_task.share.someone_changed', 'Someone else changed who it is shared with')}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function AddShare({ free, onAdd, busy, coworkId, t }: { free: Array<{ id: string; name: string }>; onAdd: (share: Share) => void; busy: boolean; coworkId: string; t: TranslateFn }) {
    const [who, setWho] = useState('');
    const [role, setRole] = useState<ShareRole>('viewer');
    const pick = free.some((c) => c.id === who) ? who : free[0]?.id ?? '';
    if (!pick) return null;
    return (
        <div className="flex flex-wrap items-end gap-2">
            <span className="flex-[1_1_180px] min-w-0 flex flex-col gap-1">
                <label htmlFor={`cowork-task-share-who-${coworkId}`} className={LABEL}>{t('cowork_task.share.colleague', 'Colleague')}</label>
                <select id={`cowork-task-share-who-${coworkId}`} className={FIELD} value={pick} onChange={(e) => setWho(e.target.value)}>
                    {free.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
            </span>
            <span className="flex flex-col gap-1">
                <span className={LABEL} aria-hidden="true">{t('cowork_task.share.they', 'They')}</span>
                <RoleSelect id={`cowork-task-share-role-${coworkId}`} value={role} label={t('cowork_task.share.they', 'They')} onChange={setRole} t={t} />
            </span>
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => onAdd({ userId: pick, role })}>{t('cowork_task.share.share', 'Share')}</button>
        </div>
    );
}

function ShareBody({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const colleagues = useCoworkColleagues(coworkId, true).data ?? [];
    const { query, save } = useCoworkShares(coworkId, true);
    const shares = query.data ?? [];
    const nameOf = (userId: string) => colleagues.find((c) => c.id === userId)?.name ?? shares.find((s) => s.userId === userId)?.name ?? userId;
    const write = (next: Share[]) => save.mutate(next);
    const free = colleagues.filter((c) => !shares.some((s) => s.userId === c.id));
    return (
        <>
            {shares.length > 0 && (
                <ul className="list-none m-0 p-0">
                    {shares.map((s) => (
                        <li key={s.userId} className="flex flex-wrap items-center gap-2 py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px]">
                            <strong className="flex-1 min-w-[8rem]">{nameOf(s.userId)}</strong>
                            <RoleSelect id={`cowork-task-share-${coworkId}-${s.userId}`} value={s.role} label={t('cowork_task.share.what_they_do', 'What {name} can do', { name: nameOf(s.userId) })} t={t}
                                onChange={(role) => write(shares.map((x) => (x.userId === s.userId ? { ...x, role } : x)))} />
                            <button type="button" className={BTN_QUIET} disabled={save.isPending} onClick={() => write(shares.filter((x) => x.userId !== s.userId))}>{t('cowork_task.share.stop', 'Stop')}</button>
                        </li>
                    ))}
                </ul>
            )}
            <AddShare free={free} busy={save.isPending} coworkId={coworkId} onAdd={(share) => write([...shares, share])} t={t} />
            <p className={META}>{t('cowork_task.share.hint', 'Can see: the task and its results. Can answer: also handles what it asks under Needs you. Only one colleague can answer. Nobody else can edit it.')}</p>
            <ShareHistory coworkId={coworkId} t={t} />
            <Failure error={save.error} t={t} />
        </>
    );
}

export function ShareRow({ coworkId, open, onToggle, t }: RowProps) {
    const shares = useCoworkShares(coworkId, true).query.data ?? [];
    const value = shares.length === 0 ? t('cowork_task.share.none', 'Not shared') : shares.map((s) => s.name ?? '').filter(Boolean).join(', ') || String(shares.length);
    return (
        <FoldRow id="share" label={t('cowork_task.more.share', 'Share')} value={value} open={open} onToggle={onToggle}>
            <ShareBody coworkId={coworkId} t={t} />
        </FoldRow>
    );
}

function PassLine({ member, deskId, t }: { member: DeskMember; deskId: string; t: TranslateFn }) {
    const { allow, withdraw } = useDeskHandOff(deskId);
    const busy = allow.isPending || withdraw.isPending;
    return (
        <li className="flex flex-wrap items-center gap-2 py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px]">
            <span className="flex-1 min-w-[12rem]">
                {member.handOff === 'allowed'
                    ? t('cowork_task.pass.allowed', "Each result goes to {owner}'s task '{title}'.", { owner: member.ownerName, title: member.title })
                    : t('cowork_task.pass.waiting', "{owner}'s task '{title}' asks for each result of this task.", { owner: member.ownerName, title: member.title })}
            </span>
            {member.handOff === 'allowed'
                ? <button type="button" className={BTN_QUIET} disabled={busy} onClick={() => withdraw.mutate(member.scheduleId)}>{t('cowork_task.pass.stop', 'Stop passing it on')}</button>
                : <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => allow.mutate(member.scheduleId)}>{t('cowork_task.pass.allow', 'Pass it on')}</button>}
            <Failure error={allow.error || withdraw.error} t={t} />
        </li>
    );
}

function PassBody({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const desk = useItemDesk(coworkId).data ?? null;
    const view = useDeskView(desk?.accepted ? desk.id : null).data;
    // A colleague's task that starts after this one, whose hand-off this task's owner decides.
    const after = (view?.members ?? []).filter((m) => m.after === coworkId && m.decidesHandOff && m.handOff !== null);
    if (!desk?.accepted || !view) return <p className={META}>{t('cowork_task.pass.no_desk', "Put this task on a desk with your colleagues under Teamwork. A colleague's task that starts after it can then get each result.")}</p>;
    return (
        <>
            {after.length > 0
                ? <ul className="list-none m-0 p-0">{after.map((m) => <PassLine key={m.scheduleId} member={m} deskId={view.desk.id} t={t} />)}</ul>
                : <p className={META}>{t('cowork_task.pass.none', "On the desk '{desk}'. No colleague's task starts after this one yet.", { desk: view.desk.name })}</p>}
            <p className={META}>{t('cowork_task.pass.hint', 'Only the result is passed on, never access to your apps. You allow each colleague once.')}</p>
        </>
    );
}

export function PassRow({ coworkId, open, onToggle, t }: RowProps) {
    return (
        <FoldRow id="pass" label={t('cowork_task.more.pass', "Pass the result to a colleague's task")} open={open} onToggle={onToggle}>
            <PassBody coworkId={coworkId} t={t} />
        </FoldRow>
    );
}

function HandOverBody({ coworkId, title, onGone, t }: { coworkId: string; title: string; onGone: () => void; t: TranslateFn }) {
    const colleagues = useCoworkColleagues(coworkId, true);
    const handOver = useCoworkHandOver(coworkId);
    const [who, setWho] = useState('');
    const [confirming, setConfirming] = useState(false);
    const list = colleagues.data ?? [];
    const pick = list.some((c) => c.id === who) ? who : list[0]?.id ?? '';
    const name = list.find((c) => c.id === pick)?.name ?? '';
    if (colleagues.isSuccess && list.length === 0) return <p className={META}>{t('cowork_task.hand.nobody', 'There is nobody in your organisation to hand it to.')}</p>;
    if (confirming) {
        return (
            <div className="flex flex-col gap-2" role="group" aria-label={t('cowork_task.hand.go', 'Hand over')}>
                <p className="text-[15px]">{t('cowork_task.hand.confirm', "Hand '{title}' over to {name}? {name} gets a paused copy with its steps to check, and this task is deleted with its runs.", { title, name })}</p>
                <div className={ROW_ACTIONS}>
                    <button type="button" className={BTN_PRIMARY} disabled={handOver.isPending} onClick={() => handOver.mutate(pick, { onSuccess: onGone })}>{t('cowork_task.hand.go', 'Hand over')}</button>
                    <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)}>{t('cowork_task.keep_it', 'Keep it')}</button>
                </div>
                <Failure error={handOver.error} t={t} />
            </div>
        );
    }
    return (
        <div className="flex flex-wrap items-end gap-2">
            <span className="flex-[1_1_200px] min-w-0 flex flex-col gap-1">
                <label htmlFor={`cowork-task-hand-${coworkId}`} className={LABEL}>{t('cowork_task.hand.new_owner', 'New owner')}</label>
                <select id={`cowork-task-hand-${coworkId}`} className={FIELD} value={pick} onChange={(e) => setWho(e.target.value)}>
                    {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
            </span>
            <button type="button" className={BTN_QUIET} disabled={!pick || !name} onClick={() => setConfirming(true)}>{t('cowork_task.hand.ask', 'Hand over…')}</button>
        </div>
    );
}

export function HandOverRow({ coworkId, title, onGone, open, onToggle, t }: RowProps & { title: string; onGone: () => void }) {
    return (
        <FoldRow id="handover" label={t('cowork_task.more.hand_over', 'Hand over to a colleague')} open={open} onToggle={onToggle}>
            <HandOverBody coworkId={coworkId} title={title} onGone={onGone} t={t} />
        </FoldRow>
    );
}
