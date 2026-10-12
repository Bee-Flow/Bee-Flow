import { Eye, PencilLine, Search, ShieldAlert, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { McpTool } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import { nOf } from '../admin/Studio/KnowledgeStudio/plural';
import { CHIP, CHIP_ERROR, CHIP_INFO, QUIET_BTN } from './ui';

interface ToolPickerProps {
    tools: McpTool[];
    selected: string[];
    onChange: (next: string[]) => void;
    disabled?: boolean;
    /** Tools the server added since the last look — marked "New". */
    newTools?: string[];
}

/**
 * Which tools agents get. Every tool is a checkbox with what the server says
 * it does, and whether the server says it only reads. Those hints are the
 * server's own claim, so the picker shows them and never decides on them.
 */
export default function ToolPicker({ tools, selected, onChange, disabled = false, newTools = [] }: ToolPickerProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const listId = useId();
    const chosen = useMemo(() => new Set(selected), [selected]);
    const fresh = useMemo(() => new Set(newTools), [newTools]);
    const readOnlyNames = tools.filter(tl => tl.readOnly === true).map(tl => tl.name);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return tools;
        return tools.filter(tl => tl.name.toLowerCase().includes(q) || tl.description.toLowerCase().includes(q));
    }, [tools, query]);

    const toggle = (name: string) => {
        const next = new Set(chosen);
        if (next.has(name)) next.delete(name); else next.add(name);
        onChange(tools.map(tl => tl.name).filter(n => next.has(n)));
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-[var(--text-secondary)] tabular-nums">
                    {t('mcp_library.tools.selected', '{selected} of {total} switched on', { selected: chosen.size, total: tools.length })}
                </span>
                <span className="flex-1" />
                <button type="button" className={QUIET_BTN} disabled={disabled} onClick={() => onChange(tools.map(tl => tl.name))}>
                    {t('mcp_library.tools.all', 'All')}
                </button>
                {readOnlyNames.length > 0 && (
                    <button type="button" className={QUIET_BTN} disabled={disabled} onClick={() => onChange(readOnlyNames)}>
                        <Eye size={13} aria-hidden="true" />
                        {t('mcp_library.tools.read_only_only', 'Only read-only')}
                    </button>
                )}
                <button type="button" className={QUIET_BTN} disabled={disabled} onClick={() => onChange([])}>
                    {t('mcp_library.tools.none', 'None')}
                </button>
            </div>

            {tools.length > 8 && (
                <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] text-[var(--text-tertiary)] focus-within:border-[var(--accent-primary)]">
                    <Search size={13} aria-hidden="true" />
                    <input
                        type="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={t('mcp_library.tools.search', 'Search tools…')}
                        aria-label={t('mcp_library.tools.search_label', 'Search tools')}
                        aria-controls={listId}
                        className="flex-1 min-w-0 bg-transparent outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                    />
                    {query && (
                        <button type="button" onClick={() => setQuery('')} aria-label={t('mcp_library.tools.clear_search', 'Clear the search')} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                            <X size={12} />
                        </button>
                    )}
                </label>
            )}

            <ul id={listId} className="m-0 p-0 list-none flex flex-col rounded-[10px] border border-[var(--border-default)] divide-y divide-[var(--border-subtle)] max-h-[22rem] overflow-y-auto custom-scrollbar">
                {shown.map((tl, i) => {
                    const on = chosen.has(tl.name);
                    return (
                        <li key={tl.name}>
                            <label className={`flex items-start gap-3 px-3 py-2.5 transition ${disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-[var(--bg-secondary)]'}`}>
                                <input
                                    type="checkbox"
                                    aria-label={tl.name}
                                    aria-describedby={tl.description ? `${listId}-d${i}` : undefined}
                                    className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[var(--accent-primary)]"
                                    checked={on}
                                    disabled={disabled}
                                    onChange={() => toggle(tl.name)}
                                />
                                <span className="flex-1 min-w-0">
                                    <span className="flex flex-wrap items-center gap-1.5">
                                        <code className="text-[12px] font-semibold text-[var(--text-primary)] break-all">{tl.name}</code>
                                        {fresh.has(tl.name) && <span className={CHIP_INFO}>{t('mcp_library.tools.new', 'New')}</span>}
                                        {tl.destructive === true ? (
                                            <span className={CHIP_ERROR}><ShieldAlert size={11} aria-hidden="true" />{t('mcp_library.tools.destructive', 'Can delete data')}</span>
                                        ) : tl.readOnly === true ? (
                                            <span className={CHIP}><Eye size={11} aria-hidden="true" />{t('mcp_library.tools.read_only', 'Read-only')}</span>
                                        ) : tl.readOnly === false ? (
                                            <span className={CHIP}><PencilLine size={11} aria-hidden="true" />{t('mcp_library.tools.changes', 'Can change data')}</span>
                                        ) : null}
                                    </span>
                                    {tl.description && (
                                        <span id={`${listId}-d${i}`} className="block mt-0.5 text-[11.5px] leading-snug text-[var(--text-tertiary)] line-clamp-2">{tl.description}</span>
                                    )}
                                </span>
                            </label>
                        </li>
                    );
                })}
                {shown.length === 0 && (
                    <li className="px-3 py-3 text-[12px] text-[var(--text-secondary)]">
                        {t('mcp_library.tools.no_match', 'No tool matches.')}{' '}
                        <button type="button" className="underline text-[var(--text-primary)]" onClick={() => setQuery('')}>
                            {t('mcp_library.tools.clear_search', 'Clear the search')}
                        </button>
                    </li>
                )}
            </ul>
            {tools.some(tl => tl.readOnly === null) && (
                <p className="m-0 text-[11px] leading-snug text-[var(--text-tertiary)]">
                    {nOf(t, 'mcp_library.tools.unlabelled', tools.filter(tl => tl.readOnly === null).length,
                        '{count} tool does not say whether it changes data. Leave it off if you are unsure.',
                        '{count} tools do not say whether they change data. Leave them off if you are unsure.')}
                </p>
            )}
        </div>
    );
}
