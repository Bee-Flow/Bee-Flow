import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Field, INPUT_CLASS, inputStyle } from '../uiBits';
import useAppDataSource from '../useAppDataSource';

/**
 * The searchable picker, shared by `input_relation` and `input_person`.
 *
 * Both pick one thing (or several) out of a list fetched from the server, and
 * both need the same fiddly parts: arrow-key navigation with
 * aria-activedescendant, mouseDown-before-blur so a click lands before the list
 * closes, chips for the multiple case, and distinct loading / error / empty
 * states. Written twice those parts drift — the cell renderers next door had
 * already done exactly that, one growing formats the other never learned.
 *
 * This component owns interaction and presentation only. WHERE the options come
 * from is the caller's business.
 */

/** Fetching needs a react-query provider; previews and the screenshot renderer have none. */
export function useHasQueryClient() {
    try {
        return !!useQueryClient();
    } catch {
        return false;
    }
}

/**
 * Fetch-only: mirrors a binding into the shared data cache.
 *
 * A picker owns its own fetch because AppDataScope's static screen scan cannot
 * see a binding built from props at render time. Both land on the same cache
 * key, so this is one query, not two.
 */
export function BindingLoader({ binding, sample }) {
    useAppDataSource(binding, { sample });
    return null;
}

// How many rows a picker loads. The server's own ceiling is MAX_RESULT_ROWS
// (1000); this stays well under it. An explicit limit matters because the
// server clamps a MISSING one to 50 — a picker would then search inside the
// first fifty rows only, with nothing on screen to say so.
export const CANDIDATE_LIMIT = 500;

// How many options the list shows at once after filtering.
const VISIBLE_OPTIONS = 50;

export default function ComboBox({
    id, label, required = false, error = null,
    options, selectedIds, onPick, onRemove,
    multiple = false, disabled = false, placeholder = 'Search…',
    isLoading = false, loadError = null,
    emptyText = 'No matches.', disabledText = null,
    renderOption = null, renderChip = null,
    pinned = null,
}) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    // Which option the arrow keys are on. Without this the list is pointer-only
    // — the options listen on mouseDown and the input has no key handling, so
    // nothing can be picked from the keyboard at all.
    const [activeIndex, setActiveIndex] = useState(-1);

    const byId = useMemo(() => new Map(options.map((c) => [c.id, c])), [options]);
    const labelFor = (cid) => byId.get(cid)?.label ?? String(cid);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        // `pinned` (e.g. "Me") stays at the top and out of the search, because
        // it is the answer often enough to be worth one guaranteed click.
        const head = pinned && !selectedIds.includes(pinned.id) && !q ? [pinned] : [];
        const rest = options
            .filter((c) => !selectedIds.includes(c.id))
            .filter((c) => !pinned || c.id !== pinned.id)
            .filter((c) => !q || String(c.label).toLowerCase().includes(q))
            .slice(0, VISIBLE_OPTIONS);
        return [...head, ...rest];
    }, [options, query, selectedIds, pinned]);

    const pick = (cid) => {
        onPick(cid);
        setQuery('');
        if (!multiple) setOpen(false);
    };

    const onKeyDown = (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) { setOpen(true); return; }
            const step = e.key === 'ArrowDown' ? 1 : -1;
            const count = filtered.length;
            if (!count) return;
            setActiveIndex((i) => (i + step + count) % count);
            return;
        }
        if (e.key === 'Enter' && open && activeIndex >= 0 && filtered[activeIndex]) {
            e.preventDefault();
            pick(filtered[activeIndex].id);
            setActiveIndex(-1);
            return;
        }
        if (e.key === 'Escape' && open) {
            e.preventDefault();
            setOpen(false);
            setActiveIndex(-1);
        }
    };

    return (
        <Field id={id} label={label} required={required} error={error}>
            <div className="flex flex-col gap-2">
                {selectedIds.length ? (
                    <ul className="flex flex-wrap gap-1.5" aria-label={`${label} selected`}>
                        {selectedIds.map((cid) => (
                            <li
                                key={cid}
                                className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs font-medium"
                                style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)', borderRadius: 'var(--app-radius)' }}
                            >
                                {renderChip ? renderChip(byId.get(cid) || { id: cid, label: labelFor(cid) }) : labelFor(cid)}
                                <button type="button" onClick={() => onRemove(cid)} aria-label={`Remove ${labelFor(cid)}`} style={{ color: 'inherit' }}>
                                    <X className="w-3 h-3" aria-hidden="true" />
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : null}
                <div className="relative">
                    <input
                        id={id}
                        type="text"
                        value={query}
                        placeholder={disabled ? (disabledText || placeholder) : placeholder}
                        aria-label={`Search ${label}`}
                        aria-required={required || undefined}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? `${id}-error` : undefined}
                        disabled={disabled}
                        role="combobox"
                        aria-expanded={open}
                        aria-controls={`${id}-listbox`}
                        aria-activedescendant={open && activeIndex >= 0 && filtered[activeIndex] ? `${id}-opt-${filtered[activeIndex].id}` : undefined}
                        autoComplete="off"
                        onFocus={() => setOpen(true)}
                        // The delay lets an option's click land first. A shorter
                        // one loses the pick on a slow render.
                        onBlur={() => setTimeout(() => setOpen(false), 150)}
                        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(-1); }}
                        onKeyDown={onKeyDown}
                        className={`${INPUT_CLASS} pr-7`}
                        style={inputStyle(error)}
                    />
                    <ChevronDown className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
                    {open ? (
                        <div
                            className="absolute z-20 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto border shadow-lg"
                            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)' }}
                            role="listbox"
                            id={`${id}-listbox`}
                        >
                            {/* A load error must not read as "no results" — a 403,
                                a 500 or a connector that needs reconnecting all
                                used to reach the user as the words "no matching
                                records", and they concluded the table was empty. */}
                            {loadError ? (
                                <div
                                    className="px-2.5 py-2 text-xs"
                                    role="alert"
                                    style={{ color: 'var(--error)' }}
                                    data-app-combobox-error="true"
                                >
                                    {String(loadError)}
                                </div>
                            ) : isLoading ? (
                                <div className="px-2.5 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
                            ) : filtered.length ? (
                                filtered.map((c, i) => (
                                    <button
                                        key={c.id}
                                        id={`${id}-opt-${c.id}`}
                                        type="button"
                                        role="option"
                                        aria-selected={i === activeIndex}
                                        // mouseDown so the input's blur cannot
                                        // close the list before the pick lands.
                                        onMouseDown={(e) => { e.preventDefault(); pick(c.id); }}
                                        onMouseEnter={() => setActiveIndex(i)}
                                        className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-[var(--bg-tertiary)]"
                                        style={{
                                            color: 'var(--text-primary)',
                                            background: i === activeIndex ? 'var(--bg-tertiary)' : undefined,
                                        }}
                                    >
                                        {renderOption ? renderOption(c) : c.label}
                                    </button>
                                ))
                            ) : (
                                <div className="px-2.5 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                                    {disabled ? (disabledText || emptyText) : emptyText}
                                </div>
                            )}
                        </div>
                    ) : null}
                </div>
            </div>
        </Field>
    );
}
