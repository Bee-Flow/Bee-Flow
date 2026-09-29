/**
 * The card a dashboard is made of: a titled section on the card surface, an
 * optional meta line beside the title and an optional action on the right.
 * Tokens only (the newest Studio idiom — Runs/NowRunningStrip, the source
 * mirror panel), so it sits in every theme.
 */
export default function DashCard({ title, meta = null, action = null, children, testId, className = '' }) {
    return (
        <section
            className={`rounded-xl border p-4 space-y-3 ${className}`}
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', boxShadow: 'var(--shadow-sm)' }}
            data-testid={testId}
            aria-label={typeof title === 'string' ? title : undefined}
        >
            {(title || action) && (
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        {title && <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{title}</h3>}
                        {meta && <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{meta}</p>}
                    </div>
                    {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
                </div>
            )}
            {children}
        </section>
    );
}
