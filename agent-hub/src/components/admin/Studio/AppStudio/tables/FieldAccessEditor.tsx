import useTranslation from '@/hooks/useTranslation';
import { PUBLIC_ROLE, accessOf, takesWriteList, withAccessList, withRole } from './fieldAccess';
import type { AccessKey } from './fieldAccess';
import type { ModelField } from './tablesManagerModel';

/**
 * The column rights of one field in the table editor: which roles may read the
 * field and which may change it (field.access). A list is only stored once its
 * switch is on; a field without one behaves as every field did before.
 */

const CHECK_CLS = 'accent-[var(--accent-primary)]';

interface Props {
    field: ModelField;
    update: (next: ModelField) => void;
    /** The role keys the app has (fieldAccess.roleKeysOf). */
    roles: string[];
    disabled: boolean;
}

interface ListProps extends Props {
    listKey: AccessKey;
    label: string;
    hint: string;
}

function RoleList({ field, update, roles, disabled, listKey, label, hint }: ListProps) {
    const { t } = useTranslation();
    const list = accessOf(field)[listKey];
    // A role that was removed from the app stays listed, so it can be unticked.
    const shown = [...roles, ...(list || []).filter((r) => !roles.includes(r))];
    return (
        <div className="flex flex-col gap-1">
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-[var(--text-secondary)]">
                <input type="checkbox" className={CHECK_CLS} checked={!!list} disabled={disabled}
                    onChange={(e) => update(withAccessList(field, listKey, e.target.checked ? [] : null))} />
                {label}
            </label>
            {list ? (
                <div className="ml-5 flex flex-col gap-1">
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
                        {shown.map((role) => (
                            <label key={role} className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input type="checkbox" className={CHECK_CLS} checked={list.includes(role)} disabled={disabled}
                                    onChange={(e) => update(withRole(field, listKey, role, e.target.checked))} />
                                {role === PUBLIC_ROLE ? t('studio_apps_dk.role_public', 'Visitors of public pages') : role}
                            </label>
                        ))}
                    </div>
                    <span className="text-[11px] text-[var(--text-tertiary)]">{hint}</span>
                </div>
            ) : null}
        </div>
    );
}

export default function FieldAccessEditor(props: Props) {
    const { t } = useTranslation();
    return (
        <fieldset className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] p-2" data-field-access="true">
            <legend className="px-1 text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_dk.heading', 'Who can see and change this field')}</legend>
            <RoleList
                {...props}
                listKey="read"
                label={t('studio_apps_dk.limit_read', 'Only some roles can see it')}
                hint={t('studio_apps_dk.read_hint', 'You always see it. Every other role gets records without this field, and a list, filter, sort or chart that uses it does not load for them.')}
            />
            {takesWriteList(props.field) ? (
                <RoleList
                    {...props}
                    listKey="write"
                    label={t('studio_apps_dk.limit_write', 'Only some roles can change it')}
                    hint={t('studio_apps_dk.write_hint', 'You can always change it. Without this list, the roles that can see the field can change it.')}
                />
            ) : null}
        </fieldset>
    );
}
