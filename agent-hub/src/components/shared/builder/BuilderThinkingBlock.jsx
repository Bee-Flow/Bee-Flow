import { Brain, ChevronRight } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { currentThought, renderThinking } from './thinkingMarkdown';
import { useTranslation } from '../../../hooks/useTranslation';

/**
 * Collapsible reasoning block for the builder chat — parity with direct/agent
 * chat's ThinkingPanel, but styled with the builder's neutral tokens (no
 * purple). Reads the same message shape: thinkingParts[{id,text,startedAt,
 * endedAt,redacted}] + thinkingStartedAt/thinkingEndedAt + isStreaming.
 */
/**
 * "Thinking…" while it runs, "Thought for 4.2s" once it has, "Reasoning" when
 * nothing timed it. Module-level so the component keeps one job: a duration
 * ladder is the kind of thing that grows a branch a year and is easier to read
 * (and to test) away from the JSX.
 */
function headerLabel(msg, isStreaming, nowTs, t) {
    const endTs = msg.thinkingEndedAt || (isStreaming ? nowTs : null);
    const ms = (msg.thinkingStartedAt && endTs) ? (endTs - msg.thinkingStartedAt) : null;
    const elapsed = ms == null ? '' : ms < 60000
        ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
        : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
    // The counter now RUNS while it thinks. The 500ms tick that feeds it
    // always existed, but the streaming branch returned a bare "Thinking…"
    // and threw the number away — so the panel gave no sign of progress
    // during the longest part of a local build, which is exactly when you
    // want one.
    // Translated: this is the one line the whole column shows for minutes on
    // a local model, and it sat next to a translated waiting card in English.
    const thinking = t('automations.builder.thinking', 'Thinking…');
    if (isStreaming) return elapsed ? `${thinking} ${elapsed}` : thinking;
    return ms == null ? 'Reasoning' : `Thought for ${elapsed}`;
}

export default function BuilderThinkingBlock({ msg }) {
    const { t } = useTranslation();
    const parts = Array.isArray(msg.thinkingParts) ? msg.thinkingParts : [];
    const isStreaming = !!msg.isStreaming && parts.some(p => !p.endedAt);
    const hasContent = parts.some(p => (p.text && p.text.trim()) || p.redacted);

    const [userOpen, setUserOpen] = useState(null); // null = auto
    const [autoOpen, setAutoOpen] = useState(true);
    const [nowTs, setNowTs] = useState(() => Date.now()); // ticks the live elapsed counter
    const prevStreaming = useRef(isStreaming);
    const bodyRef = useRef(null);

    useEffect(() => {
        if (!isStreaming) return;
        const id = setInterval(() => setNowTs(Date.now()), 500);
        return () => clearInterval(id);
    }, [isStreaming]);

    useEffect(() => {
        // Auto-collapse shortly after streaming ends. While streaming, `open`
        // is forced true below, so no need to re-open here (avoids a
        // synchronous setState in the effect).
        if (prevStreaming.current && !isStreaming) {
            const t = setTimeout(() => setAutoOpen(false), 800);
            prevStreaming.current = isStreaming;
            return () => clearTimeout(t);
        }
        prevStreaming.current = isStreaming;
    }, [isStreaming]);

    useEffect(() => {
        if (isStreaming && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    });

    // Collapsed by default WHILE streaming too. It used to force open here, and
    // on a small local model that reasons for pages the panel became a wall of
    // italic monologue with the actual build scrolled off the bottom — the
    // reasoning is the least actionable thing in the column. The summary row
    // still says it is thinking and for how long, and `userOpen` remembers an
    // explicit open, so nothing is hidden from anyone who wants it.
    const open = userOpen ?? (isStreaming ? false : autoOpen);
    const text = parts.map(p => (p.redacted && !p.text ? '[reasoning hidden by provider]' : p.text)).join('\n\n');

    // Both memos sit ABOVE the early return: a hook after it runs on some
    // renders and not others, and React matches hooks by call order, so the
    // pair would desync the moment a block went from empty to streaming.
    //
    // The reasoning is markdown by habit — inline `code`, bullets, numbered
    // plans — and reading it as literal text was most of why this block looked
    // like a dump. Memoised on the text so a re-render that changes nothing
    // else (the 500ms elapsed tick, for one) does not re-parse it.
    const body = useMemo(() => (open ? renderThinking(text) : null), [open, text]);
    // What it is chewing on right now, for the shut state. Only computed when
    // shut, and only while streaming — once it has stopped, the duration is
    // the more useful thing to read.
    //
    // The narrated summary wins over the heuristic when the server sent one.
    // The owner's reason: the raw reasoning's last line "says little to most
    // users" — it is the model talking to itself. `thinkingSummary` is a
    // 350M-model phrase about the CURRENT thoughts, refreshed as they stream
    // in, and it is the same string the canvas ghost shows, so a presenter can
    // read either surface aloud. `currentThought` stays as the fallback for a
    // turn with narration off, or a narrator that timed out and went quiet.
    const summary = typeof msg.thinkingSummary?.text === 'string' ? msg.thinkingSummary.text.trim() : '';
    const now = useMemo(
        () => (!open && isStreaming ? (summary || currentThought(text)) : ''),
        [open, isStreaming, summary, text],
    );

    if (!hasContent && !isStreaming) return null;

    const label = headerLabel(msg, isStreaming, nowTs, t);

    return (
        <details
            className="group/think mb-2 w-full max-w-3xl rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]/50"
            open={open}
            onToggle={(e) => setUserOpen(e.currentTarget.open)}
        >
            <summary
                className="flex items-center gap-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden px-3 py-2 text-[var(--text-secondary)]"
            >
                <Brain size={13} className={`flex-shrink-0 ${isStreaming ? 'animate-pulse' : ''}`} />
                <span className="text-xs font-medium">{label}</span>
                {now && (
                    <span
                        // 11px, a step under the label's text-xs. It carried no
                        // size class at all at first, so it inherited the chat
                        // column's base and rendered LARGER than the label it
                        // qualifies — the live thought shouted over "Thinking…".
                        className="min-w-0 flex-1 truncate text-[11px] leading-tight text-[var(--text-tertiary)] font-normal"
                        title={now}
                    >
                        {now}
                    </span>
                )}
                {isStreaming && (
                    <span className={`flex items-center gap-0.5 ${now ? '' : 'ml-0.5'}`} aria-hidden="true">
                        <span className="w-1 h-1 rounded-full bg-[var(--text-tertiary)] animate-bounce" />
                        <span className="w-1 h-1 rounded-full bg-[var(--text-tertiary)] animate-bounce" style={{ animationDelay: '75ms' }} />
                        <span className="w-1 h-1 rounded-full bg-[var(--text-tertiary)] animate-bounce" style={{ animationDelay: '150ms' }} />
                    </span>
                )}
                <ChevronRight size={12} className="ml-auto opacity-40 transition-transform group-open/think:rotate-90" />
            </summary>
            {/* Rendered only when open. <details> keeps its children mounted
                when shut, so the old unconditional body re-parsed and
                re-reconciled the whole transcript on every streamed token of a
                panel nobody was looking at — and collapsed is now the default.
                Opening is a click, and the text is in props either way. */}
            {open && (
                <div
                    ref={bodyRef}
                    className="px-3 pb-2.5 max-h-[260px] overflow-y-auto custom-scrollbar text-xs leading-relaxed text-[var(--text-secondary)]"
                    style={{ opacity: 0.9 }}
                >
                    {body}
                    {isStreaming && <span className="inline-block w-1.5 h-3 bg-[var(--text-tertiary)] ml-0.5 animate-pulse align-text-bottom" />}
                </div>
            )}
        </details>
    );
}
