import React, { useId, useMemo, useState } from 'react';
import { UserPlus, Users } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { filterPrincipals, usePeopleDirectory, type Principal } from '../../../../api/queries/automation/people';

/**
 * "Add a person or group…": a search field over the org's people and groups,
 * with the hits as a list under it. Shared by the sharing dialog and the
 * notification recipients. `exclude` holds `type:id` keys already chosen.
 */
/** A server-side search instead of an automation's directory: the picker reports what is typed and lists what comes back. */
export interface PrincipalSource {
    principals: Principal[];
    loading: boolean;
    onQuery: (q: string) => void;
    /** Characters needed before the source is asked. */
    minChars: number;
}

function usePrincipalHits({ automationId, source, query, open, exclude, groupsOnly }: {
    automationId: string | null | undefined; source: PrincipalSource | undefined; query: string; open: boolean;
    exclude: Set<string> | undefined; groupsOnly: boolean;
}) {
    const directory = usePeopleDirectory(source ? null : automationId, { enabled: open });
    const typedEnough = !source || query.trim().length >= source.minChars;
    const hits = useMemo(() => {
        if (source) {
            if (!typedEnough) return [];
            return source.principals.filter(p => (!groupsOnly || p.type === 'group') && !exclude?.has(`${p.type}:${p.id}`));
        }
        const all = (directory.data || []).filter(p => !groupsOnly || p.type === 'group');
        return filterPrincipals(all, query, exclude);
    }, [source, typedEnough, directory.data, query, exclude, groupsOnly]);
    const loading = source ? typedEnough && source.loading : directory.isLoading;
    return { hits, loading, typedEnough };
}

function PrincipalList({ id, source, typedEnough, loading, hits, onPick }: {
    id: string; source: PrincipalSource | undefined; typedEnough: boolean; loading: boolean; hits: Principal[]; onPick: (p: Principal) => void;
}) {
    const { t } = useTranslation();
    return (
        <ul
            id={id}
            role="listbox"
            className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg py-1"
        >
            {source && !typedEnough && (
                <li className="px-3 py-2 text-xs text-[var(--text-tertiary)]" data-testid="principal-min-chars">
                    {t('project_home.members.type_more', 'Type at least {n} characters', { n: source.minChars })}
                </li>
            )}
            {loading && (
                <li className="px-3 py-2 text-xs text-[var(--text-tertiary)]">{t('automations.people.loading', 'Loading people…')}</li>
            )}
            {typedEnough && !loading && hits.length === 0 && (
                <li className="px-3 py-2 text-xs text-[var(--text-tertiary)]">{t('automations.people.no_match', 'Nobody found')}</li>
            )}
            {hits.map(p => (
                <li key={`${p.type}:${p.id}`} role="option" aria-selected={false}>
                    <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onPick(p)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--bg-tertiary)]"
                    >
                        <PrincipalAvatar principal={p} />
                        <span className="min-w-0">
                            <span className="block truncate font-medium text-[var(--text-primary)]">{p.name}</span>
                            <span className="block truncate text-[var(--text-tertiary)]">{principalDetail(p, t)}</span>
                        </span>
                    </button>
                </li>
            ))}
        </ul>
    );
}

export default function PrincipalPicker({ automationId, source, onPick, exclude, groupsOnly = false, autoFocus = false, inputRef, label, placeholder }: {
    /** The automation whose organisation's people are listed. Not needed with a `source`. */
    automationId?: string | null | undefined;
    source?: PrincipalSource;
    onPick: (p: Principal) => void;
    exclude?: Set<string>;
    groupsOnly?: boolean;
    autoFocus?: boolean;
    inputRef?: React.Ref<HTMLInputElement>;
    label?: string;
    placeholder?: string;
}) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const listId = useId();
    const { hits, loading, typedEnough } = usePrincipalHits({ automationId, source, query, open: open || autoFocus, exclude, groupsOnly });

    const pick = (p: Principal) => {
        onPick(p);
        setQuery('');
        source?.onQuery('');
        setOpen(false);
    };

    return (
        <div className="relative flex-1 min-w-0">
            <label className="flex items-center gap-1.5 px-2.5 py-[7px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] focus-within:border-[var(--accent-primary)]">
                <UserPlus className="w-[13px] h-[13px] text-[var(--text-tertiary)] shrink-0" aria-hidden />
                <input
                    type="text"
                    ref={inputRef}
                    value={query}
                    autoFocus={autoFocus}
                    role="combobox"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-label={label ?? (groupsOnly ? t('automations.people.add_group', 'Add a group') : t('automations.people.add', 'Add a person or group'))}
                    placeholder={placeholder ?? (groupsOnly ? t('automations.people.add_group_placeholder', 'Add a group…') : t('automations.people.add_placeholder', 'Add a person or group…'))}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setTimeout(() => setOpen(false), 150)}
                    onChange={(e) => { setQuery(e.target.value); setOpen(true); source?.onQuery(e.target.value); }}
                    className="flex-1 min-w-0 bg-transparent outline-none text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
            </label>
            {open && <PrincipalList id={listId} source={source} typedEnough={typedEnough} loading={loading} hits={hits} onPick={pick} />}
        </div>
    );
}

type T = ReturnType<typeof useTranslation>['t'];

export function principalDetail(p: { type: string; detail?: string | null; memberCount?: number | null }, t: T): string {
    if (p.type === 'group') {
        return p.memberCount != null
            ? t('automations.people.group_members', 'group · {n} people', { n: p.memberCount })
            : t('automations.people.group', 'group');
    }
    return p.detail || '';
}

/** 26px round avatar: the initial for a person, a people icon on an AI tint for a group. */
export function PrincipalAvatar({ principal }: { principal: { type: string; name: string } }) {
    if (principal.type === 'group') {
        return (
            <span className="w-[26px] h-[26px] rounded-full grid place-items-center shrink-0 bg-[color-mix(in_srgb,var(--type-ai)_16%,transparent)] text-[var(--type-ai)]">
                <Users className="w-[13px] h-[13px]" aria-hidden />
            </span>
        );
    }
    return (
        <span className="w-[26px] h-[26px] rounded-full grid place-items-center shrink-0 bg-[var(--bg-tertiary)] font-bold text-[var(--text-primary)]">
            {(principal.name || '?').trim().charAt(0).toUpperCase()}
        </span>
    );
}
