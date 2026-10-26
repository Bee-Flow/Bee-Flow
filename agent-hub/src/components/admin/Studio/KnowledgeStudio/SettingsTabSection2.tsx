import { Bot, MessageSquare, Workflow } from 'lucide-react';
import { kindColorVar } from '@/components/shared/kindColors';
import type { UsageRow } from '@/hooks/useUsage';
import type { TranslateParams } from '@/hooks/useTranslation';
import type { SurfaceCardProps } from './SettingsTab.types';

/** The three surfaces the Studio offers. 'webpage' stays hidden — auto-created bases own it. */
export const SURFACE_CARDS = Object.freeze([
    { id: 'agent', Icon: Bot, kind: 'agent' },
    { id: 'direct_chat', Icon: MessageSquare, kind: 'chat' },
    { id: 'ai_step', Icon: Workflow, kind: 'automation' },
]);

/** How many things in the Used-by list depend on this base through `surface`. */
export function attachedCount(usage: UsageRow[] | null, surface: string) {
    if (!Array.isArray(usage)) return 0;
    const roles: (string | null | undefined)[] = surface === 'ai_step' ? ['ai_step'] : surface === 'agent' ? ['chat'] : [];
    if (roles.length === 0) return 0;
    const kinds: (string | null | undefined)[] = surface === 'ai_step' ? ['automation', 'app'] : ['agent', 'webpage', 'support'];
    return usage.filter(u => roles.includes(u.role) && kinds.includes(u.kind)).length;
}

export function SettingsTabSection2({ t, surfaces, canManage, saving, usage, toggleSurface }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; surfaces: string[]; canManage: boolean; saving: boolean; usage: UsageRow[] | null; toggleSurface: (surface: string) => void; }) {
    return <section className="flex flex-col gap-2" data-testid="kb-surfaces">
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t('knowledge.settings.where_title', 'Where it can be used')}
        </h3>
        <div className="grid gap-2 [grid-template-columns:repeat(3,minmax(0,1fr))]">
            {SURFACE_CARDS.map(({ id }) => (
                <SurfaceCard
                    key={id}
                    id={id}
                    active={surfaces.includes(id)}
                    disabled={!canManage || saving}
                    attached={attachedCount(usage, id)}
                    onToggle={() => toggleSurface(id)}
                    t={t} />
            ))}
        </div>
        <p className="text-[11px] text-[var(--text-tertiary)]">
            {t('knowledge.settings.where_hint', 'This decides which pickers offer this knowledge base. It does not change who may read what is in it — that is below.')}
        </p>
    </section>;
}

function SurfaceCard({ id, active, disabled, attached, onToggle, t }: SurfaceCardProps) {
    const card = SURFACE_CARDS.find(c => c.id === id) || SURFACE_CARDS[0];
    const Glyph = card.Icon;
    const colour = kindColorVar(card.kind);
    const LABELS: Record<string, string> = {
        agent: t('knowledge.settings.surface_agent', 'Agents'),
        direct_chat: t('knowledge.settings.surface_direct_chat', 'Chat'),
        ai_step: t('knowledge.settings.surface_ai_step', 'Automations'),
    };
    return (
        <button
            type="button"
            role="switch"
            aria-checked={active}
            aria-label={LABELS[id]}
            disabled={disabled}
            onClick={onToggle}
            data-testid={`kb-surface-${id}`}
            data-active={active ? 'true' : 'false'}
            className="flex flex-col items-start gap-1 p-2.5 rounded-[10px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
            style={{
                border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border-default)'}`,
                boxShadow: active ? 'inset 0 0 0 1px var(--text-primary)' : 'none',
                background: 'var(--bg-card)',
                outlineColor: 'var(--accent-primary)',
            }}
        >
            <Glyph style={{ width: 14, height: 14, color: colour }} aria-hidden="true" />
            <span
                className="text-[12px]"
                style={{ color: 'var(--text-primary)', fontWeight: active ? 600 : 400 }}
            >
                {LABELS[id]}
            </span>
            {/* Unticking a surface never detaches what is already attached —
                the server only refuses NEW links — so the count says so
                rather than letting somebody think they revoked something. */}
            {!active && attached > 0 && (
                <span className="text-[10px] [color:var(--warning-ink,var(--warning))]!">
                    {attached === 1
                        ? t('knowledge.settings.still_attached_one', 'still attached to 1')
                        : t('knowledge.settings.still_attached', 'still attached to {n}', { n: attached })}
                </span>
            )}
        </button>
    );
}
