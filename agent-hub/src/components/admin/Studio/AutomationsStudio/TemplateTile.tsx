import { Sparkles } from 'lucide-react';
import { useId } from 'react';
import type { ComponentType } from 'react';
import type { TemplateCard } from '../../../../api/queries/automation/templates';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import AppIconJs from '../../../icons/AppIcon';

// A .jsx module; its inferred props do not know `size`/`className`.
const AppIcon = AppIconJs as unknown as ComponentType<Record<string, unknown>>;

// Template icon names route through AppIcon, which resolves registry icons
// synchronously and lazy-loads the full Lucide set for the rest (a wildcard
// Lucide import here once welded all ~1,900 icons into this chunk; see
// components/iconRegistry.js). Cached per name: a fresh wrapper per render
// would be a new component type every time, so React would remount the icon.
type IconCmp = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' }>;
const iconCache = new Map<string, IconCmp>();
function pickIcon(name: string | null): IconCmp {
    if (!name) return Sparkles;
    let cmp = iconCache.get(name);
    if (!cmp) {
        const Wrapped: IconCmp = (props) => <AppIcon name={name} fallback={Sparkles} {...props} />;
        Wrapped.displayName = `TemplateIcon(${name})`;
        iconCache.set(name, Wrapped);
        cmp = Wrapped;
    }
    return cmp;
}

/** "nextcloud" → "Nextcloud", "google-drive" → "Google Drive". */
export function appName(id: string): string {
    return id.split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** "Starts on a schedule · 4 steps": how a template begins, in plain words. */
export function startsLine(tmpl: TemplateCard, t: TranslateFn): string {
    const parts: string[] = [];
    switch (tmpl.triggerKind) {
        case null: break;
        case 'schedule': parts.push(t('automations.templates.startsSchedule', 'Starts on a schedule')); break;
        case 'manual': parts.push(t('automations.templates.startsManual', 'Starts when you run it')); break;
        case 'webhook': parts.push(t('automations.templates.startsWebhook', 'Starts from a webhook')); break;
        case 'app_event':
            parts.push(tmpl.triggerApp
                ? t('automations.templates.startsApp', 'Starts when something happens in {app}', { app: appName(tmpl.triggerApp) })
                : t('automations.templates.startsAnyApp', 'Starts when something happens in an app'));
            break;
        default: parts.push(t('automations.templates.startsOther', 'Starts with a trigger you choose'));
    }
    if (tmpl.stepCount === 1) parts.push(t('automations.templates.oneStep', '1 step'));
    else if (tmpl.stepCount) parts.push(t('automations.templates.steps', '{count} steps', { count: tmpl.stepCount }));
    if (tmpl.triggerReadiness === 'push-pending') parts.push(t('automations.templates.needsConnector', 'needs the Bee Flow connector'));
    return parts.join(' · ');
}

/** "Saved by Anne de Vries · 2d ago", for an organisation's own template. */
export function savedLine(tmpl: TemplateCard, t: TranslateFn, when: string): string {
    const who = tmpl.mine
        ? t('automations.templates.savedByYou', 'Saved by you')
        : tmpl.createdByName
            ? t('automations.templates.savedBy', 'Saved by {name}', { name: tmpl.createdByName })
            : t('automations.templates.savedByColleague', 'Saved by a colleague');
    return when ? `${who} · ${when}` : who;
}

/**
 * One template as a compact card (handoff 5 language): an icon tile in the
 * automation colour, the title, one sentence, a quiet "starts with" line and
 * one primary "Use template".
 */
export default function TemplateTile({ tmpl, busy = false, disabled = false, onUse }: {
    tmpl: TemplateCard;
    busy?: boolean;
    disabled?: boolean;
    onUse: (tmpl: TemplateCard) => void;
}) {
    const { t } = useTranslation();
    const relative = useRelativeTime();
    const titleId = useId();
    const Icon = pickIcon(tmpl.icon);
    const starts = startsLine(tmpl, t);
    const saved = tmpl.source === 'org' ? savedLine(tmpl, t, relative(tmpl.createdAt)) : null;
    return (
        <div
            className="flex flex-col gap-3 p-3.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]"
            data-testid="template-card"
            data-source={tmpl.source}
        >
            <div className="flex items-start gap-3">
                <span className="w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 bg-[color-mix(in_srgb,var(--type-trigger)_14%,transparent)] text-[var(--type-trigger)]">
                    <Icon size={15} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                    <h4 id={titleId} className="m-0 text-[13px] font-semibold leading-snug text-[var(--text-primary)]">{tmpl.title}</h4>
                    {tmpl.description && (
                        <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)] line-clamp-2">{tmpl.description}</p>
                    )}
                </div>
            </div>
            <div className="mt-auto flex items-end gap-3">
                <div className="flex-1 min-w-0 text-[11px] leading-snug text-[var(--text-tertiary)]">
                    {starts && <div className="truncate" title={starts}>{starts}</div>}
                    {saved && <div className="truncate" title={saved}>{saved}</div>}
                </div>
                <button
                    type="button"
                    onClick={() => onUse(tmpl)}
                    disabled={disabled}
                    aria-describedby={titleId}
                    className="flex-shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {busy ? t('automations.templates.opening', 'Opening…') : t('automations.templates.use', 'Use template')}
                </button>
            </div>
        </div>
    );
}
