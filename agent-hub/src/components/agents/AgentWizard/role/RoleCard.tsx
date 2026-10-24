import React from 'react';
import type { ReactNode } from 'react';

/**
 * The card shape of the "Role" tab (Agents artboard 1c): a coloured glyph, a title, a grey subtitle, and underneath what the
 * card has to say.
 *
 * ── WHY NOT `canUse/CanUseCard` ─────────────────────────────────────
 * That shell draws a KIND TILE from `shared/kindColors`, the legend for things that you MAKE in Studio (a knowledge base, a
 * skill, a table). The five cards here are not linked objects but five pieces of one description. They would all receive the
 * same blue agent tile, which makes the legend meaningless. The shell is therefore separate, and deliberately thinner: no
 * "+ Link", no ⋯ menu, no rows with dividing lines.
 *
 * The card draws NO behaviour. It does not know what a tone chip is, and that is precisely why the five cards cannot grow
 * apart in shape.
 */
export default function RoleCard({ icon, iconColor = 'var(--type-ai)', title, hint, action, children, testId, wide = false }: {
    icon?: ReactNode;
    iconColor?: string;
    title?: ReactNode;
    hint?: ReactNode;
    action?: ReactNode;
    children?: ReactNode;
    testId?: string;
    wide?: boolean;
}) {
    return (
        <section
            data-testid={testId}
            className={`rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] px-4 py-3.5 flex flex-col gap-2 ${wide ? 'sm:col-span-2' : ''}`}
        >
            <div className="flex items-center gap-2 min-w-0">
                {icon && <span className="flex-shrink-0" style={{ color: iconColor }} aria-hidden="true">{icon}</span>}
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</span>
                {hint && <span className="text-[12px] text-[var(--text-tertiary)] truncate">{hint}</span>}
                {action && <span className="ml-auto flex-shrink-0">{action}</span>}
            </div>
            {children}
        </section>
    );
}

/**
 * The line under a card that says what will HAPPEN with the content.
 *
 * Three tones, and the difference is not cosmetic:
 *   'muted'   an explanation;
 *   'warn'    something is not right, or could not be read. `role="status"`, because it is about the state of the screen;
 *   'promise' the promise line: what stands here is an INSTRUCTION and not a block. See the docblock at `BulletsCard`.
 */
/**
 * `announce={false}` for a note that is ALREADY inside an `aria-live` block. Two live regions nested cause a screen reader to
 * read the same sentence twice. The same rule applies as in AgentStudio/AgentOverview.tsx and the precedent
 * Studio/Datatables/DatatablesStudio.jsx, where the changing content stands in one bare wrapper with role-less children.
 */
export function RoleNote({ tone = 'muted', children, testId, announce = true }: {
    tone?: 'muted' | 'warn' | 'promise';
    children?: ReactNode;
    testId?: string;
    announce?: boolean;
}) {
    const style = tone === 'warn'
        ? { color: 'var(--warning)' }
        : { color: 'var(--text-tertiary)' };
    return (
        <p
            data-testid={testId}
            role={tone === 'warn' && announce ? 'status' : undefined}
            className="text-[11px] leading-[15px] m-0"
            style={style}
        >
            {children}
        </p>
    );
}

/** The empty box: read, and there is really nothing in it. Never on a failed read. */
export function RoleEmpty({ children, testId }: { children?: ReactNode; testId?: string }) {
    return (
        <p data-testid={testId} className="text-[12px] leading-[17px] m-0 text-[var(--text-tertiary)] italic">
            {children}
        </p>
    );
}

/**
 * A counter "412 / 600". It only appears when it matters: below 80% of
 * the limit it is noise, and noise teaches people to look away from counters.
 */
export function RoleCounter({ value = '', max, testId, label }: { value?: string; max: number; testId?: string; label?: string }) {
    const used = typeof value === 'string' ? value.length : 0;
    if (used < max * 0.8) return null;
    return (
        <span
            data-testid={testId}
            className="text-[11px] tabular-nums"
            style={{ color: used >= max ? 'var(--warning)' : 'var(--text-tertiary)' }}
            aria-label={label}
        >
            {used} / {max}
        </span>
    );
}

/**
 * The text box of a role card.
 *
 * Same shape as `builderSplit/InstructionsEditor`, and for the same reason: the
 * editor around it is large, so the keystrokes stay local and the parent only sees
 * what is there. It does not deduplicate and does not truncate (that is done by
 * `personaFacts` when writing), but `maxLength` IS here, because the
 * server truncates without saying anything, and then the last sentence is gone
 * without the box ever turning red.
 */
export function RoleTextArea({ value, onChange, placeholder, maxLength, rows = 3, disabled = false, testId, ariaLabel }: {
    value?: string;
    onChange?: (next: string) => void;
    placeholder?: string;
    maxLength?: number;
    rows?: number;
    disabled?: boolean;
    testId?: string;
    ariaLabel?: string;
}) {
    const [local, setLocal] = React.useState(value || '');
    const lastRef = React.useRef(value);
    React.useEffect(() => {
        if (value !== lastRef.current) { lastRef.current = value; setLocal(value || ''); }
    }, [value]);
    const handle = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const next = e.target.value;
        setLocal(next);
        lastRef.current = next;
        onChange?.(next);
    };
    return (
        <textarea
            data-testid={testId}
            aria-label={ariaLabel}
            value={local}
            onChange={handle}
            rows={rows}
            disabled={disabled}
            maxLength={maxLength}
            placeholder={placeholder}
            className="w-full bg-[var(--bg-secondary)]/50 border border-transparent focus:border-[var(--border-default)] rounded-lg px-3 py-2 text-[12px] leading-[18px] text-[var(--text-secondary)] outline-none resize-y disabled:opacity-70 disabled:resize-none"
        />
    );
}
