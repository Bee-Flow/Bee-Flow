import { Check, ChevronRight, Hammer, Layers, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import React from 'react';
import { appDetailPayload, describeAppToolCall, landedIcon } from './appToolCallDisplay';
import { StepBadge, TimelineRail } from '../../../../chat/MessageItem/timelineParts';

/**
 * What the AI did to the app, while it is doing it — the App Studio sibling
 * of automation/Builder/chat/BuilderActivity.jsx.
 *
 * Same furniture on purpose (StepBadge, TimelineRail, the entrance animation,
 * a `<details>` per call): the routine builder one tab over shows its build as
 * this timeline, and two lists with different bolletjes read as two kinds of
 * evidence for one stream. What differs is the tile: a component's own
 * palette icon (the same glyph the ribbon and the canvas cell carry) tinted
 * with the editor accent, instead of the routine's step-family colours.
 *
 * A batch (app_add_components) is one row with one compact line per landed
 * component — the same cards the canvas is revealing one at a time to the
 * right. A refusal shows its reason and hint without a click; the bounded
 * arguments/result sit behind the chevron.
 *
 * No durations, no invented denominators — the stream measures neither.
 */
export default function AppBuilderActivity({ toolCalls, running = false, t = null }) {
    const calls = Array.isArray(toolCalls) ? toolCalls : [];
    if (calls.length === 0) return null;
    const rows = calls.map((tc) => describeAppToolCall(tc, t));
    const failed = rows.filter((r) => r.status === 'failed').length;
    const activeIdx = running ? rows.length - 1 : -1;
    const tr = (key, en, params) => (t ? t(key, en, params) : en.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m)));

    return (
        <div
            className="mt-1.5 w-full max-w-3xl rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]/50 p-2.5 text-xs"
            data-testid="builder-activity"
        >
            <div className="mb-1.5 flex items-center gap-1.5 text-[var(--text-secondary)]">
                {running
                    ? <Loader2 size={13} className="flex-shrink-0 animate-spin motion-reduce:animate-none" style={{ color: 'var(--editor-accent, var(--accent))' }} />
                    : <Hammer size={13} className="flex-shrink-0" />}
                <span className="font-medium">
                    {running ? tr('app_studio.builder.act.building', 'Building') : tr('app_studio.builder.act.built', 'Built')}
                </span>
                <span className="text-[11px] text-[var(--text-secondary)]">{tr('app_studio.builder.act.calls', '{n} calls', { n: rows.length })}</span>
                {failed > 0 && (
                    <span className="ml-auto flex items-center gap-1 text-[11px]" style={{ color: 'var(--warning)' }} title={tr('app_studio.builder.act.refused_title', 'Calls the builder refused — each row says why')}>
                        <TriangleAlert size={11} />
                        {tr('app_studio.builder.act.refused_count', '{n} refused', { n: failed })}
                    </span>
                )}
            </div>
            <div className="relative flex flex-col gap-0.5">
                <TimelineRail show={rows.length > 1} />
                {rows.map((row, i) => (
                    <ActivityRow key={i} n={i + 1} row={row} tc={calls[i]} active={i === activeIdx} />
                ))}
            </div>
        </div>
    );
}

const TILE_BASE = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    background: 'color-mix(in srgb, var(--editor-accent, var(--accent)) 14%, transparent)',
    color: 'var(--editor-accent, var(--accent))',
};

function tileStyle(size, failed) {
    return {
        ...TILE_BASE,
        width: size, height: size, borderRadius: Math.round(size * 0.32),
        ...(failed ? { background: 'color-mix(in srgb, var(--warning) 14%, transparent)', color: 'var(--warning)' } : {}),
    };
}

function Glyph({ type, size, fallback }) {
    const Icon = landedIcon(type);
    if (Icon) return <Icon size={size} aria-hidden="true" />;
    return fallback;
}

function ActivityRow({ n, row, tc, active }) {
    const failed = row.status === 'failed';
    const batch = row.added.length > 1;
    const single = row.added.length === 1 ? row.added[0] : null;
    return (
        <details
            // `bf-step-in` fires on MOUNT only; rows are keyed by index and the
            // array only grows, so only the new row animates.
            className="group/act bf-step-in rounded-md transition-colors hover:bg-[var(--bg-tertiary)]/40"
            open={failed || undefined}
            data-testid="activity-row"
        >
            <summary className="flex cursor-pointer select-none list-none flex-col px-1 py-1 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2">
                    <StepBadge n={n} muted={failed} />
                    <span style={tileStyle(22, failed)} aria-hidden="true">
                        {batch
                            ? <Layers size={13} />
                            : <Glyph type={single ? single.type : null} size={13} fallback={<Sparkles size={13} />} />}
                    </span>
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="whitespace-nowrap font-medium text-[var(--text-primary)]">{row.title}</span>
                        {row.detail && !batch && (
                            <span className="min-w-0 truncate text-[var(--text-tertiary)]" title={row.detail}>{row.detail}</span>
                        )}
                    </span>
                    {active
                        ? <Loader2 size={12} className="flex-shrink-0 animate-spin motion-reduce:animate-none" style={{ color: 'var(--editor-accent, var(--accent))' }} />
                        : failed
                            ? <TriangleAlert size={12} className="flex-shrink-0" style={{ color: 'var(--warning)' }} />
                            : <Check size={12} className="flex-shrink-0 text-emerald-500" />}
                    <ChevronRight size={11} className="flex-shrink-0 opacity-40 transition-transform group-open/act:rotate-90" />
                </span>
                {batch && (
                    <span className="mt-0.5 flex flex-col pl-[2.35rem]" data-testid="activity-batch">
                        {row.added.map((a, i) => (
                            <span key={a.id ?? i} className="bf-step-in flex h-5 min-w-0 items-center gap-1.5 text-[var(--text-secondary)]" data-testid="activity-batch-step">
                                <span style={tileStyle(16, false)} aria-hidden="true"><Glyph type={a.type} size={10} fallback={null} /></span>
                                <span className="min-w-0 truncate">{a.title}</span>
                            </span>
                        ))}
                    </span>
                )}
            </summary>
            <div className="px-1 pb-1.5 pl-9">
                {row.error && (
                    <div className="mb-1.5 rounded-md px-2 py-1.5" style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', color: 'var(--text-primary)' }}>
                        <div>{row.error}</div>
                        {row.hint && <div className="mt-0.5 text-[var(--text-secondary)]">{row.hint}</div>}
                    </div>
                )}
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] p-2 text-[var(--text-primary)]">
                    {JSON.stringify(appDetailPayload(tc), null, 2)}
                </pre>
            </div>
        </details>
    );
}
