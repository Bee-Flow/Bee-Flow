import { Zap, Sparkles } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { typeColorVar, typeTint } from './nodeTypeColors';
import { formatElapsed } from './runFocus';
import { TRIGGERS } from './stepPalette';
import useTranslation from '../../../../hooks/useTranslation';

/**
 * The first screen of a new routine (design 1e): "What does this routine start
 * with?", every trigger as a card, and a way to hand the whole thing to the
 * assistant instead.
 *
 * All SEVEN triggers, in a 3-column grid — the design draws six, but a trigger
 * left off the first screen is a trigger nobody finds (BFSF-325/367 made the
 * same rule for browse and search). A surface with no handler (a static
 * thumbnail, a read-only replay) renders the words and no buttons: a button
 * that does nothing is worse than none.
 *
 * Sits slightly ABOVE centre: an optically centred block reads as centred, a
 * mathematically centred one reads as low.
 *
 * `building` is the assistant's turn before any trigger exists. React Flow is
 * not mounted yet, so this screen is the only place the 10–20 s of prompt
 * processing before the first token can be seen at all — the worst dead air
 * of a demo. The trigger cards dim (the AI is choosing, not the person) and
 * one quiet line carries the clock and `caption`, the narrated summary of
 * what the model is thinking right now.
 */
const SHORT = {
    manual: 'Manual', form: 'Form', schedule: 'Schedule', webhook: 'Webhook',
    app_event: 'App event', agent_call: 'Agent call', app_trigger: 'Studio App',
};

// `startedAt` is an epoch number (captured the instant the stream started);
// formatElapsed parses ISO strings, and Date.parse(number) is NaN.
function elapsedSince(startedAt, now) {
    return startedAt ? formatElapsed(new Date(startedAt).toISOString(), now) : null;
}

/**
 * "Building · 0:04 · <caption>" — mounted only while the assistant builds, so
 * its clock lives and dies with it; an empty canvas at rest schedules nothing.
 */
function BuildingLine({ caption, startedAt }) {
    const { t } = useTranslation();
    const ticking = !!startedAt;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!ticking) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [ticking]);
    const elapsed = elapsedSince(startedAt, now);
    return (
        <div
            className="flex items-center gap-2.5 text-[12px] text-[var(--text-secondary)]"
            data-testid="empty-building-line"
            role="status"
        >
            {/* The south banner's pulsing dot: `--accent` marks the live thing
                on the canvas, and before the first card exists the build is it. */}
            <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping motion-reduce:animate-none" style={{ background: 'var(--accent)' }} />
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: 'var(--accent)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent)' }} />
            </span>
            <span className="min-w-0 truncate">
                <b className="text-[var(--text-primary)]">{t('routines.canvas.build_live', 'Building')}</b>
                {elapsed && <span className="text-[var(--text-tertiary)] tabular-nums" data-testid="empty-building-elapsed"> · {elapsed}</span>}
                <span> · </span>
                <span data-testid="empty-building-caption">{caption || t('routines.canvas.build_trigger_next', 'Choosing a trigger…')}</span>
            </span>
        </div>
    );
}

export default function DiagramEmptyState({
    onRequestOpenPalette = null, onAddTrigger = null, onOpenAssistant = null,
    building = false, caption = null, startedAt = null,
}) {
    const { t } = useTranslation();
    const pick = onAddTrigger || (onRequestOpenPalette ? () => onRequestOpenPalette() : null);
    return (
        <div className="w-full h-full flex items-center justify-center px-6 py-10 text-[var(--text-primary)]">
            <div className="w-[640px] max-w-full -mt-[6vh] flex flex-col gap-4">
                <div className="flex items-center gap-3.5">
                    <div
                        className="w-12 h-12 grid place-items-center shrink-0"
                        style={{ borderRadius: '24px 12px 12px 24px', background: typeTint('trigger'), color: typeColorVar('trigger') }}
                        aria-hidden="true"
                    >
                        <Zap size={22} />
                    </div>
                    <div className="min-w-0">
                        <div className="text-[18px] font-semibold leading-6">{t('routines.canvas.empty_title', 'What does this routine start with?')}</div>
                        <div className="text-[13px] text-[var(--text-secondary)]">
                            {t('routines.canvas.empty_sub', 'Every routine has exactly one trigger. Pick one, or let the assistant write the routine.')}
                        </div>
                    </div>
                </div>
                {building && <BuildingLine caption={caption} startedAt={startedAt} />}
                {pick ? (
                    <div
                        className="grid grid-cols-3 gap-2.5"
                        data-testid="empty-trigger-grid"
                        // Dimmed and inert while the assistant is choosing: the
                        // cards stay on screen so the room can see what it is
                        // choosing FROM, but a click here mid-build would race
                        // the model's own trigger.
                        style={building ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
                        aria-disabled={building || undefined}
                    >
                        {TRIGGERS.map((tr) => {
                            const Icon = tr.icon;
                            return (
                                <button
                                    key={tr.id}
                                    type="button"
                                    onClick={() => pick(tr.payload)}
                                    className="text-left p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-sm hover:bg-[var(--bg-tertiary)] transition"
                                >
                                    <div className="flex items-center gap-2 text-[13px] font-semibold">
                                        <Icon size={14} style={{ color: typeColorVar('trigger') }} />
                                        {SHORT[tr.id] || tr.label}
                                    </div>
                                    <div className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{tr.desc}</div>
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="text-[13px] text-[var(--text-tertiary)]">{t('routines.canvas.empty_static', 'Start with a trigger.')}</div>
                )}
                {onOpenAssistant && (
                    <div className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl border border-dashed border-[var(--border-default)] text-[13px] text-[var(--text-secondary)]">
                        <Sparkles size={14} style={{ color: typeColorVar('ai') }} className="shrink-0" />
                        <span className="min-w-0 truncate">
                            {t('routines.canvas.empty_describe', 'Or describe the routine:')}{' '}
                            <i>{t('routines.canvas.empty_example', '“annual report via a form → analysis per bank → memorandum”')}</i>
                        </span>
                        <button
                            type="button"
                            onClick={onOpenAssistant}
                            className="ml-auto shrink-0 px-2.5 py-[5px] rounded-lg text-[12px] font-semibold"
                            style={{ background: 'var(--text-primary)', color: 'var(--bg-primary)' }}
                        >
                            {t('routines.canvas.empty_assistant', 'Assistant')}
                        </button>
                    </div>
                )}
                {pick && (
                    <div className="text-xs text-[var(--text-tertiary)]">
                        {t('routines.canvas.empty_hint', '…or pick one from the bar above, or drag it onto the canvas.')}
                    </div>
                )}
            </div>
        </div>
    );
}
