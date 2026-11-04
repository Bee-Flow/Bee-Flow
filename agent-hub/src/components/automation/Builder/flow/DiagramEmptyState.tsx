import { Zap, Sparkles } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { typeTint } from './nodeTypeColors';
import { formatElapsed } from './runFocus';
import { TRIGGERS } from './stepPalette';
import useTranslation from '@/hooks/useTranslation';
import { exampleBriefs } from '../chat/exampleBriefs';

/**
 * The first screen of a new automation. It starts where a person starts:
 * "What should happen? Tell me in your own words", three example briefs that
 * SEND (owner, 2026-11-04: the assistant is the front door), and only then,
 * under "or start from how it begins", every trigger as a card.
 *
 * All SEVEN triggers, in a 3-column grid — the design draws six, but a trigger
 * left off the first screen is a trigger nobody finds (BFSF-325/367 made the
 * same rule for browse and search). A surface with no handler (a static
 * thumbnail, a read-only replay) renders the words and no buttons: a button
 * that does nothing is worse than none. Without an assistant (a Step, a
 * read-only automation) the screen keeps its old question, "What does this
 * automation start with?".
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
const SHORT: Record<string, string> = {
    manual: 'Manual', form: 'Form', schedule: 'Schedule', webhook: 'Webhook',
    app_event: 'App event', agent_call: 'Agent call', app_trigger: 'Studio App',
};

// `startedAt` is an epoch number (captured the instant the stream started);
// formatElapsed parses ISO strings, and Date.parse(number) is NaN.
function elapsedSince(startedAt: number | null | undefined, now: number) {
    return startedAt ? formatElapsed(new Date(startedAt).toISOString(), now) : null;
}

/**
 * "Building · 0:04 · <caption>" — mounted only while the assistant builds, so
 * its clock lives and dies with it; an empty canvas at rest schedules nothing.
 */
function BuildingLine({ caption, startedAt }: { caption?: string | null; startedAt?: number | null }) {
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
                <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping motion-reduce:animate-none bg-[var(--accent)]" />
                <span className="relative inline-flex h-2 w-2 rounded-full [background:var(--accent)] [box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_30%,transparent)]" />
            </span>
            <span className="min-w-0 truncate">
                <b className="text-[var(--text-primary)]">{t('automations.canvas.build_live', 'Building')}</b>
                {elapsed && <span className="text-[var(--text-tertiary)] tabular-nums" data-testid="empty-building-elapsed"> · {elapsed}</span>}
                <span> · </span>
                <span data-testid="empty-building-caption">{caption || t('automations.canvas.build_trigger_next', 'Choosing a trigger…')}</span>
            </span>
        </div>
    );
}

interface DiagramEmptyStateProps {
    onRequestOpenPalette?: (() => void) | null;
    onAddTrigger?: ((payload: (typeof TRIGGERS)[number]['payload']) => void) | null;
    onOpenAssistant?: (() => void) | null;
    /** Sends a brief to the assistant (and opens it). Absent = the examples cannot be offered. */
    onSendBrief?: ((text: string) => void) | null;
    building?: boolean;
    caption?: string | null;
    startedAt?: number | null;
}

type TriggerPick = ((payload: (typeof TRIGGERS)[number]['payload']) => void) | null;

/** Every trigger as a card; dimmed and inert while the assistant is choosing. */
function TriggerGrid({ pick, building }: { pick: NonNullable<TriggerPick>; building: boolean }) {
    return (
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
                            <Icon size={14} className="text-[var(--type-trigger)]" />
                            {SHORT[tr.id] || tr.label}
                        </div>
                        <div className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{tr.desc}</div>
                    </button>
                );
            })}
        </div>
    );
}

/** "What should happen?": three example briefs that send, and the way to write your own. */
function AskFirst({ onSendBrief, onOpenAssistant, building }: { onSendBrief: ((text: string) => void) | null; onOpenAssistant: (() => void) | null; building: boolean }) {
    const { t } = useTranslation();
    return (
        <>
            <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 grid place-items-center shrink-0 rounded-2xl text-[var(--type-ai)] bg-[color-mix(in_srgb,var(--type-ai)_12%,transparent)]" aria-hidden="true">
                    <Sparkles size={22} />
                </div>
                <div className="min-w-0">
                    <div className="text-[18px] font-semibold leading-6">{t('automations.canvas.empty_ask', 'What should happen? Tell me in your own words.')}</div>
                    <div className="text-[13px] text-[var(--text-secondary)]">
                        {t('automations.canvas.empty_ask_sub', 'The assistant builds it with you and asks when something is unclear.')}
                    </div>
                </div>
            </div>
            {onSendBrief && (
                <div className="flex flex-col gap-2" data-testid="empty-briefs">
                    {exampleBriefs(t).map((text) => (
                        <button
                            key={text}
                            type="button"
                            data-testid="empty-brief"
                            disabled={building}
                            onClick={() => onSendBrief(text)}
                            className="flex items-center gap-2.5 text-left px-3.5 py-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--type-ai)] transition disabled:opacity-60"
                        >
                            <Sparkles size={14} className="shrink-0 text-[var(--type-ai)]" />
                            <span className="min-w-0">{text}</span>
                        </button>
                    ))}
                </div>
            )}
            {onOpenAssistant && (
                <button
                    type="button"
                    onClick={onOpenAssistant}
                    className="self-start px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[var(--text-primary)] text-[var(--bg-primary)]"
                >
                    {t('automations.canvas.empty_open_assistant', 'Describe it to the assistant')}
                </button>
            )}
        </>
    );
}

/** The trigger cards: second, under "or start from how it begins", when the assistant leads. */
function TriggerSection({ pick, building, labelled }: { pick: TriggerPick; building: boolean; labelled: boolean }) {
    const { t } = useTranslation();
    if (!pick) return <div className="text-[13px] text-[var(--text-tertiary)]">{t('automations.canvas.empty_static', 'Start with a trigger.')}</div>;
    return (
        <>
            {labelled && <div className="mt-2 text-[12px] font-medium text-[var(--text-tertiary)]">{t('automations.canvas.empty_or_start', 'or start from how it begins')}</div>}
            <TriggerGrid pick={pick} building={building} />
            <div className="text-xs text-[var(--text-tertiary)]">
                {t('automations.canvas.empty_hint', '…or pick one from the bar above, or drag it onto the canvas.')}
            </div>
        </>
    );
}

/** Without an assistant: the old question, how the automation starts. */
function StartHeader({ withSub }: { withSub: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-3.5">
            <div
                className="w-12 h-12 grid place-items-center shrink-0 rounded-l-3xl rounded-r-xl text-[var(--type-trigger)]"
                style={{ background: typeTint('trigger') }}
                aria-hidden="true"
            >
                <Zap size={22} />
            </div>
            <div className="min-w-0">
                <div className="text-[18px] font-semibold leading-6">{t('automations.canvas.empty_title', 'What does this automation start with?')}</div>
                {withSub && (
                    <div className="text-[13px] text-[var(--text-secondary)]">
                        {t('automations.canvas.empty_sub_plain', 'Every automation has exactly one way to start. Pick one.')}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function DiagramEmptyState({
    onRequestOpenPalette = null, onAddTrigger = null, onOpenAssistant = null, onSendBrief = null,
    building = false, caption = null, startedAt = null,
}: DiagramEmptyStateProps) {
    const pick: TriggerPick = onAddTrigger || (onRequestOpenPalette ? () => onRequestOpenPalette() : null);
    const askFirst = !!(onSendBrief || onOpenAssistant);
    return (
        <div className="w-full h-full flex items-center justify-center px-6 py-10 text-[var(--text-primary)]">
            <div className="w-[640px] max-w-full -mt-[6vh] flex flex-col gap-4">
                {askFirst ? (
                    <AskFirst onSendBrief={onSendBrief} onOpenAssistant={onOpenAssistant} building={building} />
                ) : (
                    <StartHeader withSub={!!pick} />
                )}
                {building && <BuildingLine caption={caption} startedAt={startedAt} />}
                <TriggerSection pick={pick} building={building} labelled={askFirst} />
            </div>
        </div>
    );
}
