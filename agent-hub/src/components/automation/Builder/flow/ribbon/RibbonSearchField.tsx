import { useEffect, useId, useRef, useState } from 'react';
import { IntegrationLogo } from './jsComponents';
import type { KeyboardEvent, RefObject } from 'react';
import { Search } from 'lucide-react';
import { stepDragProps } from '../stepDrag';
import useTranslation from '../../../../../hooks/useTranslation';
import type { RibbonResult } from './ribbonSearch';
import type { StepPayload } from './ribbonCategories';

type AddFn = (payload: StepPayload) => void;

interface Props {
    query: string;
    onQueryChange: (q: string) => void;
    results: RibbonResult[];
    onAdd: AddFn;
    inputRef: RefObject<HTMLInputElement | null>;
}

function ResultRow({ id, result: r, active, onHover, onPick }: {
    id: string;
    result: RibbonResult;
    active: boolean;
    onHover: () => void;
    onPick: () => void;
}) {
    const Icon = r.Icon;
    const tone = r.tone === 'skill' ? 'text-[var(--kind-skill)]' : r.tone === 'agent' ? 'text-[var(--type-ai)]' : 'text-[var(--text-secondary)]';
    return (
        <div
            id={id}
            role="option"
            aria-selected={active}
            aria-disabled={r.disabled ? true : undefined}
            title={r.disabled ? r.disabledReason : undefined}
            onMouseEnter={onHover}
            // Keep focus in the field, so Enter and the arrows keep working.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onPick}
            {...(r.disabled ? null : stepDragProps(r.payload))}
            className={`flex items-start gap-2.5 px-3 py-1.5 cursor-pointer ${active ? 'bg-[var(--bg-secondary)]' : ''} ${r.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
            <span className={`shrink-0 mt-0.5 h-6 w-6 rounded-md bg-[var(--bg-secondary)] grid place-items-center ${tone}`}>
                {Icon ? <Icon size={14} /> : <IntegrationLogo integrationId={r.integrationId} tool={r.tool} size={14} />}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm text-[var(--text-primary)] truncate">{r.label}</span>
                <span className="block text-[11px] leading-snug text-[var(--text-tertiary)] truncate">
                    {r.disabled ? r.disabledReason : [...new Set([r.context, r.secondary].filter(Boolean))].join(' · ')}
                </span>
            </span>
        </div>
    );
}

/**
 * The 220px search at the start of the ribbon row (design 5a), with its "/"
 * hint. Results drop down under it; arrows move, Enter adds, Escape leaves.
 * Every result is also a drag source.
 */
export default function RibbonSearchField({ query, onQueryChange, results, onAdd, inputRef }: Props) {
    const { t } = useTranslation();
    const listId = useId();
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const showList = open && query.trim().length > 0;

    useEffect(() => { setActive(0); }, [query]);
    // Outside click closes. Capture phase: the canvas stops mousedown propagation.
    useEffect(() => {
        if (!showList) return undefined;
        const onDown = (e: MouseEvent) => {
            if (wrapRef.current && e.target instanceof Node && wrapRef.current.contains(e.target)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        return () => document.removeEventListener('mousedown', onDown, true);
    }, [showList]);

    const pick = (r: RibbonResult | undefined) => {
        if (!r || r.disabled) return;
        onAdd(r.payload);
        onQueryChange('');
        setOpen(false);
        inputRef.current?.blur();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, Math.max(results.length - 1, 0))); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(results[active]); }
        else if (e.key === 'Escape') { e.preventDefault(); onQueryChange(''); setOpen(false); inputRef.current?.blur(); }
    };

    return (
        <div ref={wrapRef} className="relative shrink-0 mr-2">
            <label className="flex items-center gap-1.5 h-[30px] px-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-tertiary)] w-[220px] @max-[820px]/ribbon:w-[160px] focus-within:border-[var(--accent-primary)]">
                <Search size={13} className="shrink-0" />
                <input
                    ref={inputRef}
                    type="text"
                    role="combobox"
                    aria-expanded={showList}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
                    aria-label={t('automations.ribbon.search_label', 'Add a step')}
                    value={query}
                    placeholder={t('automations.ribbon.search_placeholder', 'Add a step…')}
                    onChange={(e) => { onQueryChange(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    onKeyDown={onKeyDown}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
                <kbd className="shrink-0 px-[5px] rounded border border-[var(--border-default)] text-[10px] font-sans leading-4" aria-hidden="true">/</kbd>
            </label>
            {showList && (
                <div
                    id={listId}
                    role="listbox"
                    aria-label={t('automations.ribbon.search_results', 'Steps')}
                    className="absolute left-0 top-full mt-1 w-[340px] max-h-[60vh] overflow-y-auto custom-scrollbar z-[60] rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-xl py-1"
                >
                    {results.length === 0 ? (
                        <div className="px-3 py-2 text-[12px] text-[var(--text-tertiary)]">
                            {t('automations.ribbon.search_none', 'Nothing matches “{q}”.', { q: query.trim() })}
                        </div>
                    ) : results.map((r, i) => (
                        <ResultRow
                            key={`${r.payload?.kind}:${r.key}:${r.label}`}
                            id={`${listId}-${i}`}
                            result={r}
                            active={i === active}
                            onHover={() => setActive(i)}
                            onPick={() => pick(r)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
