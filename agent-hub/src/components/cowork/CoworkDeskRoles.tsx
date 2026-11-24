/**
 * The roles of a desk, for the person who made it (./CoworkDeskPanel.tsx): who holds each role, who stands in, and
 * until when the holder is away. A question for a role goes to its stand-in while the holder is away, and moves to the
 * stand-in when the holder does not answer within a working day (server core/cowork/deskQuestions.mts). Saved as the
 * whole list. The maker also removes the desk here: the coworks on it stay their owners', and stop handing work on.
 */
import { useState } from 'react';
import { useDeskOwnerActions, type DeskView, type RoleInput } from '@/api/coworkDesks';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import type { TranslateFn } from '@/hooks/useTranslation';

const FIELD = 'rounded-lg border px-2 py-1 text-[12px] bg-[var(--bg-primary)] [border-color:var(--border-default)]';
const BUTTON = 'px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50';

interface Row { role: string; holderId: string; standInId: string; awayUntil: string }

const rowOf = (r: DeskView['roles'][number]): Row => ({ role: r.role, holderId: r.holderId ?? '', standInId: r.standInId ?? '', awayUntil: r.awayUntil ? r.awayUntil.slice(0, 10) : '' });
/** A day the holder is away up to and including it. */
const inputOf = (r: Row): RoleInput => ({ role: r.role.trim(), holderId: r.holderId, standInId: r.standInId || null, awayUntil: r.awayUntil ? `${r.awayUntil}T23:59:59.000Z` : null });
const complete = (r: Row): boolean => !!r.role.trim() && !!r.holderId && r.standInId !== r.holderId;

function Person({ label, value, people, none, onChange }: { label: string; value: string; people: DeskView['colleagues']; none: string; onChange: (id: string) => void }) {
    return (
        <select aria-label={label} className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{none}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
    );
}

function RoleRow({ row, index, people, t, onChange }: { row: Row; index: number; people: DeskView['colleagues']; t: TranslateFn; onChange: (row: Row | null) => void }) {
    const name = row.role.trim() || t('cowork_desks.roles.new', 'new role {n}', { n: index + 1 });
    return (
        <li className="flex flex-wrap items-center gap-1.5" data-testid="cowork-desk-role">
            <input aria-label={t('cowork_desks.roles.name', 'Name of role {n}', { n: index + 1 })} className={FIELD} value={row.role} maxLength={40} onChange={(e) => onChange({ ...row, role: e.target.value })} />
            <Person label={t('cowork_desks.roles.holder', 'Who holds {role}', { role: name })} value={row.holderId} people={people} none={t('cowork_desks.roles.choose', 'Choose someone')} onChange={(holderId) => onChange({ ...row, holderId })} />
            <Person label={t('cowork_desks.roles.stand_in', 'Who stands in for {role}', { role: name })} value={row.standInId} people={people} none={t('cowork_desks.roles.no_stand_in', 'No stand-in')} onChange={(standInId) => onChange({ ...row, standInId })} />
            <input type="date" aria-label={t('cowork_desks.roles.away', 'Holder of {role} away until', { role: name })} className={FIELD} value={row.awayUntil} onChange={(e) => onChange({ ...row, awayUntil: e.target.value })} />
            <button type="button" className="text-[12px] underline underline-offset-2 text-[var(--text-secondary)]" onClick={() => onChange(null)}>{t('cowork_desks.roles.remove', 'Remove')}</button>
        </li>
    );
}

export default function CoworkDeskRoles({ view }: { view: DeskView }) {
    const { t } = useTranslation();
    const { saveRoles, remove } = useDeskOwnerActions(view.desk.id);
    const [rows, setRows] = useState<Row[]>(() => view.roles.map(rowOf));
    const ready = rows.every(complete);
    const change = (i: number) => (row: Row | null) => setRows((all) => (row ? all.map((r, j) => (j === i ? row : r)) : all.filter((_, j) => j !== i)));
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-desk-roles">
            <h5 className="text-[12px] font-medium text-[var(--text-primary)]">{t('cowork_desks.roles.heading', 'Roles')}</h5>
            <p className="text-[12px] text-[var(--text-secondary)]">{t('cowork_desks.roles.hint', 'A question for a role goes to its holder. While the holder is away it goes to the stand-in, and a question not answered within a working day moves to the stand-in.')}</p>
            <ul className="flex flex-col gap-1.5">
                {rows.map((row, i) => <RoleRow key={i} row={row} index={i} people={view.colleagues} t={t} onChange={change(i)} />)}
            </ul>
            {!ready && <p role="alert" className="text-[12px] text-[var(--warning-ink)]">{t('cowork_desks.roles.incomplete', 'Every role needs a name and a holder, and a stand-in who is someone else.')}</p>}
            <div className="flex flex-wrap gap-2">
                <button type="button" className={BUTTON} onClick={() => setRows((all) => [...all, { role: '', holderId: '', standInId: '', awayUntil: '' }])}>{t('cowork_desks.roles.add', 'Add a role')}</button>
                <button type="button" className={BUTTON} disabled={!ready || saveRoles.isPending} onClick={() => saveRoles.mutate(rows.map(inputOf))}>{t('cowork_desks.roles.save', 'Save the roles')}</button>
                <button type="button" className={BUTTON} disabled={remove.isPending} onClick={() => remove.mutate()}>{t('cowork_desks.remove_desk', 'Remove the desk')}</button>
            </div>
            {(saveRoles.error || remove.error) && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(saveRoles.error ?? remove.error) || t('cowork_desks.failed', 'That did not work. Try again.')}</p>}
        </div>
    );
}
