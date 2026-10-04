/**
 * "What happens" — the gate every message passes: replace or stop, whether
 * people may see what was sent, and what it also covers. The web shows this
 * and "Leaving your org" side by side; a phone shows one at a time.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner, Group, GroupedScroll, OptionRow, ToggleRow } from '@/shared/ui';

import type { Lock } from '../hooks/useShieldLicence';
import type { FailureMode, ShieldFields } from '../model/types';

export function ProcessingPane({
    fields,
    set,
    tokenize,
}: {
    fields: ShieldFields;
    set: (changes: Partial<ShieldFields>) => void;
    tokenize: Lock;
}) {
    const t = useTranslation();
    const failureModes: { id: FailureMode; label: string; description: string }[] = [
        {
            id: 'fail_closed',
            label: t('mobile.orgShield.fail_closed', 'Refuse to send'),
            description: t('mobile.orgShield.fail_closed_desc', 'If the detector is installed but unreachable, nothing goes to the model. Safe by default.'),
        },
        {
            id: 'fail_open',
            label: t('mobile.orgShield.fail_open', 'Send anyway'),
            description: t('mobile.orgShield.fail_open_desc', 'Messages go through unchecked while the detector is down. Convenient, and a real risk.'),
        },
    ];
    return (
        <GroupedScroll>
            {fields.piiAction === 'tokenize' && !tokenize.open ? (
                <Banner tone="warning">
                    {t('admin.shield_action_unlicensed_note', 'Placeholders are saved for this organisation, but your plan does not include them — messages are stopped instead, until you upgrade or choose “Do not send the message”.')}
                </Banner>
            ) : null}
            <Group title={t('admin.pii_action_on_detection', 'What happens when we find personal data')}>
                <OptionRow
                    label={t('dlp.action_tokenize_label', 'Replace with placeholders')}
                    description={tokenize.hint ?? t('dlp.action_tokenize_help_short', 'Sensitive details are swapped for labels like [email_1] before the message goes to the AI. The AI never sees the real values, and Bee Flow puts them back in the answer.')}
                    selected={fields.piiAction === 'tokenize'}
                    disabled={!tokenize.open}
                    onPress={() => set({ piiAction: 'tokenize' })}
                    testID="action-tokenize"
                />
                <OptionRow
                    label={t('dlp.action_block_label', 'Do not send the message')}
                    description={t('dlp.action_block_help', 'The message is stopped before it reaches the AI, and the person is asked to rewrite it without the personal data.')}
                    selected={fields.piiAction === 'block'}
                    onPress={() => set({ piiAction: 'block' })}
                    testID="action-block"
                />
            </Group>
            <Group>
                {fields.piiAction === 'tokenize' ? (
                    <ToggleRow
                        label={t('admin.shield_raw_payload_title', 'Let people see what was sent to the AI')}
                        description={t('admin.shield_raw_payload_desc', 'Adds a section to the “How I got this answer” panel: the original message, the version that went to the AI, the AI\'s reply, and which placeholder stood for which value. Real values only appear on click, and anyone who can open the conversation can see them.')}
                        value={fields.showRawPayload}
                        onValueChange={(showRawPayload) => set({ showRawPayload })}
                        testID="raw-payload"
                    />
                ) : null}
                <ToggleRow
                    label={t('admin.shield_scan_kbs', 'Also check knowledge bases when documents are added')}
                    description={t('admin.shield_scan_kbs_desc', 'A knowledge base keeps its documents and quotes them to whoever asks — including people who never saw the original file. Checking at the moment a document is added means personal data is replaced BEFORE it is stored, so the AI knows the terms and not the customer. It cannot be undone afterwards: the stored text is the checked text.')}
                    value={fields.scanKnowledgeBases}
                    onValueChange={(scanKnowledgeBases) => set({ scanKnowledgeBases })}
                    testID="scan-kbs"
                />
                <ToggleRow
                    label={t('admin.shield_apply_automations', 'Also protect automations')}
                    description={t('admin.shield_apply_automations_desc', 'Automations run on their own, with nobody watching. Check their data and their AI steps the same way as chat. (Activity logging keeps running either way.)')}
                    value={fields.applyToAutomations}
                    onValueChange={(applyToAutomations) => set({ applyToAutomations })}
                    testID="apply-automations"
                />
            </Group>
            <Group title={t('mobile.orgShield.failure_title', 'If the detector is down')}>
                {failureModes.map((mode) => (
                    <OptionRow
                        key={mode.id}
                        label={mode.label}
                        description={mode.description}
                        selected={fields.piiFailureMode === mode.id}
                        onPress={() => set({ piiFailureMode: mode.id })}
                        testID={`failure-${mode.id}`}
                    />
                ))}
            </Group>
        </GroupedScroll>
    );
}
