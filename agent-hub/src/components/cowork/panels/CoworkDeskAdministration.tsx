import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useCreateDesk, useDeskView, useItemDeskActions, useSaveDeskRoles, type DeskSummary, type DeskView, type DeskMember, type RoleInput } from '@/api/coworkDesks';
import { INPUT, LabeledField, PanelButton, PanelLoading, Problem } from './panelParts';

export function CreateDeskForm({message, onCreated}: {message:string; onCreated:(id:string)=>void}) {
    const {t} = useTranslation();
    const create = useCreateDesk();
    const [name, setName] = useState(() => /\b(?:named|called|genaamd|met de naam)\s+(.+)$/i.exec(message)?.[1].replace(/[?!.]+$/, '').trim() ?? '');
    return <form className="grid gap-2" onSubmit={e => {e.preventDefault(); if (name.trim() && !create.isPending) create.mutate(name.trim(), {onSuccess:view => onCreated(view.desk.id)});}}>
        <LabeledField label={t('cowork_desks.new_name', 'Name of a new desk')} id="desk-name"><input id="desk-name" className={INPUT} value={name} maxLength={80} onChange={e=>setName(e.target.value)}/></LabeledField>
        <PanelButton type="submit" busy={create.isPending} disabled={!name.trim()}>{t('cowork_teamwork.create_desk','Create desk')}</PanelButton>
        <Problem error={create.error} fallback={t('cowork_desks.failed','That did not work. Try again.')}/>
    </form>;
}

function RoleForm({view, message, done}: {view: DeskView; message:string; done:()=>void}) {
    const {t} = useTranslation();
    const roles = view.roles;
    const matches = roles.filter(r => message.toLocaleLowerCase().includes(r.role.toLocaleLowerCase()));
    const [selected, select] = useState(matches.length === 1 ? matches[0].role : '');
    const row = roles.find(r => r.role === selected);
    const [edit, setEdit] = useState<Partial<RoleInput>>({});
    const [drop, setDrop] = useState(false);
    const save = useSaveDeskRoles(view.desk.id);
    const role = {role: '', holderId: '', ...row, ...edit};
    const keep = roles.filter(r => r.role !== selected).map(r => ({role:r.role, holderId:r.holderId ?? '', standInId:r.standInId, awayUntil:r.awayUntil}));
    const changes = drop ? keep : [...keep, {role:role.role, holderId:role.holderId ?? '', standInId:role.standInId, awayUntil:role.awayUntil}];
    const valid = changes.length <= 20 && changes.every(r=>r.role.trim() && r.holderId && r.holderId !== r.standInId) && new Set(changes.map(r=>r.role.trim())).size === changes.length;
    const choose = (id:string) => {select(id);setEdit({});setDrop(false);};
    return <div className="grid gap-2">
        <LabeledField id="desk-role-select" label={t('cowork_desks.roles.heading','Roles')}><select id="desk-role-select" className={INPUT} value={selected} onChange={e=>choose(e.target.value)}>
            <option value=""/>{roles.map(r=><option key={r.role}>{r.role}</option>)}<option value="__new">{t('cowork_desks.roles.add','Add a role')}</option></select></LabeledField>
        {selected && <>
            <LabeledField id="desk-role-name" label={t('cowork_panels.team.role','Role')}><input id="desk-role-name" className={INPUT} value={role.role} maxLength={40} onChange={e=>setEdit({...edit,role:e.target.value})}/></LabeledField>
            <LabeledField id="desk-holder" label={t('cowork_panels.team.who','Who')}><select id="desk-holder" className={INPUT} value={role.holderId ?? ''} onChange={e=>setEdit({...edit,holderId:e.target.value,standInId:e.target.value === role.standInId ? null : role.standInId})}>
                <option value=""/>{view.colleagues.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></LabeledField>
            <LabeledField id="desk-stand-in" label={t('cowork_panels.team.stand_in','Stand-in')}><select id="desk-stand-in" className={INPUT} value={role.standInId ?? ''} onChange={e=>setEdit({...edit,standInId:e.target.value || null})}>
                <option value="">{t('cowork_panels.team.nobody','Nobody')}</option>{view.colleagues.filter(p=>p.id!==role.holderId).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></LabeledField>
            {role.standInId && <LabeledField id="desk-away" label={t('cowork_desks.roles.away','Holder of {role} away until', {role: role.role})}>
                <input id="desk-away" type="date" className={INPUT} value={role.awayUntil?.slice(0, 10) ?? ''}
                    onChange={e=>setEdit({...edit,awayUntil:e.target.value ? e.target.value + 'T00:00:00.000Z' : null})}/>
            </LabeledField>}
            {row && <label><input type="checkbox" checked={drop} onChange={e=>setDrop(e.target.checked)}/> {t('cowork_desks.roles.remove','Remove')} {row.role}</label>}
            <PanelButton disabled={!valid} busy={save.isPending} onClick={()=>save.mutate(changes,{onSuccess:done})}>{t('cowork_desks.roles.save','Save the roles')}</PanelButton>
        </>}
        <Problem error={save.error} fallback={t('cowork_desks.failed','That did not work. Try again.')}/>
    </div>;
}

export function DeskRoles({desk,message,done}: {desk: DeskSummary; message:string; done:()=>void}) {
    const view = useDeskView(desk.id);
    const {t} = useTranslation();
    if (view.error) return <Problem error={view.error} fallback={t('cowork_desks.failed','That did not work. Try again.')}/>;
    if (!desk.isOwner) return <p>{t('cowork_teamwork.roles_owner','Only the desk owner can change its roles.')}</p>;
    return view.data ? <RoleForm view={view.data} message={message} done={done}/> : <PanelLoading />;
}

export function MemberRole({deskId, member, roles, done}: {deskId: string; member: DeskMember; roles: DeskView['roles']; done: () => void}) {
    const {t} = useTranslation();
    const [role, setRole] = useState(member.deskRole ?? '');
    const {chooseRole} = useItemDeskActions(member.scheduleId);
    return <div className="grid gap-2">
        <LabeledField id="desk-decider" label={t('cowork_desks.decides', 'Who decides its questions')}>
            <select id="desk-decider" className={INPUT} value={role} onChange={e => setRole(e.target.value)}>
                <option value="">{t('cowork_desks.decides_as_before', 'As without the desk')}</option>
                {roles.map(r => <option value={r.role} key={r.role}>{r.role}</option>)}
            </select>
        </LabeledField>
        <PanelButton disabled={role === (member.deskRole ?? '')} busy={chooseRole.isPending}
            onClick={() => chooseRole.mutate({deskId, deskRole: role || null}, {onSuccess: done})}>{t('cowork_task.edit.save', 'Save')}</PanelButton>
        <Problem error={chooseRole.error} fallback={t('cowork_desks.failed', 'That did not work. Try again.')}/>
    </div>;
}
