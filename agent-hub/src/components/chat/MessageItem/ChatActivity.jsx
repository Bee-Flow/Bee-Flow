import { Check, ChevronRight, Loader2, Minus, TriangleAlert, Wrench } from 'lucide-react';
import React from 'react';
import { describeChatTool, detailPayload, resultFor, visibleToolHistory } from './chatToolCallDisplay';
import { DurationPill, StepBadge, TimelineRail } from './timelineParts';
import useTranslation from '../../../hooks/useTranslation';
import { getToolIcon, toolNameToCatalogId } from '../../../utils/helpers';
import { resolveIntegrationFromTool } from '../../../utils/integrationIcons';
import IntegrationLogo from '../../automation/Builder/flow/nodes/IntegrationLogo';
import AppEmoji from '../../icons/AppEmoji';

/**
 * What the assistant did for this answer, while it is doing it — the chat's
 * sibling of automation/Builder/chat/BuilderActivity.jsx and
 * AppStudio/chat/AppBuilderActivity.jsx.
 *
 * Before this card the same stream was told three different ways: a single
 * italic line before any text arrived (ActivityIndicator), a pill plus a
 * column of grey ticks once text had started (ToolOutput.renderToolCall),
 * and after the turn a list folded away behind two clicks in "How I got this
 * answer". Three shapes for one story, none of them the shape the builders
 * one tab over use for exactly the same thing. This is that shape: the same
 * StepBadge, rail and `<details>` per row, so a person who has watched a
 * routine being built recognises a search being run.
 *
 * WHAT DIFFERS FROM THE BUILDERS, AND WHY.
 *
 * The tile is the tool's own icon — the app's logo for an integration
 * (Gmail, Nextcloud Files), the catalog emoji otherwise — because a chat tool
 * has no step family to be tinted by, and the logo is what the Apps panel
 * and the old timeline already showed for it.
 *
 * Durations ARE shown. The builders refuse them because their stream carries
 * no timing; the chat stamps `startTime`/`endTime` on every history row, so
 * here the pill is a measurement, not a guess. The sum sits in the header,
 * rounded by the same `formatDurationMs` as the rows.
 *
 * Failure is read off the result (chatToolCallDisplay.errorOf), since the
 * stream marks nothing as failed: a guard refusal or an `{ error }` result
 * gets the warning glyph and its reason in words, without a click.
 *
 * The card stays after the turn, as the builders' do — the tools are the
 * story of the answer, not debugging output.
 */
export default function ChatActivity({ msg, sessionSkills = [], t: tProp = null }) {
    const { t: tHook } = useTranslation();
    const t = tProp || tHook;
    const entries = visibleToolHistory(msg);
    if (entries.length === 0) return null;

    const streaming = !!msg.isStreaming;
    const results = entries.map((_, i) => resultFor(msg, i));
    const rows = entries.map((entry, i) => describeChatTool(entry, { t, sessionSkills, result: results[i], streaming }));
    const failed = rows.filter(r => r.status === 'failed').length;
    const totalMs = rows.reduce((acc, r) => acc + (r.durationMs || 0), 0);

    return (
        <div
            className="mt-1.5 mb-2 w-full max-w-3xl rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]/50 p-2.5 text-xs"
            data-testid="chat-activity"
            data-running={streaming ? '' : undefined}
        >
            <div className="flex items-center gap-1.5 mb-1.5 text-[var(--text-secondary)]">
                {streaming
                    ? <Loader2 size={13} className="flex-shrink-0 animate-spin motion-reduce:animate-none" style={{ color: 'var(--accent-primary)' }} />
                    : <Wrench size={13} className="flex-shrink-0" />}
                <span className="font-medium">
                    {streaming ? t('chat.act.working', 'Working') : t('chat.msg.tools_used', 'Tools Used')}
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)]">{rows.length}</span>
                {!streaming && totalMs > 0 && <DurationPill ms={totalMs} />}
                {failed > 0 && (
                    <span className="ml-auto flex items-center gap-1 text-[10px]" style={{ color: 'var(--warning)' }}>
                        <TriangleAlert size={11} />
                        {t('chat.act.failed_count', '{n} failed', { n: failed })}
                    </span>
                )}
            </div>

            <div className="relative flex flex-col gap-0.5">
                <TimelineRail show={rows.length > 1} />
                {rows.map((row, i) => (
                    <ActivityRow key={i} n={i + 1} row={row} entry={entries[i]} result={results[i]} t={t} />
                ))}
            </div>
        </div>
    );
}

/** The 22px tile: the app's logo when the tool belongs to one, else the catalog emoji. */
function ToolTile({ name, failed }) {
    const integrationId = resolveIntegrationFromTool(name);
    const style = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        width: 22, height: 22, borderRadius: 7,
        background: failed
            ? 'color-mix(in srgb, var(--warning) 14%, transparent)'
            : 'var(--bg-tertiary)',
        color: failed ? 'var(--warning)' : 'var(--text-secondary)',
    };
    return (
        <span style={style} aria-hidden="true">
            {integrationId
                ? <IntegrationLogo integrationId={integrationId} size={14} fallback={<AppEmoji id={toolNameToCatalogId(name)} default={getToolIcon(name)} className="text-[12px] leading-none" />} />
                : <AppEmoji id={toolNameToCatalogId(name)} default={getToolIcon(name)} className="text-[12px] leading-none" />}
        </span>
    );
}

function StatusGlyph({ status }) {
    if (status === 'running') return <Loader2 size={12} className="flex-shrink-0 animate-spin motion-reduce:animate-none" style={{ color: 'var(--accent-primary)' }} />;
    if (status === 'failed') return <TriangleAlert size={12} className="flex-shrink-0" style={{ color: 'var(--warning)' }} />;
    if (status === 'interrupted') return <Minus size={12} className="flex-shrink-0 text-[var(--text-tertiary)]" />;
    return <Check size={12} className="flex-shrink-0 text-emerald-500" />;
}

/** Bounded: a search result is kilobytes of JSON, and this pane is a glance, not a viewer. */
const RESULT_MAX = 4000;
function renderPayloadPart(value) {
    if (value == null) return null;
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}…` : text;
}

function ActivityRow({ n, row, entry, result, t }) {
    const failed = row.status === 'failed';
    const payload = detailPayload(entry, result);
    const argsText = renderPayloadPart(payload.args);
    const resultText = row.status === 'running' ? null : renderPayloadPart(payload.result);

    return (
        <details
            // `bf-step-in` fires on MOUNT only. Rows are keyed by index and the
            // history only grows, so only the newly arrived row animates.
            className="group/act bf-step-in rounded-md hover:bg-[var(--bg-tertiary)]/40 transition-colors"
            open={failed || undefined}
            data-testid="chat-activity-row"
            data-status={row.status}
        >
            <summary className="flex items-center gap-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden px-1 py-1">
                <StepBadge n={n} muted={failed || row.status === 'interrupted'} />
                <ToolTile name={entry.name} failed={failed} />
                <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
                    <span className="font-medium text-[var(--text-primary)] whitespace-nowrap">{row.title}</span>
                    {row.detail && (
                        <span className="min-w-0 truncate text-[var(--text-tertiary)]" title={row.detail}>{row.detail}</span>
                    )}
                </span>
                <DurationPill ms={row.durationMs} />
                <StatusGlyph status={row.status} />
                <ChevronRight size={11} className="flex-shrink-0 opacity-40 transition-transform group-open/act:rotate-90" />
            </summary>

            <div className="px-1 pb-1.5 pl-9 flex flex-col gap-1.5">
                {/* The reason in words first; the payload is for when the words are not enough. */}
                {row.error && (
                    <div className="rounded-md px-2 py-1.5" style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', color: 'var(--text-primary)' }}>
                        {row.error}
                    </div>
                )}
                {argsText && (
                    <PayloadBlock label={t('chat.act.input', 'Input')} text={argsText} />
                )}
                {resultText && (
                    <PayloadBlock label={t('chat.act.result', 'Result')} text={resultText} />
                )}
            </div>
        </details>
    );
}

function PayloadBlock({ label, text }) {
    return (
        <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
            <pre className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md p-2 max-h-60 overflow-auto whitespace-pre-wrap text-[var(--text-primary)]">
                {text}
            </pre>
        </div>
    );
}
