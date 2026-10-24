/**
 * CommandPalette — ⌘K / Ctrl+K palette that surfaces EXISTING actions only
 * (formatting, insert, generate, export, view toggles). Every entry is a thunk
 * over a handler the page already owns — it adds no new capability.
 *
 * a11y: a listbox with aria-activedescendant, arrow-key navigation, Enter to
 * run, focus moves to the filter input on open. The dialog itself is the
 * shared Modal (placement 'top'): Escape and a press on the scrim close it,
 * Tab stays inside it, and focus goes back to where it was.
 */
import { Search, CornerDownLeft } from 'lucide-react';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import Modal from '../../../../components/shared/Modal';
import type { PaletteCommand } from './buildCommands';

interface CommandPaletteProps {
    open?: boolean;
    onClose?: () => void;
    commands?: PaletteCommand[];
    placeholder?: string;
    emptyText?: string;
}

export default function CommandPalette({ open, onClose, commands = [], placeholder = 'Type a command…', emptyText = 'No matching commands' }: CommandPaletteProps) {
    const [query, setQuery] = useState<string>('');
    const [activeIdx, setActiveIdx] = useState<number>(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) {
            setQuery('');
            setActiveIdx(0);
            const id = setTimeout(() => inputRef.current?.focus(), 0);
            return () => clearTimeout(id);
        }
    }, [open]);

    const filtered = useMemo(() => {
        const list = commands.filter((c: PaletteCommand) => c.enabled !== false);
        const q = query.trim().toLowerCase();
        if (!q) return list;
        return list.filter((c: PaletteCommand) => `${c.label} ${c.keywords || ''} ${c.group || ''}`.toLowerCase().includes(q));
    }, [commands, query]);

    const [prevQuery, setPrevQuery] = useState(query);
    if (prevQuery !== query) {
        setPrevQuery(query);
        setActiveIdx(0);
    }
    const lastIdx = Math.max(0, filtered.length - 1);
    if (activeIdx > lastIdx) setActiveIdx(lastIdx);

    if (!open) return null;

    const run = (cmd: PaletteCommand | undefined) => {
        if (!cmd) return;
        onClose?.();
        try { cmd.run?.(); } catch (e) { console.error('[CommandPalette] command failed', e); }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i: number) => Math.min(i + 1, filtered.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i: number) => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); run(filtered[activeIdx]); }
    };


    return (
        <Modal
            open
            onClose={() => onClose?.()}
            placement="top"
            variant="bare"
            size="auto"
            zIndex={10000}
            label={placeholder}
            className="max-w-[560px]"
        >
            <div
                className="w-full rounded-2xl border shadow-2xl overflow-hidden flex flex-col [background:var(--bg-primary)] [border-color:var(--border-default)] max-h-[70vh]"
            >
                <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)]">
                    <Search className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder={placeholder}
                        role="combobox"
                        aria-expanded="true"
                        aria-controls="bf-cmd-list"
                        aria-activedescendant={filtered[activeIdx] ? `bf-cmd-${filtered[activeIdx].id}` : undefined}
                        className="flex-1 bg-transparent outline-none text-sm [color:var(--text-primary)]!"
                    />
                </div>
                <div id="bf-cmd-list" role="listbox" className="flex-1 overflow-y-auto custom-scrollbar py-1">
                    {filtered.length === 0 && (
                        <div className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">{emptyText}</div>
                    )}
                    {filtered.map((cmd: PaletteCommand, i: number) => {
                        const showGroup = cmd.group && cmd.group !== filtered[i - 1]?.group;
                        const Icon = cmd.icon;
                        const active = i === activeIdx;
                        return (
                            <React.Fragment key={cmd.id}>
                                {showGroup && (
                                    <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                                        {cmd.group}
                                    </div>
                                )}
                                <button
                                    id={`bf-cmd-${cmd.id}`}
                                    role="option"
                                    aria-selected={active}
                                    onMouseEnter={() => setActiveIdx(i)}
                                    onClick={() => run(cmd)}
                                    className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors"
                                    style={{ background: active ? 'var(--bg-tertiary)' : 'transparent', color: 'var(--text-primary)' }}
                                >
                                    {Icon && <Icon className="w-4 h-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />}
                                    <span className="flex-1 truncate">{cmd.label}</span>
                                    {cmd.hint && <span className="text-[10px] text-[var(--text-tertiary)]">{cmd.hint}</span>}
                                    {active && <CornerDownLeft className="w-3 h-3 shrink-0 text-[var(--text-tertiary)]" />}
                                </button>
                            </React.Fragment>
                        );
                    })}
                </div>
            </div>
        </Modal>
    );
}
