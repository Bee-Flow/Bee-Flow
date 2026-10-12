import React from 'react';

import ChoiceCards, { type ChoiceCardOption } from '../../../../../../shared/ChoiceCards';
import ToggleCard from '../../parts/ToggleCard';
import { CheckCard } from './CheckCard';
import type { ChecksFields, ChecksLicence, TranslateFn } from './checksTypes';

/**
 * Step 3: what happens to EVERY message in which personal data is found,
 * whichever AI it is going to — plus the places the same check also runs.
 */

function actionOptions(licence: ChecksLicence, t: TranslateFn): ChoiceCardOption<string>[] {
    const locked = !licence.canTokenizePii;
    // Both cards are ALWAYS rendered. Hiding the placeholder card on a plan
    // that does not include it produced the worst possible state: an
    // organisation whose stored action is `tokenize` (the server deliberately
    // does not clamp it) saw NO card selected and no explanation of why.
    // Disabled + still checked + a sentence is the honest version.
    return [
        {
            value: 'tokenize',
            label: t('dlp.action_tokenize_label', 'Replace with placeholders'),
            description: (
                <>
                    {t('shield_checks.tokenize_desc_lead', 'The AI sees')}{' '}
                    <span className="font-mono">{t('shield_checks.tokenize_desc_example', 'email_1')}</span>{' '}
                    {t('shield_checks.tokenize_desc_tail', 'instead of the address. Bee Flow puts the real value back in the answer.')}
                </>
            ),
            disabled: locked,
            badge: locked ? t('license.enterprise', 'Enterprise') : undefined,
            lockedNotice: locked ? (
                <>
                    {t('dlp.action_tokenize_locked', 'Replacing with placeholders is an Enterprise feature.')}{' '}
                    <a
                        href={licence.upgradeUrl || 'https://beeflow.nl/pricing'}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--info-ink)] hover:underline"
                    >
                        {t('license.upgrade_at_beeflow', 'Upgrade at beeflow.nl')}
                    </a>
                </>
            ) : undefined,
        },
        {
            value: 'block',
            label: t('dlp.action_block_label', 'Do not send the message'),
            description: t('dlp.action_block_help', 'The message is stopped before it reaches the AI, and the person is asked to rewrite it without the personal data.'),
        },
    ];
}

export function EveryMessageCard({
    f, readOnly, licence, t,
}: {
    f: ChecksFields;
    readOnly: boolean;
    licence: ChecksLicence;
    t: TranslateFn;
}) {
    const placeholders = f.piiAction === 'tokenize';
    return (
        <CheckCard
            n={3}
            title={t('shield_checks.every_title', 'On every message')}
            subtitle={t('shield_checks.every_sub', 'always on · runs for every AI, inside or outside')}
        >
            <div className="px-[18px] py-3.5 flex flex-col gap-2.5">
                <h4 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('shield_checks.action_heading', 'When we find personal data')}
                </h4>
                <ChoiceCards
                    appearance="radio"
                    value={f.piiAction}
                    onChange={f.setPiiAction}
                    options={actionOptions(licence, t)}
                    disabled={readOnly}
                    ariaLabel={t('admin.pii_action_on_detection', 'What happens when we find personal data')}
                />
                {placeholders && !licence.canTokenizePii && (
                    <p className="m-0 text-xs leading-[17px] text-[var(--warning-ink)]">
                        {t('admin.shield_action_unlicensed_note',
                            'Placeholders are saved for this organisation, but your plan does not include them — messages are stopped instead, until you upgrade or choose “Do not send the message”.')}
                    </p>
                )}
            </div>

            {/* Only meaningful with placeholders: without them there is no
                "version the AI got" to show, and the save forces it off. */}
            {placeholders && (
                <ToggleCard
                    title={t('admin.shield_raw_payload_title', 'Let people see what was sent to the AI')}
                    description={t('shield_checks.raw_payload_desc', 'Adds the original, the version the AI got and the placeholders to "How I got this answer".')}
                    note={t('shield_checks.raw_payload_warn', 'Anyone who can open the conversation can reveal the real values.')}
                    checked={f.showRawPayload}
                    onChange={f.setShowRawPayload}
                    disabled={readOnly}
                />
            )}
            <ToggleCard
                title={t('admin.shield_scan_kbs', 'Also check knowledge bases when documents are added')}
                description={t('shield_checks.scan_kbs_desc', 'Personal data is replaced before it is stored. This can\'t be undone later: the stored text is the checked text.')}
                checked={f.scanKnowledgeBases}
                onChange={f.setScanKnowledgeBases}
                disabled={readOnly}
            />
            <ToggleCard
                title={t('admin.shield_apply_automations', 'Also protect automations')}
                description={t('shield_checks.automations_desc', 'Automations run on their own with nobody watching. Their data and AI steps are checked the same way as chat.')}
                checked={f.applyToAutomations}
                onChange={f.setApplyToAutomations}
                disabled={readOnly}
            />
        </CheckCard>
    );
}

export default EveryMessageCard;
