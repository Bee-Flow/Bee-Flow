// Dashboard-specific display widgets shared by the Usage tabs (Overview /
// Safety / Integrations). These depend on the integration-icon registry and
// the source map, so they live here rather than in the generic `kit.jsx`.

import { Globe, Cpu, type LucideIcon } from 'lucide-react';
import { shortModel } from './format';
import { getIntegrationIcon, hasIntegrationIcon } from '@/config/integrationIcons';
import { usageSourceDetails } from '@/components/shared/usageAreaMeta';

// ── Source details ───────────────────────────────────────────────────────────
// A ledger `source` with the icon and colour of the area it rolls up to (the
// shared vocabulary, shared/usageAreas.generated.mjs), so this list and the
// Adoption report never disagree. The name is unique per source (the area's
// name, plus the raw source where the area has several), since the lists and
// filters here are keyed by source. Pass `t` for the translated area name;
// without it the English name is used.
type SourceTranslate = (key: string, fallback: string) => string;
export const getSourceDetails = (source: string, t?: SourceTranslate) => usageSourceDetails(source, t);

// ── Avatar ───────────────────────────────────────────────────────────────────
interface AvatarProps {
    user?: { display_name?: string; avatarType?: string | null; avatar?: string | null } | null;
    name?: string;
    color: string;
    size?: number;
}

export const Avatar = ({ user, name, color, size = 26 }: AvatarProps) => {
    const displayName = user?.display_name || name || '?';
    const avatarType = user?.avatarType;
    const avatar = user?.avatar;
    const base = {
        width: size, height: size, borderRadius: 99, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
    };
    if (avatarType === 'emoji' && avatar) {
        return (
            <div style={{ ...base, background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', fontSize: Math.round(size * 0.5), lineHeight: 1 }}>
                {avatar}
            </div>
        );
    }
    if (avatarType === 'url' && avatar) {
        return <img src={avatar} alt={displayName} style={{ ...base, objectFit: 'cover' }} />;
    }
    return (
        <div style={{ ...base, fontSize: Math.round(size * 0.42), fontWeight: 700, color: '#fff', background: `linear-gradient(135deg, ${color || 'var(--accent-primary)'}, ${color || 'var(--accent-primary)'}99)` }}>
            {displayName[0].toUpperCase()}
        </div>
    );
};

// ── IconBadge ────────────────────────────────────────────────────────────────
interface IconBadgeProps {
    icon: LucideIcon;
    color: string;
    size?: number;
}

const IconBadge = ({ icon: Icon, color, size = 26 }: IconBadgeProps) => (
    <div style={{ width: size, height: size, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: `color-mix(in srgb, ${color} 7%, transparent)` }}>
        <Icon style={{ width: size * 0.5, height: size * 0.5, color }} />
    </div>
);

// ── IntegrationLogo ──────────────────────────────────────────────────────────
// Real brand logo for an integration; falls back to a colored IconBadge.
interface IntegrationLogoProps {
    fallbackColor?: string;
    integrationType: string | null;
    size?: number;
}

const IntegrationLogo = ({ integrationType, size = 26, fallbackColor }: IntegrationLogoProps) => {
    if (!hasIntegrationIcon(integrationType)) {
        return <IconBadge icon={Globe} color={fallbackColor || '#94a3b8'} size={size} />;
    }
    const inner = size * 0.7;
    return (
        <div style={{ width: size, height: size, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
            <div style={{ width: inner, height: inner, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {getIntegrationIcon(integrationType)}
            </div>
        </div>
    );
};

// ── ModelTierBadge ───────────────────────────────────────────────────────────
// Selected model + (optional) configured tier — the non-sensitive signal shown
// in place of token counts in cloud/subscription mode. Mirrors the badge the
// Feedback panel already renders per item.
interface ModelTierBadgeProps {
    tier?: string | null;
    model: string;
}

const ModelTierBadge = ({ model, tier }: ModelTierBadgeProps) => (
    <span className="[display:inline-flex] [align-items:center] [gap:4px] [flex-wrap:wrap]">
        <span className="[display:inline-flex] [align-items:center] [gap:3px] [padding:1px_6px] [border-radius:4px] [font-size:10px] [font-weight:600] [background:var(--bg-tertiary)] [color:var(--text-secondary)]" title={model}>
            <Cpu className="w-[9px] h-[9px]" /> {shortModel(model)}
        </span>
        {tier && (
            <span className="[padding:1px_6px] [border-radius:4px] [font-size:10px] [font-weight:600] [background:#f59e0b15] [color:#f59e0b]" title={`tier: ${tier}`}>
                tier: {tier}
            </span>
        )}
    </span>
);
