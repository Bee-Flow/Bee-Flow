import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import Button from '../../../../../shared/Button';
import { isSwitchable, type SettingsPart } from './stageSettingsModel';

/**
 * The parts deployed to this stage, each on or off (design 4.3).
 *
 * Switching goes through the same code as the part's own screen, so its gates
 * still run: an automation that cannot go live says why, inline, on ITS row, and a
 * part that was never deployed answers `managed_part_not_deployed`. "Pause
 * stage" switches every automation off and remembers which were on; "Resume" puts
 * exactly that set back, and says so when some would not come back.
 */

export interface PartsSectionProps {
    parts: SettingsPart[];
    canOperate: boolean;
    /** Pause and resume also belong to an organisation admin (recovery). */
    canPause: boolean;
    isOwner: boolean;
    paused: boolean;
    newPartsActive: boolean;
    busy: Record<string, boolean>;
    errors: Record<string, string>;
    stageBusy: boolean;
    pauseNotice: string | null;
    onSwitch: (ref: string, active: boolean) => void;
    onPause: (pause: boolean) => void;
    onNewPartsActive: (value: boolean) => void;
}

export default function PartsSection(p: PartsSectionProps) {
    const { t } = useTranslation();
    const live = p.parts.filter(x => !x.retired);
    const retired = p.parts.length - live.length;
    const kindName = (kind: string) => ({
        automation: t('stage_settings.kind_automation', 'Automation'), app: t('stage_settings.kind_app', 'App'), webpage: t('stage_settings.kind_webpage', 'Page'),
        agent: t('stage_settings.kind_agent', 'Agent'), datatable: t('stage_settings.kind_datatable', 'Table'), knowledge_base: t('stage_settings.kind_kb', 'Knowledge base'),
        skill: t('stage_settings.kind_skill', 'Skill'), document: t('stage_settings.kind_document', 'Document'),
    } as Record<string, string>)[kind] || kind;

    return (
        <div className="space-y-3" data-testid="settings-parts">
            {live.length === 0 ? (
                <p className="text-sm text-[var(--text-tertiary)]" data-testid="parts-none">
                    {t('stage_settings.parts_none', 'Nothing is deployed to this stage yet, so there is nothing to switch.')}
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {live.map(part => {
                        const switchable = isSwitchable(part.kind);
                        const error = p.errors[part.ref];
                        return (
                            <li key={part.ref} className="rounded-lg px-3 py-2 bg-[var(--bg-secondary)]" data-testid={`part-${part.ref}`}>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm text-[var(--text-primary)] flex-1 min-w-0 truncate">{part.name || part.ref}</span>
                                    <span className="text-[11px] text-[var(--text-tertiary)]">{kindName(part.kind)}</span>
                                    {part.drift && (
                                        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--warning)]" data-testid={`part-drift-${part.ref}`}>
                                            <AlertTriangle className="w-3 h-3" aria-hidden="true" />{t('stage_settings.part_drift', 'Changed here since the last deploy')}
                                        </span>
                                    )}
                                    {switchable ? (
                                        p.canOperate ? (
                                            <Button
                                                size="sm" variant={part.active ? 'secondary' : 'primary'} busy={!!p.busy[part.ref]}
                                                aria-pressed={part.active === true} data-testid={`part-switch-${part.ref}`}
                                                onClick={() => p.onSwitch(part.ref, part.active !== true)}
                                            >
                                                {part.active === true ? t('stage_settings.part_switch_off', 'Switch off') : t('stage_settings.part_switch_on', 'Switch on')}
                                            </Button>
                                        ) : (
                                            <span className="text-xs text-[var(--text-secondary)]">
                                                {part.active === true ? t('stage_settings.part_on', 'On') : part.active === false ? t('stage_settings.part_off', 'Off') : t('stage_settings.part_unknown', 'Unknown')}
                                            </span>
                                        )
                                    ) : (
                                        <span className="text-xs text-[var(--text-tertiary)]">{t('stage_settings.part_no_switch', 'No switch')}</span>
                                    )}
                                </div>
                                {error && <p className="mt-1 text-xs text-[var(--error)]" data-testid={`part-error-${part.ref}`} role="alert">{error}</p>}
                            </li>
                        );
                    })}
                </ul>
            )}
            {retired > 0 && (
                <p className="text-xs text-[var(--text-tertiary)]">{t('stage_settings.parts_retired', '{n} retired part(s) are kept but not shown.', { n: retired })}</p>
            )}
            {p.canPause && (
                <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" variant="secondary" busy={p.stageBusy} onClick={() => p.onPause(!p.paused)} data-testid="stage-pause">
                        {p.paused ? t('stage_settings.resume', 'Resume stage') : t('stage_settings.pause', 'Pause stage')}
                    </Button>
                    {p.paused && <span className="text-xs text-[var(--text-secondary)]" data-testid="stage-paused">{t('stage_settings.paused_note', 'Paused. Resume switches back on what was on before.')}</span>}
                </div>
            )}
            {p.pauseNotice && <p className="text-xs text-[var(--warning)]" role="alert" data-testid="pause-notice">{p.pauseNotice}</p>}
            {p.isOwner && (
                <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <input type="checkbox" className="mt-0.5" checked={p.newPartsActive} onChange={(e) => p.onNewPartsActive(e.target.checked)} data-testid="new-parts-active" />
                    <span>
                        {t('stage_settings.new_parts_active', 'New parts arrive switched on')}
                        <span className="block text-xs text-[var(--text-tertiary)]">{t('stage_settings.new_parts_hint', 'When off, a part added by a new release waits for you to switch it on.')}</span>
                    </span>
                </label>
            )}
        </div>
    );
}
