import React from 'react';

import ChoiceCards from '../../../../../../shared/ChoiceCards';
import ToggleCard from '../../parts/ToggleCard';
import type { ChecksFields, TranslateFn } from './checksTypes';

/**
 * Step 4's own switch, and — while it is on — what it does when it finds
 * something and whether it also shows up when it finds nothing.
 *
 * The description stays mode-neutral: "the person sees what will be sent" is
 * true for Ask, not for Hide it or Do not send, and the modes sit right under
 * it once the check is on.
 */
export function LastCheckRow({ f, readOnly, t }: { f: ChecksFields; readOnly: boolean; t: TranslateFn }) {
    return (
        <ToggleCard
            title={t('admin.shield_dlp_preflight', 'One last check before an outside AI')}
            description={t('shield_checks.dlp_desc', 'Just before a message goes to an outside AI, it is checked once more for personal data and handled the way you choose.')}
            checked={f.dlpEnabled}
            onChange={f.setDlpEnabled}
            disabled={readOnly}
        >
            {f.dlpEnabled && (
                <div className="flex flex-col gap-3">
                    <ChoiceCards
                        appearance="radio"
                        value={f.dlpMode}
                        onChange={f.setDlpMode}
                        disabled={readOnly}
                        columns={3}
                        ariaLabel={t('admin.shield_dlp_mode', 'What to do when it finds something')}
                        options={[
                            { value: 'ask', label: t('admin.shield_dlp_mode_ask_short', 'Ask'), description: t('admin.shield_dlp_mode_ask_desc', 'Show what was found and let the person choose: hide it, send anyway, or cancel.') },
                            { value: 'auto_redact', label: t('admin.shield_dlp_mode_redact_short', 'Hide it'), description: t('admin.shield_dlp_mode_redact_desc', 'Hide what was found and send the message. Nobody is interrupted.') },
                            { value: 'block', label: t('admin.shield_dlp_mode_block_short', 'Do not send'), description: t('admin.shield_dlp_mode_block_desc', 'Stop the message and ask the person to take the personal data out first.') },
                        ]}
                    />
                    <label className="flex items-start gap-2.5 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={f.dlpAlwaysReview}
                            onChange={e => f.setDlpAlwaysReview(e.target.checked)}
                            disabled={readOnly}
                            className="mt-0.5 w-3.5 h-3.5 rounded shrink-0 accent-[var(--text-primary)]"
                        />
                        <span>
                            <span className="block text-[13px] font-medium text-[var(--text-primary)]">
                                {t('admin.shield_dlp_always_review', 'Always show this check, even when nothing is found')}
                            </span>
                            <span className="block text-xs leading-[17px] text-[var(--text-secondary)]">
                                {t('admin.shield_dlp_always_review_desc', 'Detection is never perfect. With this on, the person also gets a chance to mark something themselves on messages the check found nothing in.')}
                            </span>
                        </span>
                    </label>
                </div>
            )}
        </ToggleCard>
    );
}

export default LastCheckRow;
