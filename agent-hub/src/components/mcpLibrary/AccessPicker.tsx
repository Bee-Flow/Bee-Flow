import { Ban, Building2, Users } from 'lucide-react';
import ChoiceCards from '../shared/ChoiceCards';
import type { ChoiceCardOption } from '../shared/ChoiceCards';
import type { AccessMode } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import { DASHED } from './ui';

export interface AccessValue {
    mode: AccessMode;
    groupIds: string[];
}

interface AccessPickerProps {
    value: AccessValue;
    onChange: (next: AccessValue) => void;
    groups: Array<{ id: string; name: string }>;
    /** Offer "Nobody" (switch a server-wide server off for the org). */
    allowNobody?: boolean;
    disabled?: boolean;
}

/** Who in the organisation may use a server: everyone, or only some groups. */
export default function AccessPicker({ value, onChange, groups, allowNobody = false, disabled = false }: AccessPickerProps) {
    const { t } = useTranslation();
    const options: ChoiceCardOption<AccessMode>[] = [
        {
            value: 'everyone',
            label: t('mcp_library.access.everyone', 'Everyone in the organisation'),
            description: t('mcp_library.access.everyone_desc', 'Every member can give it to their agents.'),
            Icon: Building2,
        },
        {
            value: 'groups',
            label: t('mcp_library.access.groups', 'Specific groups'),
            description: groups.length
                ? t('mcp_library.access.groups_desc', 'Only members of the groups you pick.')
                : t('mcp_library.access.groups_none', 'Your organisation has no groups yet. Create them under Users & groups.'),
            Icon: Users,
            disabled: groups.length === 0,
        },
    ];
    if (allowNobody) {
        options.push({
            value: 'nobody',
            label: t('mcp_library.access.nobody', 'Off'),
            description: t('mcp_library.access.nobody_desc', 'Nobody in the organisation uses it.'),
            Icon: Ban,
        });
    }

    const toggleGroup = (id: string) => {
        const next = value.groupIds.includes(id) ? value.groupIds.filter(g => g !== id) : [...value.groupIds, id];
        onChange({ mode: 'groups', groupIds: next });
    };

    return (
        <div className="flex flex-col gap-3">
            <ChoiceCards
                value={value.mode}
                onChange={mode => onChange({ mode, groupIds: mode === 'groups' ? value.groupIds : [] })}
                options={options}
                ariaLabel={t('mcp_library.access.label', 'Who can use it')}
                columns={allowNobody ? 3 : 2}
                appearance="radio"
                disabled={disabled}
            />
            {value.mode === 'groups' && groups.length > 0 && (
                <fieldset className="m-0 p-0 border-0">
                    <legend className="mb-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
                        {t('mcp_library.access.pick_groups', 'Groups')}
                    </legend>
                    <div className="flex flex-wrap gap-1.5">
                        {groups.map(g => {
                            const on = value.groupIds.includes(g.id);
                            return (
                                <label
                                    key={g.id}
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[12px] transition ${on
                                        ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)] text-[var(--text-primary)]'
                                        : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'} ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                                >
                                    <input type="checkbox" className="sr-only" checked={on} disabled={disabled} onChange={() => toggleGroup(g.id)} />
                                    {g.name}
                                </label>
                            );
                        })}
                    </div>
                    {value.groupIds.length === 0 && (
                        <div className={`${DASHED} mt-2`}>
                            <p className="m-0 text-[12px] text-[var(--text-tertiary)]">
                                {t('mcp_library.access.pick_one', 'Pick at least one group.')}
                            </p>
                        </div>
                    )}
                </fieldset>
            )}
        </div>
    );
}
