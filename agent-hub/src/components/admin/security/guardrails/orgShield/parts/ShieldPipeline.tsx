import { Bot, ChevronRight } from 'lucide-react';
import React, { useCallback, useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { StripItem } from '../orgShieldStrip';
import { SHIELD_ROW } from '../shieldLayout';

/**
 * The Privacy Shield's navigation: a path, not a tab bar.
 *
 *   [Overview]  PATH 1 What we look for › 2 Your own data › 3 When we find something › 4 Leaving your org ┊ AI model  [What happened]
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * Four equal tabs said nothing about order, and the commonest misreading of
 * this screen was treating step 3 (the always-on gate) and step 4 (the
 * interactive pre-flight, external models only) as alternatives — an admin
 * would set the first to stop and then wonder why nobody ever got the last
 * check. They are consecutive stages of one path. Numbering them, and ending
 * the path at the AI model, makes the order readable without a paragraph.
 *
 * `Overview` (a summary) and `What happened` (a log) are not stages, so they
 * sit outside the path.
 *
 * ── Accessibility ─────────────────────────────────────────────────────────
 * Visually a path; semantically the tablist it replaced. The destinations
 * are `role="tab"` with arrow-key navigation per the ARIA Authoring
 * Practices. The PATH label, the step numbers, the chevrons and the AI-model
 * end are decoration and hidden from assistive tech, so a tab's name is its
 * label followed by its read-out.
 *
 * Each item carries a `summary`: the value it currently holds, so the strip
 * doubles as a read-out. A summary may be toned `warn` to say "this step is
 * where your problem is".
 *
 * `emphasis` is a SECOND id to mark, outlined rather than filled: the two
 * checks share one pane, so the strip has to be able to say "you are on the
 * pane that owns both of these" without claiming two active tabs.
 */

interface TabProps {
    item: StripItem;
    selected: boolean;
    marked: boolean;
    baseId: string;
    panelId: string;
    onChange: (id: string) => void;
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
    buttonRef: (el: HTMLButtonElement | null) => void;
}

function tabClass(item: StripItem, selected: boolean, marked: boolean): string {
    // No `min-w-0`: a step never gets narrower than its label, which must
    // never be cut. Only the read-out under it gives way (see summaryClass).
    const base = 'flex flex-col justify-center gap-0.5 py-1.5 px-3 rounded-[9px] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
    // Standalone pills share the first row between them once the path
    // has moved to a row of its own (see the narrow layout below).
    const shape = item.inPipeline ? 'flex-1' : 'shrink-0 border @max-[939px]/strip:flex-1';
    let look: string;
    if (selected) look = 'bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)] border-transparent';
    else if (item.inPipeline) look = 'bg-transparent text-[var(--text-primary)]';
    else look = 'bg-[var(--bg-card)] text-[var(--text-primary)] border-[var(--border-default)]';
    // The sibling check step: an inset ring, so marking it never shifts the row.
    const mark = marked && !selected ? 'ring-[1.5px] ring-inset ring-[var(--text-primary)]' : '';
    const hover = selected || marked ? '' : 'enabled:hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]';
    return [base, shape, look, mark, hover].filter(Boolean).join(' ');
}

function summaryClass(item: StripItem, selected: boolean): string {
    // On a step the read-out takes the width the label left it (`w-0
    // min-w-full` keeps it out of the step's minimum width) and ellipsises;
    // a standalone pill is sized to fit both lines.
    const indent = item.inPipeline ? 'pl-[22px] w-0 min-w-full' : 'pl-[19px]';
    let tone = 'text-[var(--text-tertiary)]';
    if (selected) tone = 'text-[color-mix(in_srgb,rgb(from_var(--bg-card)_r_g_b_/_1)_72%,var(--text-primary))]';
    else if (item.summaryTone === 'warn') tone = 'text-[var(--warning-ink)]';
    return `text-[11px] leading-[14px] truncate ${indent} ${tone}`;
}

/**
 * One destination on the strip.
 *
 * Hoisted OUT of ShieldPipeline deliberately. Declared inside it, this is a
 * brand-new component type on every render, so React unmounts and remounts
 * every button whenever anything changes — which silently breaks the
 * arrow-key navigation below: `onChange` re-renders, the focused button is
 * replaced by a fresh node, and focus falls back to the body mid-traversal.
 */
function Tab({
    item, selected, marked, baseId, panelId, onChange, onKeyDown, buttonRef,
}: TabProps) {
    return (
        <button
            ref={buttonRef}
            id={`${baseId}-tab-${item.id}`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            onKeyDown={onKeyDown}
            className={tabClass(item, selected, marked)}
        >
            <span className="flex items-center gap-1.5 text-xs font-semibold leading-[15px] whitespace-nowrap">
                {item.step ? (
                    <span
                        aria-hidden="true"
                        className={'w-4 h-4 rounded-full grid place-items-center shrink-0 text-[10px] font-bold '
                            + (selected ? 'bg-[var(--bg-card)] text-[var(--text-primary)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]')}
                    >
                        {item.step}
                    </span>
                ) : (
                    <item.Icon className="w-[13px] h-[13px] shrink-0" aria-hidden="true" />
                )}
                {item.label}
            </span>
            {item.summary && (
                <span className={summaryClass(item, selected)} title={item.summary}>{item.summary}</span>
            )}
        </button>
    );
}

/** The vertical PATH label that opens the group — a caption, not a destination. */
function PathLabel({ text }: { text: string }) {
    return (
        <span
            aria-hidden="true"
            className="hidden @min-[700px]/strip:block shrink-0 px-[3px] text-center [writing-mode:vertical-rl] rotate-180 text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--text-tertiary)]"
        >
            {text}
        </span>
    );
}

/**
 * Where the path ends. Pictured, not a place you can go — so it is the first
 * thing to go when the strip is too narrow for all six labels, measured on
 * the strip's own width (the settings page has a nav beside it).
 */
function EndMarker({ text }: { text: string }) {
    return (
        <span
            aria-hidden="true"
            className="hidden @min-[1030px]/strip:flex items-center gap-1.5 shrink-0 px-3 ml-1 whitespace-nowrap border-l border-dashed border-[var(--border-default)] text-[11px] font-semibold text-[var(--text-tertiary)]"
        >
            <Bot className="w-[13px] h-[13px]" aria-hidden="true" />
            {text}
        </span>
    );
}

function Chevron() {
    return (
        <span aria-hidden="true" className="grid place-items-center shrink-0 text-[var(--text-tertiary)]">
            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
    );
}

const NEXT_INDEX: Record<string, (pos: number, n: number) => number> = {
    ArrowLeft: (pos, n) => (pos - 1 + n) % n,
    ArrowRight: (pos, n) => (pos + 1) % n,
    Home: () => 0,
    End: (_pos, n) => n - 1,
};

export function ShieldPipeline({
    items, value, emphasis = null, onChange, ariaLabel, t,
}: {
    items: StripItem[];
    value: string;
    emphasis?: string | null;
    onChange: (id: string) => void;
    ariaLabel: string;
    t: TranslateFn;
}) {
    const baseId = useId();
    const refs = useRef<Record<string, HTMLButtonElement | null>>({});

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
        const move = NEXT_INDEX[e.key];
        const enabled = items.filter(it => !it.disabled);
        if (!move || enabled.length === 0) return;
        e.preventDefault();
        const pos = enabled.findIndex(it => it.id === value);
        const target = enabled[move(pos, enabled.length)];
        onChange(target.id);
        refs.current[target.id]?.focus();
    }, [items, value, onChange]);

    // One factory, so the call sites below cannot drift into passing
    // different prop sets to the same button.
    const tab = (item: StripItem) => (
        <Tab
            key={item.id}
            item={item}
            selected={item.id === value}
            marked={item.id === emphasis}
            baseId={baseId}
            panelId="org-shield-panel"
            onChange={onChange}
            onKeyDown={handleKeyDown}
            buttonRef={(el) => { refs.current[item.id] = el; }}
        />
    );
    const stages = items.filter(it => it.inPipeline);

    return (
        // The container the strip measures itself against: the settings nav
        // sits beside it, so the viewport says little about its room.
        <div className={`@container/strip px-6 pb-2.5 [@media(max-height:780px)]:pb-2 ${SHIELD_ROW}`}>
        <div
            role="tablist"
            aria-label={ariaLabel}
            aria-orientation="horizontal"
            // Labels never truncate. Below the width they need, the AI-model
            // end goes first; below 940px the path moves to a row of its own
            // under the two pills, so nothing ever sits off-screen on a
            // laptop. Only on a phone-sized strip does the path row scroll
            // sideways, inside itself. The 4px on top keeps a focus ring from
            // being clipped by that scroller.
            className="flex items-stretch gap-2 pt-1 -mt-1 overflow-x-auto @max-[939px]/strip:flex-wrap"
        >
            {items.filter(it => it.id === 'overview').map(tab)}

            <div className="flex-1 flex items-stretch gap-0.5 p-[3px] rounded-[11px] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] @max-[939px]/strip:order-last @max-[939px]/strip:basis-full">
                <PathLabel text={t('shield_shell.path_label', 'Path')} />
                {stages.map((item, i) => (
                    <React.Fragment key={item.id}>
                        {i > 0 && <Chevron />}
                        {tab(item)}
                    </React.Fragment>
                ))}
                <EndMarker text={t('admin.shield_pipeline_out', 'AI model')} />
            </div>

            {items.filter(it => !it.inPipeline && it.id !== 'overview').map(tab)}
        </div>
        </div>
    );
}

export default ShieldPipeline;
