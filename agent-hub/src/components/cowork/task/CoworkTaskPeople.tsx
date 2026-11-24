/**
 * "People", in an opened task (./CoworkTaskView.tsx): what its owner arranges with colleagues, one row open at a time
 * (the caller holds which, so the header's Share opens the first):
 *
 *   - Share: who can see the task (Can see) and who also answers what it asks (Can answer, at most one), with the
 *     sharing history from the task's trail (server usecases/coworkShares.mts, usecases/coworkAudit.mts);
 *   - Send each result to a colleague's task, and Save as template / Export as file (./TaskPeopleResults.tsx);
 *   - Give this task away: a colleague gets a paused copy and it leaves the owner's list, after an in-page
 *     confirmation that says so.
 */
import { useState } from 'react';
import { fullTimestamp } from '../coworkFormat';
import { PassBody, TemplateBody } from './TaskPeopleResults';
import { ROWS, Section } from './taskRows';
import { BTN_PRIMARY, BTN_QUIET, FIELD, Failure, FoldRow, LABEL, META, ROW_ACTIONS } from './taskUi';
import { useCoworkColleagues, useCoworkHandOver } from '@/api/coworkHandOver';
import { useCoworkShares, type Share, type ShareRole } from '@/api/coworkShares';
import { useCoworkTrail } from '@/api/coworkTrail';
import type { TranslateFn } from '@/hooks/useTranslation';

export type PeopleRowId = 'share' | 'pass' | 'template' | 'give';

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
    const colleagues = useCoworkColleagues(coworkId, true);
    const { query, save } = useCoworkShares(coworkId, true);
    const list = colleagues.data ?? [];
    const shares = query.data ?? [];
    const nameOf = (userId: string) => list.find((c) => c.id === userId)?.name ?? shares.find((s) => s.userId === userId)?.name ?? userId;
    const write = (next: Share[]) => save.mutate(next);
    const free = list.filter((c) => !shares.some((s) => s.userId === c.id));
    return (
        <>
            {shares.length > 0 && (
                <ul className="list-none m-0 p-0">
                    {shares.map((s) => (
                        <li key={s.userId} className="flex flex-wrap items-center gap-2 py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px]">
                            <span className="flex-1 min-w-[8rem] font-medium">{nameOf(s.userId)}</span>
                            <RoleSelect id={`cowork-task-share-${coworkId}-${s.userId}`} value={s.role} label={t('cowork_task.share.what_they_do', 'What {name} can do', { name: nameOf(s.userId) })} t={t}
                                onChange={(role) => write(shares.map((x) => (x.userId === s.userId ? { ...x, role } : x)))} />
                            <button type="button" className={BTN_QUIET} disabled={save.isPending} onClick={() => write(shares.filter((x) => x.userId !== s.userId))}>{t('cowork_task.share.stop', 'Stop')}</button>
                        </li>
                    ))}
                </ul>
            )}
            <AddShare free={free} busy={save.isPending} coworkId={coworkId} onAdd={(share) => write([...shares, share])} t={t} />
            {colleagues.isSuccess && list.length === 0 && <p className={META}>{t('cowork_task.share.nobody', 'There is nobody in your organisation to share it with yet.')}</p>}
            <p className={META}>{t('cowork_task.share.hint', 'Can see: the task and its results. Can answer: also handles what it asks under Needs you. Only one colleague can answer. Nobody else can edit it.')}</p>
            <ShareHistory coworkId={coworkId} t={t} />
            <Failure error={save.error} t={t} />
        </>
    );
}

/** Who it is shared with, for the closed row. */
function useSharedWith(coworkId: string, t: TranslateFn): string {
    const shares = useCoworkShares(coworkId, true).query.data ?? [];
    if (shares.length === 0) return t('cowork_task.share.none', 'Not shared');
    return shares.map((s) => s.name ?? '').filter(Boolean).join(', ') || String(shares.length);
}

function GiveAwayBody({ coworkId, title, onGone, t }: { coworkId: string; title: string; onGone: () => void; t: TranslateFn }) {
    const colleagues = useCoworkColleagues(coworkId, true);
    const handOver = useCoworkHandOver(coworkId);
    const [who, setWho] = useState('');
    const [confirming, setConfirming] = useState(false);
    const list = colleagues.data ?? [];
    const pick = list.some((c) => c.id === who) ? who : list[0]?.id ?? '';
    const name = list.find((c) => c.id === pick)?.name ?? '';
    if (colleagues.isSuccess && list.length === 0) return <p className={META}>{t('cowork_task.give.nobody', 'There is nobody in your organisation to give it to.')}</p>;
    if (confirming) {
        return (
            <div className="flex flex-col gap-2" role="group" aria-label={t('cowork_task.give.go', 'Give it away')} data-testid="cowork-task-give-confirm">
                <p>{t('cowork_task.give.confirm', "Give '{title}' to {name}? {name} gets a paused copy and approves its steps first. The task leaves your list, with its runs.", { title, name })}</p>
                <div className={ROW_ACTIONS}>
                    <button type="button" className={BTN_PRIMARY} disabled={handOver.isPending} onClick={() => handOver.mutate(pick, { onSuccess: onGone })}>{t('cowork_task.give.go', 'Give it away')}</button>
                    <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)}>{t('cowork_task.keep_it', 'Keep it')}</button>
                </div>
                <Failure error={handOver.error} t={t} />
            </div>
        );
    }
    return (
        <div className="flex flex-wrap items-end gap-2">
            <span className="flex-[1_1_200px] min-w-0 flex flex-col gap-1">
                <label htmlFor={`cowork-task-give-${coworkId}`} className={LABEL}>{t('cowork_task.hand.new_owner', 'New owner')}</label>
                <select id={`cowork-task-give-${coworkId}`} className={FIELD} value={pick} onChange={(e) => setWho(e.target.value)}>
                    {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
            </span>
            <button type="button" className={BTN_QUIET} disabled={!pick || !name} onClick={() => setConfirming(true)}>{t('cowork_task.give.ask', 'Give it away…')}</button>
        </div>
    );
}

interface CoworkTaskPeopleProps {
    coworkId: string;
    title: string;
    /** The row that is open, if one is. */
    open: PeopleRowId | null;
    onOpen: (row: PeopleRowId | null) => void;
    /** The task left the owner's list (given away): the page closes. */
    onGone: () => void;
    t: TranslateFn;
}

export default function CoworkTaskPeople({ coworkId, title, open, onOpen, onGone, t }: CoworkTaskPeopleProps) {
    const sharedWith = useSharedWith(coworkId, t);
    const row = (id: PeopleRowId) => ({ id, open: open === id, onToggle: (next: string | null) => onOpen(next as PeopleRowId | null) });
    return (
        <Section id="cowork-task-people-h" heading={t('cowork_task.people.heading', 'People')} testId="cowork-task-people">
            <div className={ROWS}>
                <FoldRow {...row('share')} label={t('cowork_task.more.share', 'Share')} value={sharedWith}>
                    <ShareBody coworkId={coworkId} t={t} />
                </FoldRow>
                <FoldRow {...row('pass')} label={t('cowork_task.people.pass', "Send each result to a colleague's task")}>
                    <PassBody coworkId={coworkId} t={t} />
                </FoldRow>
                <FoldRow {...row('template')} label={t('cowork_task.people.template', 'Save as template / Export as file')}>
                    <TemplateBody coworkId={coworkId} title={title} t={t} />
                </FoldRow>
                <FoldRow {...row('give')} label={t('cowork_task.people.give', 'Give this task away')}>
                    <GiveAwayBody coworkId={coworkId} title={title} onGone={onGone} t={t} />
                </FoldRow>
            </div>
        </Section>
    );
}
