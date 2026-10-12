import { Check, ChevronDown, Wrench } from 'lucide-react';
import { useRef, useState, type ComponentType } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../../../shared/AnchoredMenu';
import { humanizeToolName } from '../../displayHelpers';
import { ProblemNote } from '../../../mapping/toolInput/ParamExtras';
import IntegrationLogoJs from '../../nodes/IntegrationLogo';

/**
 * The action as one quiet line: the app's logo, "Nextcloud · Read file" and a
 * small "Switch" that lists the app's other actions (the inputs both share are
 * kept; onSwitch decides that). It replaced the Operation <select> — the
 * operation is what a person reads first — and was a full card with a second
 * line of help until it took more room than the inputs below it.
 */
export interface ActionOption { name: string; label?: string; description?: string }

const humanize = humanizeToolName as (name: string) => string;
// Untyped JS components; their props are checked there.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;
const IntegrationLogo = IntegrationLogoJs as unknown as ComponentType<Record<string, unknown>>;

export default function ActionCard({ tool, appLabel, action, siblings, onSwitch, problem = null }: {
    tool: string | null;
    appLabel: string | null;
    action: ActionOption | null;
    siblings: ActionOption[];
    onSwitch: (name: string) => void;
    /**
     * The last run failed on the action itself or on the account it runs as
     * (errorInfo.settingKey 'tool' or 'connection'): the card carries the red
     * ring, the same way a setting does (artboard 4a).
     */
    problem?: string | null;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const actionLabel = action?.label || (tool ? humanize(tool) : '—');
    const title = appLabel ? `${appLabel} · ${actionLabel}` : actionLabel;
    const canSwitch = siblings.length > 1;
    return (
        <div
            data-problem={problem ? 'true' : undefined}
            className={problem
                ? 'space-y-1.5 rounded-xl p-1.5 -m-1.5 border-[1.5px] border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_5%,transparent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--error)_14%,transparent)]'
                : undefined}
        >
        <div className="flex items-center gap-2 min-w-0" data-testid="action-card">
            <span className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true">
                {tool ? <IntegrationLogo tool={tool} size={14} fallback={<Wrench size={14} />} /> : <Wrench size={14} />}
            </span>
            <div className="min-w-0 text-[12px] font-medium text-[var(--text-primary)] truncate" title={tool || undefined}>{title}</div>
            {canSwitch && (
                <>
                    <button
                        ref={anchorRef}
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        title={appLabel
                            ? t('automations.ndv.action_other', 'Choose another {app} action', { app: appLabel })
                            : t('automations.ndv.action_other_generic', 'Choose another action of this app')}
                        className="shrink-0 inline-flex items-center gap-0.5 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        {t('automations.ndv.action_switch', 'Switch')}
                        <ChevronDown size={11} />
                    </button>
                    <AnchoredMenu
                        open={open}
                        onClose={() => setOpen(false)}
                        anchorRef={anchorRef}
                        align="right"
                        minWidth={240}
                        maxHeight={320}
                        role="menu"
                        aria-label={t('automations.ndv.action_switch_menu', 'Actions of this app')}
                        className="p-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg overflow-y-auto"
                    >
                        {siblings.map(a => (
                            <button
                                key={a.name}
                                type="button"
                                role="menuitemradio"
                                aria-checked={a.name === tool}
                                onClick={() => { setOpen(false); if (a.name !== tool) onSwitch(a.name); }}
                                title={a.description || undefined}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                            >
                                <span className="w-3.5 shrink-0">{a.name === tool && <Check size={13} />}</span>
                                <span className="truncate">{a.label || humanize(a.name)}</span>
                            </button>
                        ))}
                    </AnchoredMenu>
                </>
            )}
        </div>
        {problem && <ProblemNote text={problem} />}
        </div>
    );
}
