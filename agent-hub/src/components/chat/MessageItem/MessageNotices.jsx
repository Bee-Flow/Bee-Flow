/**
 * The two "this is not a normal bubble" states MessageItem can short-circuit
 * into: the compaction boundary rule and the removed/redacted user message.
 * Lifted verbatim out of MessageItem/index.jsx — same markup, same copy.
 */

// ── Compaction boundary → a rule, not a message bubble ──────────────
export const CompactionDivider = ({ t }) => (
    <div className="flex items-center gap-3 my-4 px-2 select-none" aria-hidden="false">
        <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
        <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {t('chat.earlierMessagesSummarised', 'Eerdere berichten zijn samengevat')}
        </span>
        <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
    </div>
);

// ── Fully deleted / PII-redacted user messages → compact indicator ──
export const RemovedUserMessage = ({ t }) => (
    <div className="flex justify-end mb-2 animate-fade-in">
        <div
            className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl select-none"
            style={{
                background: 'linear-gradient(135deg, var(--bg-tertiary) 0%, var(--bg-secondary) 100%)',
                border: '1px dashed var(--border-subtle)',
                opacity: 0.7,
            }}
        >
            <div
                className="flex items-center justify-center w-6 h-6 rounded-full"
                style={{ background: 'var(--bg-tertiary)', flexShrink: 0 }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
            </div>
            <span className="text-xs" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {t('chat.message_removed', 'Message removed by security policy')}
            </span>
        </div>
    </div>
);
