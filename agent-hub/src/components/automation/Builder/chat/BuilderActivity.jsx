import { Check, ChevronRight, FlaskConical, Hammer, Layers, Loader2, TriangleAlert, Wrench } from 'lucide-react';
import React from 'react';
import { describeLiveRun, describeToolCall, detailPayload } from './toolCallDisplay';
import { StepBadge, TimelineRail } from '../../../chat/MessageItem/timelineParts';
import { typeColorVar, typeTileStyle } from '../flow/nodeTypeColors';
import { StepIcon } from '../flow/stepIcons';

/**
 * What the AI did, while it is doing it.
 *
 * This replaces a flat column of `ToolCallChip`s that each showed nothing but
 * the raw function name — eight rows, three of them the identical string
 * `builder_add_array_op` standing for three different things. Everything
 * needed to say what actually happened was already on the props and was being
 * discarded (see toolCallDisplay.js).
 *
 * The row furniture is `timelineParts` on purpose, not a local copy. Its own
 * docblock is the reason: two lists sitting side by side in the builder that
 * "net níet dezelfde bolletjes en pillen hebben, lezen als twee verschillende
 * soorten bewijs terwijl het één stroom is". The tile, colour and icon come
 * from the same nodeDefs/nodeTypeColors the canvas one column to the right
 * uses, so the two tell one story instead of two.
 *
 * TWO THINGS DELIBERATELY ABSENT.
 *
 * No durations. The stream carries no per-tool timing, and a number derived
 * from event arrival times would measure the gap between events, not the work.
 * `DurationPill` renders nothing without a measurement and that is the correct
 * outcome here — a trace must not show more than it can honestly measure.
 *
 * No denominator unless something really knows the total. Only the plan
 * checklist knows how many steps were intended; inventing "5 of 8" from a
 * running count would be a number this component cannot back up.
 *
 * ONE ROW THE STREAM DOES NOT CARRY. A test run (`builder_request_dry_run`)
 * only arrives as a call once it has FINISHED, so while it ran — minutes on a
 * file fan-out — the spinner sat on the call before it, "Reviewed the
 * routine", which was long done. `liveRun` is the run the server announced
 * when its row was created (`dryrun_started`), read the way the canvas banner
 * reads it (flow/runFocus.js): it becomes the live row at the foot of the
 * list, "Testing the routine… · Read file content · 1/4", and the row before
 * it gets its tick. The real call replaces it when the run lands.
 */
export default function BuilderActivity({ toolCalls, running = false, liveRun = null, t = null }) {
    const calls = Array.isArray(toolCalls) ? toolCalls : [];
    if (calls.length === 0) return null;

    const rows = calls.map(tc => describeToolCall(tc, t));
    const failed = rows.filter(r => r.status === 'failed').length;
    // Only while the turn runs: a manual run after the build is the canvas's
    // story, not this list's.
    const live = running && liveRun ? describeLiveRun(liveRun, t) : null;
    if (live) rows.push(live);
    // The last row is the live one only while the turn is still running.
    const activeIdx = running ? rows.length - 1 : -1;

    return (
        <div
            className="mt-1.5 w-full max-w-3xl rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]/50 p-2.5 text-xs"
            data-testid="builder-activity"
        >
            <div className="flex items-center gap-1.5 mb-1.5 text-[var(--text-secondary)]">
                {running
                    ? <Loader2 size={13} className="text-[var(--accent)] animate-spin flex-shrink-0" />
                    : <Hammer size={13} className="flex-shrink-0" />}
                <span className="font-medium">
                    {running
                        ? (t ? t('routines.builder.act.building', 'Building') : 'Building')
                        : (t ? t('routines.builder.act.built', 'Built') : 'Built')}
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)]">{rows.length}</span>
                {failed > 0 && (
                    <span className="text-[10px] ml-auto flex items-center gap-1" style={{ color: 'var(--warning)' }}>
                        <TriangleAlert size={11} />
                        {failed}
                    </span>
                )}
            </div>

            <div className="relative flex flex-col gap-0.5">
                <TimelineRail show={rows.length > 1} />
                {rows.map((row, i) => (
                    <ActivityRow
                        key={i}
                        n={i + 1}
                        row={row}
                        tc={calls[i] || null}
                        active={i === activeIdx}
                        live={row === live}
                    />
                ))}
            </div>
        </div>
    );
}

/**
 * The canvas card's tile at chat size. 34px is the card's; a chat row is a
 * third of that height, so the same shape at `size` rather than a different
 * shape at the right size. `typeTileStyle` returns `{ tile, glyph }` — the
 * first version of this row styled the wrapper object itself, so the tile
 * rendered with no tint or colour at all.
 */
function compactTile(family, type, error, size) {
    const { tile } = typeTileStyle(family, { type, error });
    const radius = Math.round(size * 0.32);
    tile.width = size; tile.height = size;
    tile.borderRadius = error ? radius : (typeof tile.borderRadius === 'number' ? Math.min(tile.borderRadius, radius) : tile.borderRadius);
    return tile;
}

/** The tile's glyph: the batch stack, the flask of a test in flight, or the step's own icon. */
function RowGlyph({ batch, live, tc }) {
    if (batch) return <Layers size={13} />;
    if (live) return <FlaskConical size={13} />;
    return <StepIcon name={tc?.result?.added?.icon} size={13} fallback={<Wrench size={13} />} />;
}

function ActivityRow({ n, row, tc, active, live = false }) {
    const failedTone = row.status === 'failed';
    // A `builder_add_steps` batch: one row for the call, and under its summary
    // one compact line per step it created — the SAME cards the canvas is
    // dealing one at a time to the right, so the two surfaces stay one story.
    const batch = Array.isArray(row.steps) && row.steps.length > 1;
    const tile = compactTile(row.family, row.type, failedTone, 22);

    return (
        <details
            // `bf-step-in` fires on MOUNT only. Rows are keyed by index and the
            // array only ever grows, so React reuses the DOM for every row that
            // was already there and mounts just the new one — which is exactly
            // the one that should animate. Re-keying the whole list would
            // replay the entrance of every step on every arrival.
            className="group/act bf-step-in rounded-md hover:bg-[var(--bg-tertiary)]/40 transition-colors"
            open={failedTone || undefined}
            data-testid="activity-row"
            data-live={live ? '' : undefined}
        >
            {/* The batch list lives INSIDE the summary: a <details> hides
                everything else until opened, and these lines are part of what
                the row says, not of its details. Spans only — a summary's
                content model is phrasing content. */}
            <summary className="flex flex-col cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden px-1 py-1">
                <span className="flex items-center gap-2">
                    <StepBadge n={n} muted={failedTone} />
                    <span style={tile} aria-hidden="true">
                        <RowGlyph batch={batch} live={live} tc={tc} />
                    </span>
                    <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
                        <span className="font-medium text-[var(--text-primary)] whitespace-nowrap">{row.title}</span>
                        {row.detail && (
                            <span className="min-w-0 truncate text-[var(--text-tertiary)]" title={row.detail}>
                                {row.detail}
                            </span>
                        )}
                    </span>
                    {active
                        ? <Loader2 size={12} className="flex-shrink-0 animate-spin" style={{ color: typeColorVar(row.family) }} />
                        : failedTone
                            ? <TriangleAlert size={12} className="flex-shrink-0" style={{ color: 'var(--warning)' }} />
                            : <Check size={12} className="flex-shrink-0 text-emerald-500" />}
                    <ChevronRight size={11} className="flex-shrink-0 opacity-40 transition-transform group-open/act:rotate-90" />
                </span>
                {batch && (
                    <span className="flex flex-col pl-[2.35rem] mt-0.5" data-testid="activity-batch">
                        {row.steps.map((s, i) => (
                            <span
                                key={s.id ?? i}
                                className="bf-step-in flex items-center gap-1.5 h-5 min-w-0 text-[var(--text-secondary)]"
                                data-testid="activity-batch-step"
                            >
                                <span style={compactTile(s.family, s.type, false, 16)} aria-hidden="true" />
                                <span className="min-w-0 truncate">{s.title}</span>
                            </span>
                        ))}
                    </span>
                )}
            </summary>

            <div className="px-1 pb-1.5 pl-9">
                {/* A refusal says what is wrong in words; the payload is for
                    when the words are not enough. Showing the reason without a
                    click is the whole point of surfacing failures at all. */}
                {row.error && (
                    <div className="mb-1.5 rounded-md px-2 py-1.5" style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', color: 'var(--text-primary)' }}>
                        <div>{row.error}</div>
                        {row.hint && <div className="mt-0.5 text-[var(--text-secondary)]">{row.hint}</div>}
                    </div>
                )}
                {/* The live row has no call yet — its payload is the run the
                    canvas is following, not something to print here. */}
                {!live && (
                    <pre className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md p-2 max-h-60 overflow-auto whitespace-pre-wrap text-[var(--text-primary)]">
                        {JSON.stringify(detailPayload(tc), null, 2)}
                    </pre>
                )}
            </div>
        </details>
    );
}
