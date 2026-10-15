import type { CSSProperties, ReactNode } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { COLORS, fmtPct } from './sharedFormat';

// ── Base UI Components ──────────────────────────────────────────────────────

interface CardProps {
    title?: ReactNode;
    icon?: LucideIcon;
    children?: ReactNode;
    style?: CSSProperties;
    action?: ReactNode;
}

export function Card({ title, icon: Icon, children, style: extraStyle, action }: CardProps) {
    return (
        <div style={{
            background: 'var(--bg-secondary, #1a1a2e)', borderRadius: '14px',
            padding: '18px 20px', border: '1px solid var(--border-default, rgba(255,255,255,0.08))',
            ...extraStyle,
        }}>
            {(title || action) && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {Icon && <Icon style={{ width: 16, height: 16, color: COLORS.primary }} />}
                        {title && <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary, #fff)' }}>{title}</span>}
                    </div>
                    {action}
                </div>
            )}
            {children}
        </div>
    );
}

export function Empty({ text }: { text: ReactNode }) {
    return (
        <div style={{
            padding: '2.5rem 1rem', textAlign: 'center',
            color: 'var(--text-muted, #666)', fontSize: '13px',
            borderRadius: '10px', background: 'var(--bg-tertiary, rgba(255,255,255,0.02))',
        }}>
            {text}
        </div>
    );
}

interface MetricCardProps {
    icon: LucideIcon;
    label: ReactNode;
    value: ReactNode;
    color: string;
    subtitle?: ReactNode;
    delta?: number | null;
    deltaLabel?: ReactNode;
}

export function MetricCard({ icon: Icon, label, value, color, subtitle, delta, deltaLabel }: MetricCardProps) {
    const up = delta != null && delta > 0;
    const down = delta != null && delta < 0;
    const deltaColor = up ? COLORS.green : down ? COLORS.rose : 'var(--text-muted, #888)';
    const DeltaIcon = up ? ArrowUp : down ? ArrowDown : Minus;

    return (
        <div style={{
            background: 'var(--bg-secondary, #1a1a2e)', borderRadius: '14px',
            padding: '18px', border: '1px solid var(--border-default, rgba(255,255,255,0.08))',
            display: 'flex', flexDirection: 'column', gap: '6px',
            transition: 'border-color 0.2s, transform 0.2s',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                    width: '30px', height: '30px', borderRadius: '8px',
                    background: color + '15', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <Icon style={{ width: 16, height: 16, color }} />
                </div>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted, #888)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {label}
                </span>
            </div>
            <span style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary, #fff)', lineHeight: 1 }}>
                {value}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minHeight: '16px' }}>
                {delta != null && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '2px', fontSize: '11px', fontWeight: 600, color: deltaColor }}>
                        <DeltaIcon style={{ width: 12, height: 12 }} />
                        {fmtPct(delta)}
                    </span>
                )}
                {(subtitle || deltaLabel) && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted, #888)' }}>
                        {subtitle || deltaLabel}
                    </span>
                )}
            </div>
        </div>
    );
}

