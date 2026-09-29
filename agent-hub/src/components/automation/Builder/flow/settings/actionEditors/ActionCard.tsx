import { Check, Wrench } from 'lucide-react';
import { useRef, useState, type ComponentType } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../../../shared/AnchoredMenu';
import { humanizeToolName } from '../../displayHelpers';
import { ProblemNote } from '../../../mapping/toolInput/ParamExtras';
import IntegrationLogoJs from '../../nodes/IntegrationLogo';

/**
 * The action as a readable card (round 4, artboard 4a): "Nextcloud · Read
 * file", "Choose another Nextcloud action", Switch. It replaced the Operation
 * <select>: the operation is the one thing about the step a person reads
 * first, and a dropdown hid it behind form chrome. Switch lists the app's
 * other actions; the inputs both share are kept (onSwitch decides that).
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
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)]" data-testid="action-card">
            <span className="shrink-0 w-[30px] h-[30px] rounded-lg grid place-items-center border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)]">
                {tool ? <IntegrationLogo tool={tool} size={15} fallback={<Wrench size={15} />} /> : <Wrench size={15} />}
            </span>
            <div className="min-w-0">
                <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate" title={tool || undefined}>{title}</div>
                {canSwitch && (
                    <div className="text-[11px] text-[var(--text-tertiary)] truncate">
                        {appLabel
                            ? t('routines.ndv.action_other', 'Choose another {app} action', { app: appLabel })
                            : t('routines.ndv.action_other_generic', 'Choose another action of this app')}
                    </div>
                )}
            </div>
            {canSwitch && (
                <>
                    <button
                        ref={anchorRef}
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        className="ml-auto shrink-0 px-2.5 py-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        {t('routines.ndv.action_switch', 'Switch')}
                    </button>
                    <AnchoredMenu
                        open={open}
                        onClose={() => setOpen(false)}
                        anchorRef={anchorRef}
                        align="right"
                        minWidth={240}
                        maxHeight={320}
                        role="menu"
                        aria-label={t('routines.ndv.action_switch_menu', 'Actions of this app')}
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
