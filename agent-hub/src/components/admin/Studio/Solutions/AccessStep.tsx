import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { ListStatusProps, AccessPerson, AccessAdderProps, AccessStepProps } from './installWizardSteps.types';

export function ListStatus({ status, testId }: ListStatusProps) {
    const { t } = useTranslation();
    if (status !== 'error') return null;
    return (
        <p className="flex items-start gap-1.5 text-[11px] text-[var(--warning)]" data-testid={testId}>
            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            {t('solutions.install_list_failed', 'That list could not be loaded, so what you can choose from here is not the whole picture.')}
        </p>
    );
}

export const selectCls = 'w-full px-2 py-1.5 rounded-lg text-xs border outline-none';

export const selectStyle = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)',
};

function AccessAdder({ users, groups, onAdd }: AccessAdderProps) {
    const { t } = useTranslation();
    const [type, setType] = useState('user');
    const [id, setId] = useState('');
    const [permission, setPermission] = useState('viewer');
    const options = type === 'user' ? users : groups;

    return (
        <div className="flex flex-wrap items-end gap-2">
                <select
                    className={`${selectCls} w-auto`} style={selectStyle} value={type}
                    aria-label={t('solutions.install_access_kind', 'People or groups')}
                    onChange={(e) => { setType(e.target.value); setId(''); }}
                >
                    <option value="user">{t('solutions.install_access_person', 'Person')}</option>
                    <option value="group">{t('solutions.install_access_group', 'Group')}</option>
                </select>
                <select
                    className={`${selectCls} flex-1 min-w-[160px]`} style={selectStyle} value={id}
                    aria-label={t('solutions.install_access_who', 'Who to add')}
                    onChange={(e) => setId(e.target.value)}
                >
                    <option value="">{t('solutions.install_access_pick', 'Choose…')}</option>
                    {options.map(o => (
                        <option key={o.id} value={o.id}>{o.username || o.email || o.name || o.id}</option>
                    ))}
                </select>
                <select
                    className={`${selectCls} w-auto`} style={selectStyle} value={permission}
                    aria-label={t('solutions.install_access_role', 'What they may do')}
                    onChange={(e) => setPermission(e.target.value)}
                >
                    <option value="viewer">{t('solutions.install_role_viewer', 'Can view')}</option>
                    <option value="editor">{t('solutions.install_role_editor', 'Can edit')}</option>
                </select>
                <button
                    type="button"
                    onClick={() => { if (id) { onAdd({ type, id, permission }); setId(''); } }}
                    disabled={!id}
                    className="px-2.5 py-1.5 rounded-lg text-xs border flex items-center gap-1 disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                    data-testid="install-access-add"
                >
                    <Plus className="w-3 h-3" />
                    {t('solutions.install_access_add', 'Add')}
                </button>
        </div>
    );
}

export function AccessStep({ people, groups, access, setAccess }: AccessStepProps) {
    const { t } = useTranslation();
    const users: AccessPerson[] = people.status === 'ok' && Array.isArray(people.data) ? people.data : [];
    const groupList: AccessPerson[] = groups.status === 'ok' && Array.isArray(groups.data) ? groups.data : [];

    const labelFor = (entry: { type: string; id: string; permission: string }) => {
        const found = (entry.type === 'user' ? users : groupList).find(x => x.id === entry.id);
        return found ? (found.username || found.email || found.name || entry.id) : entry.id;
    };

    return (
        <div className="space-y-3">
            <p className="text-xs text-[var(--text-secondary)]">
                {t('solutions.install_access_intro',
                    'Who else can reach this Solution. You install as its owner either way, and you can change this later on the project page.')}
            </p>

            <AccessAdder
                users={users}
                groups={groupList}
                onAdd={(entry) => {
                    // Adding the same person twice is not a second decision.
                    if (access.some(a => a.type === entry.type && a.id === entry.id)) return;
                    setAccess([...access, entry]);
                }}
            />
            <ListStatus status={people.status === 'error' ? 'error' : groups.status} testId="install-access-unavailable" />

            {access.length === 0 ? (
                <p className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">
                    {t('solutions.install_access_none', 'Nobody else, for now.')}
                </p>
            ) : (
                <ul className="space-y-1" data-testid="install-access-list">
                    {access.map(entry => (
                        <li key={`${entry.type}:${entry.id}`}
                            className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                            <span className="truncate">{labelFor(entry)}</span>
                            <span className="flex items-center gap-2 flex-shrink-0">
                                <span className="text-[11px] text-[var(--text-tertiary)]">
                                    {entry.permission === 'editor'
                                        ? t('solutions.install_role_editor', 'Can edit')
                                        : t('solutions.install_role_viewer', 'Can view')}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setAccess(access.filter(a => !(a.type === entry.type && a.id === entry.id)))}
                                    aria-label={t('solutions.install_access_remove', 'Remove')}
                                >
                                    <Trash2 className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
