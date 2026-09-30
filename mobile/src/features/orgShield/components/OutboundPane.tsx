/**
 * "Leaving your org" — the last look before an AI outside the organisation,
 * EU-only models, web searches and connected-app traffic. The EU and web
 * search cards only appear when the installation has EU models or a search
 * provider, as on the web.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, GroupedScroll, OptionRow, ToggleRow } from '@/shared/ui';

import type { Lock } from '../hooks/useShieldLicence';
import type { DlpMode, ShieldEnv, ShieldFields } from '../model/types';

function DlpGroup({ fields, set }: { fields: ShieldFields; set: (changes: Partial<ShieldFields>) => void }) {
    const t = useTranslation();
    const modes: { id: DlpMode; label: string; description: string }[] = [
        { id: 'ask', label: t('admin.shield_dlp_mode_ask_short', 'Ask'), description: t('admin.shield_dlp_mode_ask_desc', 'Show what was found and let the person choose: hide it, send anyway, or cancel.') },
        { id: 'auto_redact', label: t('admin.shield_dlp_mode_redact_short', 'Hide it'), description: t('admin.shield_dlp_mode_redact_desc', 'Hide what was found and send the message. Nobody is interrupted.') },
        { id: 'block', label: t('admin.shield_dlp_mode_block_short', 'Do not send'), description: t('admin.shield_dlp_mode_block_desc', 'Stop the message and ask the person to take the personal data out first.') },
    ];
    return (
        <Group title={t('admin.shield_step_external_only', 'only for an AI outside your organisation')}>
            <ToggleRow
                label={t('admin.shield_dlp_preflight', 'One last check before an outside AI')}
                description={t('admin.shield_dlp_preflight_desc', 'Some AI models run outside your organisation. Just before a message goes to one of those, check it once more for personal data and handle it as chosen below.')}
                value={fields.dlpEnabled}
                onValueChange={(dlpEnabled) => set({ dlpEnabled })}
                testID="dlp-enabled"
            />
            {fields.dlpEnabled
                ? modes.map((mode) => (
                      <OptionRow
                          key={mode.id}
                          label={mode.label}
                          description={mode.description}
                          selected={fields.dlpMode === mode.id}
                          onPress={() => set({ dlpMode: mode.id })}
                          testID={`dlp-${mode.id}`}
                      />
                  ))
                : null}
            {fields.dlpEnabled ? (
                <ToggleRow
                    label={t('admin.shield_dlp_always_review', 'Always show this check, even when nothing is found')}
                    description={t('admin.shield_dlp_always_review_desc', 'Detection is never perfect. With this on, the person also gets a chance to mark something themselves on messages the check found nothing in.')}
                    value={fields.dlpAlwaysReview}
                    onValueChange={(dlpAlwaysReview) => set({ dlpAlwaysReview })}
                    testID="dlp-always-review"
                />
            ) : null}
        </Group>
    );
}

export function OutboundPane({
    fields,
    set,
    env,
    webGuard,
}: {
    fields: ShieldFields;
    set: (changes: Partial<ShieldFields>) => void;
    env: ShieldEnv;
    webGuard: Lock;
}) {
    const t = useTranslation();
    return (
        <GroupedScroll>
            <DlpGroup fields={fields} set={set} />
            <Group>
                {env.hasEuModelsConfigured ? (
                    <ToggleRow
                        label={t('admin.shield_eu_models', 'Use only AI hosted in the EU')}
                        description={t('admin.shield_eu_desc', 'Send chats only to the AI models hosted in the EU. Set those up under AI Config → Chat Models.')}
                        value={fields.euModeEnabled}
                        onValueChange={(euModeEnabled) => set({ euModeEnabled })}
                        testID="eu-mode"
                    />
                ) : null}
                {env.hasWebSearchEnabled ? (
                    <ToggleRow
                        label={t('admin.shield_web_guard', 'Protect web searches')}
                        description={webGuard.hint ?? t('admin.shield_web_guard_desc', 'Stop search terms that contain personal data from being sent to an outside search engine.')}
                        value={fields.webSearchGuard}
                        disabled={!webGuard.open}
                        onValueChange={(webSearchGuard) => set({ webSearchGuard })}
                        testID="web-guard"
                    />
                ) : null}
                {env.hasWebSearchEnabled ? (
                    <ToggleRow
                        label={t('admin.shield_search_upload', 'No web search while a file is attached')}
                        description={t('admin.shield_search_upload_desc', 'When someone attaches a document, do not let the AI search the web — so nothing from that document can end up in a search box.')}
                        value={fields.disableSearchOnUpload}
                        onValueChange={(disableSearchOnUpload) => set({ disableSearchOnUpload })}
                        testID="search-upload"
                    />
                ) : null}
                <ToggleRow
                    label={t('admin.shield_integ_monitor', 'Check connected-app traffic for personal data')}
                    description={t('admin.shield_integ_monitor_desc', 'Every connected-app call is always recorded: which server, which country, when, and whether it worked. Turn this on to also check the content for personal data, so the reports can show what kind of data left your organisation.')}
                    value={fields.monitorIntegrations}
                    onValueChange={(monitorIntegrations) => set({ monitorIntegrations })}
                    testID="monitor-integrations"
                />
            </Group>
        </GroupedScroll>
    );
}
