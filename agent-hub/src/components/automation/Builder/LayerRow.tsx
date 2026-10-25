import { Trash2, Sparkles, Loader2, ChevronRight, ChevronDown, Pencil, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import type { DepLineProps, LayerAiComposerProps, LayerRowProps, PreviewRow } from './FlowletsPanel.types';
import { stop } from './FlowletsPanel.helpers';

// The two directions read as jargon on their own — say which way each points.
const DEP_HINT: Record<string, string> = {
    'Used by': 'The flows that call this flowlet. Listed once per flow, however many times it calls in.',
    Calls: 'The other flowlets this one calls.',
};

/** A line of clickable dependency targets ("Used by" / "Calls"). */
export function DepLine({ icon: Icon, label, targets, titleByKey, onNavigate }: DepLineProps) {
    if (!targets || targets.length === 0) return null;
    return (
        <div className="mt-0.5 pl-5 flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] min-w-0">
            <Icon size={10} className="flex-shrink-0" />
            <span className="flex-shrink-0 cursor-help" title={DEP_HINT[label]}>{label}</span>
            <div className="flex flex-wrap gap-1 min-w-0">
                {targets.map((k: string) => (
                    <button
                        key={k}
                        type="button"
                        onClick={stop(() => onNavigate?.(k))}
                        title={`Go to ${titleByKey[k] || k}`}
                        className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition max-w-[120px] truncate"
                    >
                        {titleByKey[k] || k}
                    </button>
                ))}
            </div>
        </div>
    );
}

export function LayerRow({
    layer, steps, deps, titleByKey, isCurrent, refCount,
    onOpen, onNavigate, onRename, onDelete,
    aiEnabled, onSummarize, summarizing,
    onRefine = null, refining = false, refineProgress = '',
}: LayerRowProps) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(layer.title);
    const [expanded, setExpanded] = useState(false);
    const [refineOpen, setRefineOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    // Keep the composer mounted while its run is in flight so progress shows.
    const showRefine = refineOpen || refining;

    useEffect(() => { if (!editing) setDraft(layer.title); }, [layer.title, editing]);
    useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

    const commit = () => {
        const next = (draft || '').trim();
        setEditing(false);
        if (!next || next === layer.title) { setDraft(layer.title); return; }
        onRename?.(next);
    };
    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.stopPropagation(); setDraft(layer.title); setEditing(false); }
    };

    // An EMPTY flowlet stays deletable even when something calls it: the
    // palette's "Create flowlet" drops a call node as part of creating one, so
    // a brand-new flowlet was born un-deletable and the user had to hunt down
    // that node first (BFSF-340). Deleting it takes the call sites with it.
    const inUse = refCount > 0 && layer.stepCount > 0;
    const deleteTitle = inUse
        ? `Used by ${refCount} step${refCount === 1 ? '' : 's'} — open it and remove those first`
        : (refCount > 0
            ? `Delete this empty flowlet (and the ${refCount} “Call flowlet” step${refCount === 1 ? '' : 's'} that use${refCount === 1 ? 's' : ''} it)`
            : 'Delete this flowlet');
    const metaParts = [
        `${layer.stepCount} step${layer.stepCount === 1 ? '' : 's'}`,
        `${layer.params.length} in`,
        `${layer.outputFields.length} out`,
    ];

    return (
        <div
            onClick={editing ? undefined : onOpen}
            title={editing ? undefined : 'Open this flowlet'}
            className={`rounded-lg border px-2 py-1.5 transition-colors ${editing ? '' : 'cursor-pointer'} ${
                isCurrent
                    ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                    : 'border-[var(--border-default)] hover:bg-[var(--bg-secondary)]'
            }`}
        >
            {/* Title row */}
            <div className="flex items-center gap-1 min-w-0">
                <button
                    type="button"
                    onClick={stop(() => setExpanded((v: boolean) => !v))}
                    title={expanded ? 'Hide steps' : 'Show steps'}
                    aria-label={expanded ? 'Hide steps' : 'Show steps'}
                    className="p-0.5 -ml-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] flex-shrink-0"
                >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                {editing ? (
                    <input
                        ref={inputRef}
                        value={draft}
                        onClick={stop()}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={onKey}
                        className="flex-1 min-w-0 text-xs font-medium bg-transparent border-b border-[var(--accent)] outline-none text-[var(--text-primary)]"
                    />
                ) : (
                    <span className="flex-1 min-w-0 text-xs font-medium text-[var(--text-primary)] truncate">
                        {layer.title}
                    </span>
                )}
                {isCurrent && (
                    <span className="text-[8px] uppercase tracking-wide font-semibold px-1 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] flex-shrink-0">
                        {t('automations.flowlets_panel.current', 'Current')}
                    </span>
                )}
                {!editing && onRefine && (
                    <button
                        type="button"
                        onClick={stop(() => setRefineOpen((v: boolean) => !v))}
                        title={t('automations.flowlets_panel.refine_this_flowlet_with_ai', 'Refine this flowlet with AI')}
                        aria-label={t('automations.flowlets_panel.refine_with_ai', 'Refine with AI')}
                        className={`p-0.5 rounded transition flex-shrink-0 hover:bg-[var(--bg-tertiary)] ${showRefine ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)] hover:text-[var(--accent)]'}`}
                    >
                        <Sparkles size={11} />
                    </button>
                )}
                {!editing && (
                    <button
                        type="button"
                        onClick={stop(() => setEditing(true))}
                        title={t('automations.flowlets_panel.rename', 'Rename')}
                        aria-label={t('automations.flowlets_panel.rename_flowlet', 'Rename flowlet')}
                        className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition flex-shrink-0"
                    >
                        <Pencil size={11} />
                    </button>
                )}
                <button
                    type="button"
                    onClick={inUse ? stop() : stop(onDelete)}
                    disabled={inUse}
                    title={deleteTitle}
                    aria-label={t('automations.flowlets_panel.delete_flowlet', 'Delete flowlet')}
                    className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-red-600 hover:bg-[var(--bg-tertiary)] transition disabled:opacity-40 disabled:hover:text-[var(--text-tertiary)] disabled:hover:bg-transparent flex-shrink-0"
                >
                    <Trash2 size={11} />
                </button>
            </div>

            {/* At-a-glance meta */}
            <div className="mt-0.5 pl-5 text-[10px] text-[var(--text-tertiary)]">
                {metaParts.join(' · ')}
            </div>

            {/* Dependencies — who calls this flowlet, and what it calls. Click a
                target to jump there. */}
            <DepLine icon={ArrowUpRight} label={t('automations.flowlets_panel.used_by', 'Used by')} targets={deps.callers} titleByKey={titleByKey} onNavigate={onNavigate} />
            <DepLine icon={ArrowDownRight} label={t('automations.flowlets_panel.calls', 'Calls')} targets={deps.calls} titleByKey={titleByKey} onNavigate={onNavigate} />

            {/* Deterministic step preview (always available, no AI) */}
            {expanded && (
                <div className="mt-1 ml-5 flex flex-col gap-0.5 border-l border-[var(--border-default)]">
                    {steps.length === 0 ? (
                        <div className="text-[10px] italic text-[var(--text-tertiary)] pl-2">{t('automations.flowlets_panel.empty_flowlet_no_steps_yet', 'Empty flowlet — no steps yet.')}</div>
                    ) : (
                        steps.map((s: PreviewRow, i: number) => (
                            <div key={s.id || i} className="flex items-center gap-1.5 text-[10px] pl-2 min-w-0">
                                <span className="uppercase tracking-wide text-[var(--text-tertiary)] flex-shrink-0 w-14 truncate">{s.type}</span>
                                {s.layerKey ? (
                                    <button
                                        type="button"
                                        onClick={stop(() => onNavigate?.(s.layerKey as string))}
                                        title={`Go to ${titleByKey[s.layerKey] || s.layerKey}`}
                                        className="text-[var(--accent)] hover:underline truncate text-left"
                                    >
                                        {titleByKey[s.layerKey] || s.label}
                                    </button>
                                ) : (
                                    <span className="text-[var(--text-secondary)] truncate">{s.label}</span>
                                )}
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* AI summary — only when the opt-in toggle is on */}
            {aiEnabled && (
                <div className="mt-1 pl-5">
                    {layer.description && (
                        <div className="text-[10px] text-[var(--text-secondary)] italic mb-0.5">{layer.description}</div>
                    )}
                    <button
                        type="button"
                        onClick={stop(onSummarize)}
                        disabled={summarizing}
                        className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline disabled:opacity-60 disabled:no-underline"
                    >
                        {summarizing
                            ? <><Loader2 size={10} className="animate-spin" /> {t('automations.flowlets_panel.summarizing', 'Summarizing…')}</>
                            : <><Sparkles size={10} /> {layer.description ? 'Regenerate' : 'Summarize'}</>}
                    </button>
                </div>
            )}

            {/* Refine-with-AI composer — extend/fix this flowlet from an instruction */}
            {showRefine && onRefine && (
                <div className="mt-1.5 pl-5" onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
                    <LayerAiComposer
                        compact
                        autoFocus
                        running={refining}
                        progress={refining ? refineProgress : ''}
                        placeholder={`Refine “${layer.title}” — e.g. “also return the company size” or “handle a missing email.”`}
                        submitLabel="Refine"
                        onSubmit={async (text: string) => { const ok = await onRefine(text); if (ok) setRefineOpen(false); }}
                    />
                </div>
            )}
        </div>
    );
}

/**
 * A small instruction box (textarea + submit) for the AI flowlet builder.
 * Used for both "build new" (top of the panel) and per-row "refine".
 * onSubmit(text) may return a Promise; the parent decides whether to close.
 */
export function LayerAiComposer({ onSubmit, running = false, progress = '', placeholder = '', submitLabel = 'Build', autoFocus = false, compact = false }: LayerAiComposerProps) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const submit = () => {
        const t = text.trim();
        if (!t || running) return;
        onSubmit?.(t);
    };
    return (
        <div className="flex flex-col gap-1">
            <textarea
                value={text}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
                    else if (e.key === 'Escape') { e.stopPropagation(); }
                }}
                placeholder={placeholder}
                rows={compact ? 2 : 3}
                disabled={running}
                autoFocus={autoFocus}
                className="w-full text-[11px] rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 outline-none focus:border-[var(--accent)] resize-none disabled:opacity-60 text-[var(--text-primary)]"
            />
            <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] text-[var(--text-tertiary)] truncate min-w-0">{progress}</div>
                <button
                    type="button"
                    onClick={submit}
                    disabled={running || !text.trim()}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 flex-shrink-0"
                >
                    {running
                        ? <><Loader2 size={11} className="animate-spin" /> {t('automations.flowlets_panel.building', 'Building…')}</>
                        : <><Sparkles size={11} /> {submitLabel}</>}
                </button>
            </div>
        </div>
    );
}
