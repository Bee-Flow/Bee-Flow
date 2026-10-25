import { Layers, X, Plus, Sparkles, Loader2, Workflow, ArrowDownRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { listLayers, getLayerDependencies } from './flow/flowletScope';
import { useTranslation } from '../../../hooks/useTranslation';
import type { FlowletsPanelProps, Layer, LayerDeps, MainFlowRowProps } from './FlowletsPanel.types';
import { previewRows, stop, agentProgressText } from './FlowletsPanel.helpers';
import { DepLine, LayerRow, LayerAiComposer } from './LayerRow';

/**
 * Flowlets manager — a compact popover that opens UPWARD from the Flowlets
 * button in the bottom-left corner of the canvas. Lists the main flow + the
 * reusable sub-flows in definition.layers; click an entry to open (drill
 * into) it, rename a flowlet via the pencil, preview its steps, see its
 * dependencies (what it calls / who calls it) and jump between them, or
 * delete it.
 *
 * Flowlet CRUD is delegated to the parent (BuilderShell) so every edit flows
 * through the same whole-document commit / undo / autosave path as the rest
 * of the builder. This component owns only view state (which row is being
 * renamed, which previews are expanded) + closing on click-away / Esc.
 *
 * AI summaries are opt-in: the footer checkbox (off by default) gates the ✨
 * affordance entirely — when off, no Summarize button renders and no LLM
 * call is ever made. The deterministic step preview is always available.
 *
 * `onOpenLayer(null)` navigates to the main/root flow; a flowlet key drills in.
 */

const ROOT = 'root';

export default function FlowletsPanel({
    onClose,
    rootDef,
    currentScopeKey = null,
    onOpenLayer,
    onRenameLayer,
    onDeleteLayer,
    refCountFor,
    onCreateLayer,
    aiEnabled = false,
    onToggleAi,
    onSummarize,
    summarizingKey = null,
    rootDescription = '',
    onSummarizeRoot,
    summarizingRoot = false,
    // AI flowlet builder (separate from chat). onBuildLayer/onRefineLayer return
    // a Promise<boolean> (true = success). layerAgentState drives live progress.
    onBuildLayer,
    onRefineLayer,
    layerAgentState = null,
}: FlowletsPanelProps) {
    const { t } = useTranslation();
    const layers = useMemo(() => listLayers(rootDef), [rootDef]);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [buildOpen, setBuildOpen] = useState(false);

    const creating = !!layerAgentState?.running && layerAgentState?.mode === 'create';

    // Dependency graph + a key→title lookup (root included), computed once.
    const depsByKey = useMemo(() => {
        const m: Record<string, LayerDeps> = {};
        for (const l of layers) m[l.key] = getLayerDependencies(rootDef, l.key);
        return m;
    }, [rootDef, layers]);
    const titleByKey = useMemo(() => {
        const m: Record<string, string> = { [ROOT]: 'Main flow' };
        for (const l of layers) m[l.key] = l.title;
        return m;
    }, [layers]);
    // What the main flow itself calls = flowlets whose callers include 'root'.
    const rootCalls = useMemo(
        () => layers.filter((l: Layer) => depsByKey[l.key]?.callers.includes(ROOT)).map((l: Layer) => l.key),
        [layers, depsByKey],
    );

    // ROOT sentinel → null (the main flow); a flowlet key → that flowlet.
    const navTo = (key: string) => onOpenLayer?.(key === ROOT ? null : key);

    // Esc + click-away close (it's a floating popover, not a docked panel).
    // Clicks on the toggle button itself are ignored here so its own onClick
    // owns the open/close — otherwise the two fight and it never opens.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
        const onDown = (e: MouseEvent) => {
            if (popoverRef.current?.contains(e.target as Node)) return;
            if ((e.target as Element | null)?.closest?.('[data-layers-toggle]')) return;
            onClose?.();
        };
        window.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => {
            window.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDown);
        };
    }, [onClose]);

    return (
        <div
            ref={popoverRef}
            data-surface="default"
            className="absolute bottom-14 left-4 z-30 w-[380px] max-w-[calc(100vw-2rem)] max-h-[min(64vh,460px)] flex flex-col rounded-xl border border-[var(--border-default)] shadow-lg bg-[var(--bg-primary)] overflow-hidden"
        >
            {/* Header. The explanation of what a flowlet IS used to live only
                in the empty state, so it disappeared the moment you had one —
                exactly when you start needing it (BFSF-340). */}
            <div className="flex items-start justify-between px-3 py-2 border-b border-[var(--border-default)] flex-shrink-0">
                <div className="min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <Layers size={14} className="text-[var(--text-primary)] flex-shrink-0" />
                        <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{t('automations.flowlets_panel.flowlets', 'Flowlets')}</span>
                        <span className="text-[10px] text-[var(--text-tertiary)] flex-shrink-0">{layers.length}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-[var(--text-tertiary)] leading-snug">
                        {t('automations.flowlets_panel.reusable_sub_flows_build_one_once', 'Reusable sub-flows. Build one once, then call it from the main flow — or from another flowlet — with a “Call flowlet” step.')}
                    </div>
                </div>
                <div className="flex items-center gap-0.5">
                    <button
                        type="button"
                        onClick={() => onCreateLayer?.()}
                        title={t('automations.flowlets_panel.create_a_new_flowlet', 'Create a new flowlet')}
                        className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90"
                    >
                        <Plus size={12} /> {t('automations.flowlets_panel.create', 'Create')}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        title={t('automations.flowlets_panel.close', 'Close')}
                        aria-label={t('automations.flowlets_panel.close_flowlets_panel', 'Close flowlets panel')}
                        className="p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-1.5 flex flex-col gap-1">
                {/* Build a brand-new flowlet from a natural-language instruction
                    (a thinking-model sub-agent builds it, separate from chat). */}
                {onBuildLayer && (
                    <div className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/5 px-2 py-1.5">
                        {buildOpen || creating ? (
                            <>
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-[11px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1">
                                        <Sparkles size={12} className="text-[var(--accent)]" /> {t('automations.flowlets_panel.build_a_flowlet_with_ai', 'Build a flowlet with AI')}
                                    </span>
                                    {!creating && (
                                        <button type="button" onClick={() => setBuildOpen(false)} aria-label={t('automations.flowlets_panel.close', 'Close')} className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                                            <X size={12} />
                                        </button>
                                    )}
                                </div>
                                <LayerAiComposer
                                    onSubmit={async (text: string) => { const ok = await onBuildLayer(text); if (ok) setBuildOpen(false); }}
                                    running={creating}
                                    progress={creating ? agentProgressText(layerAgentState) : ''}
                                    placeholder={t('automations.flowlets_panel.describe_the_flowlet_e_g_look', 'Describe the flowlet — e.g. “Look up a contact by email and return their company and a 0–100 score.”')}
                                    autoFocus
                                />
                            </>
                        ) : (
                            <button type="button" onClick={() => setBuildOpen(true)} className="w-full inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--accent)] hover:underline">
                                <Sparkles size={12} /> {t('automations.flowlets_panel.build_a_flowlet_with_ai', 'Build a flowlet with AI')}
                            </button>
                        )}
                    </div>
                )}

                {/* Main flow (root) — always present so you can jump back here
                    when drilled into a flowlet. */}
                <MainFlowRow
                    isCurrent={currentScopeKey == null}
                    calls={rootCalls}
                    titleByKey={titleByKey}
                    onOpen={() => navTo(ROOT)}
                    onNavigate={navTo}
                    aiEnabled={aiEnabled}
                    description={rootDescription}
                    onSummarize={onSummarizeRoot}
                    summarizing={summarizingRoot}
                />

                {layers.length === 0 ? (
                    <div className="px-2 py-3 text-center">
                        <div className="text-[11px] text-[var(--text-tertiary)]">
                            {t('automations.flowlets_panel.no_flowlets_yet_reusable_sub_flows', 'No flowlets yet — reusable sub-flows you can call from anywhere.')}
                        </div>
                    </div>
                ) : (
                    layers.map((layer: Layer) => (
                        <LayerRow
                            key={layer.key}
                            layer={layer}
                            steps={previewRows(rootDef?.layers?.[layer.key])}
                            deps={depsByKey[layer.key] || { calls: [], callers: [] }}
                            titleByKey={titleByKey}
                            isCurrent={layer.key === currentScopeKey}
                            refCount={refCountFor?.(layer.key) || 0}
                            onOpen={() => onOpenLayer?.(layer.key)}
                            onNavigate={navTo}
                            onRename={(title: string) => onRenameLayer?.(layer.key, title)}
                            onDelete={() => onDeleteLayer?.(layer.key)}
                            aiEnabled={aiEnabled}
                            onSummarize={() => onSummarize?.(layer.key)}
                            summarizing={summarizingKey === layer.key}
                            onRefine={onRefineLayer ? (text: string) => onRefineLayer(layer.key, text) : null}
                            refining={!!layerAgentState?.running && layerAgentState?.mode === 'refine' && layerAgentState?.activeKey === layer.key}
                            refineProgress={agentProgressText(layerAgentState)}
                        />
                    ))
                )}
            </div>

            {/* Footer — AI opt-in toggle (off by default). */}
            <div className="px-3 py-2 border-t border-[var(--border-default)] flex-shrink-0">
                <label
                    className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none"
                    title={t('automations.flowlets_panel.when_on_you_can_generate_a', 'When on, you can generate a one-line AI summary of what each flowlet does. Off by default — no AI is used unless you turn this on.')}
                >
                    <input type="checkbox" checked={!!aiEnabled} onChange={() => onToggleAi?.()} />
                    <Sparkles size={12} className="text-[var(--text-tertiary)]" />
                    {t('automations.flowlets_panel.ai_flowlet_summaries', 'AI flowlet summaries')}
                </label>
            </div>
        </div>
    );
}

function MainFlowRow({
    isCurrent, calls, titleByKey, onOpen, onNavigate,
    aiEnabled, description, onSummarize, summarizing,
}: MainFlowRowProps) {
    const { t } = useTranslation();
    return (
        <div
            onClick={onOpen}
            title={t('automations.flowlets_panel.go_to_the_main_flow', 'Go to the main flow')}
            className={`rounded-lg border px-2 py-1.5 cursor-pointer transition-colors ${
                isCurrent
                    ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                    : 'border-[var(--border-default)] hover:bg-[var(--bg-secondary)]'
            }`}
        >
            <div className="flex items-center gap-1.5 min-w-0">
                <Workflow size={13} className="text-[var(--text-secondary)] flex-shrink-0" />
                <span className="flex-1 min-w-0 text-xs font-medium text-[var(--text-primary)] truncate">{t('automations.flowlets_panel.main_flow', 'Main flow')}</span>
                {isCurrent && (
                    <span className="text-[8px] uppercase tracking-wide font-semibold px-1 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] flex-shrink-0">
                        {t('automations.flowlets_panel.current', 'Current')}
                    </span>
                )}
            </div>
            <DepLine icon={ArrowDownRight} label={t('automations.flowlets_panel.calls', 'Calls')} targets={calls} titleByKey={titleByKey} onNavigate={onNavigate} />

            {/* AI summary of the whole automation — only when the opt-in toggle is on */}
            {aiEnabled && (
                <div className="mt-1 pl-5">
                    {description && (
                        <div className="text-[10px] text-[var(--text-secondary)] italic mb-0.5">{description}</div>
                    )}
                    <button
                        type="button"
                        onClick={stop(onSummarize)}
                        disabled={summarizing}
                        className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline disabled:opacity-60 disabled:no-underline"
                    >
                        {summarizing
                            ? <><Loader2 size={10} className="animate-spin" /> {t('automations.flowlets_panel.summarizing', 'Summarizing…')}</>
                            : <><Sparkles size={10} /> {description ? 'Regenerate' : 'Summarize'}</>}
                    </button>
                </div>
            )}
        </div>
    );
}

