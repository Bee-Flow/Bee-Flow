import { AlertTriangle, Bug, Check, Download, Globe, Inbox, Loader2, Mic, Package, Shield, Target, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { AdminModule, ModuleCapability, ModuleRequirement } from '@/api/queries/modules.types';
import { CHIP_SUCCESS, CHIP_WARNING, DOT_LIVE, DOT_WARN, PRIMARY_BTN, SECONDARY_BTN } from '@/components/shared/adminUi';

interface ModuleCardProps {
    module: AdminModule;
    onImport: (module: AdminModule) => void;
    onRemoveRequest: (module: AdminModule) => void;
    busy?: boolean;
}

// module.icon arrives as a free-form string: an emoji, a lucide name from the
// server catalog (e.g. 'shield' for Security Scan), or something we may not
// know. Render short pictographic strings as-is, map known lucide names, and
// fall back to Package so an unrecognised icon never breaks the card.
const NAMED_ICONS: Record<string, LucideIcon> = { shield: Shield, globe: Globe, inbox: Inbox, target: Target, mic: Mic, bug: Bug, package: Package };

function ModuleIcon({ icon }: { icon?: string | null }) {
    if (icon && icon.length <= 4 && /\p{Extended_Pictographic}/u.test(icon)) {
        return <span className="text-2xl leading-none">{icon}</span>;
    }
    const Glyph = NAMED_ICONS[String(icon || '').toLowerCase()] || Package;
    return <Glyph className="w-6 h-6 text-[var(--text-muted)]" />;
}

export default function ModuleCard({ module, onImport, onRemoveRequest, busy }: ModuleCardProps) {
    const { t } = useTranslation();
    const imported = module.status === 'imported';
    const requirements = module.requirements || [];
    const capabilities = module.capabilities || [];

    return (
        <div className="rounded-xl border p-4 transition-all hover:shadow-lg relative flex flex-col bg-[var(--bg-secondary)] border-[var(--border-default)]">
            {/* Status badge */}
            {imported ? (
                <div className="absolute top-3 right-3">
                    <span className={CHIP_SUCCESS}>
                        <Check className="w-3 h-3" /> {t('modules.badge_imported')}
                    </span>
                </div>
            ) : !module.requirementsMet ? (
                <div className="absolute top-3 right-3">
                    <span className={CHIP_WARNING}>
                        <AlertTriangle className="w-3 h-3" /> {t('modules.badge_requirements_unmet')}
                    </span>
                </div>
            ) : null}

            {/* Icon + name + category */}
            <div className="flex items-start gap-3 mb-2 pr-24">
                <ModuleIcon icon={module.icon} />
                <div className="min-w-0">
                    <h4 className="text-sm font-semibold truncate text-[var(--text-primary)]">
                        {module.name}
                    </h4>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        {module.category && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                                {module.category}
                            </span>
                        )}
                        {module.version && (
                            <span className="text-xs text-[var(--text-muted)]">v{module.version}</span>
                        )}
                    </div>
                </div>
            </div>

            {/* Description */}
            <p className="text-xs leading-relaxed mb-3 text-[var(--text-secondary)]">
                {module.description}
            </p>

            {/* Requirements */}
            {requirements.length > 0 && (
                <div className="mb-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide mb-1 text-[var(--text-muted)]">
                        {t('modules.requirements')}
                    </div>
                    <div className="space-y-1">
                        {requirements.map((req: ModuleRequirement) => (
                            <div key={req.id} className="text-xs flex items-start gap-1.5 text-[var(--text-secondary)]">
                                <span className={`${req.met ? DOT_LIVE : DOT_WARN} mt-1.5`} />
                                <span className="min-w-0">
                                    {req.label}
                                    {!req.met && req.detail && (
                                        <span className="block text-[var(--text-muted)]">{req.detail}</span>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Capabilities */}
            {capabilities.length > 0 && (
                <div className="mb-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide mb-1 text-[var(--text-muted)]">
                        {t('modules.capabilities')}
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {capabilities.map((cap: ModuleCapability) => (
                            <span key={cap.id} className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                                {cap.label}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* Footer */}
            <div className="mt-auto pt-1">
                {imported ? (
                    <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--success-ink)]">
                            <span className={DOT_LIVE} /> {t('modules.active', 'Active')}
                        </span>
                        <div className="flex-1" />
                        <button
                            onClick={() => onRemoveRequest(module)}
                            disabled={busy}
                            className="p-1.5 rounded-lg text-[var(--error-ink)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] transition-colors disabled:opacity-50"
                            title={t('modules.remove')}
                            aria-label={t('modules.remove')}
                        >
                            {busy
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                    </div>
                ) : module.requirementsMet ? (
                    <button
                        onClick={() => onImport(module)}
                        disabled={busy}
                        className={`${PRIMARY_BTN} w-full`}
                    >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        {busy ? t('modules.importing') : t('modules.import')}
                    </button>
                ) : (
                    <>
                        <button
                            disabled
                            className={`${SECONDARY_BTN} w-full`}
                        >
                            <Download className="w-3.5 h-3.5" /> {t('modules.import')}
                        </button>
                        <p className="text-xs mt-1.5 flex items-center gap-1 text-[var(--warning-ink)]">
                            <AlertTriangle className="w-3 h-3 flex-shrink-0" /> {t('modules.requirements_blocked')}
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
