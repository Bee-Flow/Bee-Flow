import { ShieldCheck, ShieldOff } from 'lucide-react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import Toggle from '../../../../../shared/Toggle';

interface Props {
    enabled: boolean;
    onChange: (next: boolean) => void;
    readOnly?: boolean;
    t: TranslateFn;
}

const SWITCH_ID = 'org-shield-enable';

/**
 * The one switch the Overview owns: the shield on or off for everyone.
 *
 * The title is a <label> for the switch, so clicking the words toggles it
 * like clicking the track does. The switch keeps its own aria-label (the same
 * words), because a label that only wrapped the track once left screen
 * readers announcing an anonymous checkbox.
 */
export default function MasterSwitch({ enabled, onChange, readOnly = false, t }: Props) {
    const Icon = enabled ? ShieldCheck : ShieldOff;
    return (
        <div className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-[var(--shadow-sm)] px-[18px] py-3.5 flex items-center gap-3.5">
            <span
                aria-hidden="true"
                className={enabled
                    ? 'w-9 h-9 rounded-[10px] grid place-items-center shrink-0 bg-[color-mix(in_srgb,var(--success-ink)_12%,transparent)] text-[var(--success-ink)]'
                    : 'w-9 h-9 rounded-[10px] grid place-items-center shrink-0 bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'}
            >
                <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
            </span>
            <div className="flex-1 min-w-0">
                <label
                    htmlFor={SWITCH_ID}
                    className={readOnly
                        ? 'block text-sm font-semibold text-[var(--text-primary)]'
                        : 'block text-sm font-semibold text-[var(--text-primary)] cursor-pointer'}
                >
                    {t('admin.shield_enable')}
                </label>
                <p className="m-0 text-xs text-[var(--text-secondary)]">
                    {t('admin.shield_enable_desc_strong',
                        'Applies to every chat and every agent in this organisation. Off means nothing is checked, at all.')}
                </p>
            </div>
            <span
                aria-hidden="true"
                className={enabled
                    ? 'text-xs font-semibold text-[var(--success-ink)]'
                    : 'text-xs font-semibold text-[var(--text-tertiary)]'}
            >
                {enabled ? t('common.on', 'On') : t('common.off', 'Off')}
            </span>
            <Toggle
                id={SWITCH_ID}
                checked={enabled}
                onChange={onChange}
                disabled={readOnly}
                ariaLabel={t('admin.shield_enable')}
                className="shrink-0 flex"
            />
        </div>
    );
}
