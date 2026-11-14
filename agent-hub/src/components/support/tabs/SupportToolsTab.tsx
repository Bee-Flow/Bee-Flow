import React, { useState } from 'react';
import { Save } from 'lucide-react';
import { useSupportConfigQuery } from '@/api/queries/supportPanels';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { errorBody, RefusedError } from '@/api/mutate';
import SectionHeader from '@/components/shared/SectionHeader';
import { SAVE_BUTTON, SettingRow, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import { ALERT_ERROR } from '@/components/mcpLibrary/ui';
import { apiRequest } from '@/api/typedRequest';

export default function SupportToolsTab() {
    const { t } = useTranslation();
    const configQuery = useSupportConfigQuery();
    // The person's edits on top of the server answer.
    const [v2Draft, setV2Enabled] = useState<boolean | null>(null);
    const [thresholdDraft, setThreshold] = useState<number | null>(null);
    const v2Enabled = v2Draft ?? !!configQuery.data?.v2Enabled;
    const threshold = thresholdDraft ?? configQuery.data?.autoResolveThreshold ?? 0.78;
    const [busy, setBusy] = useState(false);
    const [actionError, setError] = useState<string | null | undefined>(null);
    const [attempted, setAttempted] = useState(false);
    // A failed load shows until the first save attempt clears it, like the error state it replaces.
    const error = actionError ?? (!attempted && configQuery.isError ? errorMessage(configQuery.error) : null);
    const [saved, setSaved] = useState(false);

    const save = async () => {
        setBusy(true); setError(null); setAttempted(true); setSaved(false);
        try {
            try {
                await apiRequest('PUT /api/support/config', { body: { v2Enabled, autoResolveThreshold: Number(threshold) } });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const e = errorBody(err) ?? {};
                throw new Error(e.error || 'Save failed');
            }
            setSaved(true);
        } catch (e) { setError(errorMessage(e)); }
        finally { setBusy(false); }
    };

    return (
        <div className="flex max-w-4xl flex-col gap-6 p-6">
            <SectionHeader
                title={t('support.support_tools_ai_behaviour', 'AI behaviour')}
                description={t('support.support_tools_controls_for_the_deeper_ai_handling', 'Controls for the deeper AI handling. These apply to the live auto-responder.')}
            />
            {error && <div className={ALERT_ERROR}>{error}</div>}

            <SettingsList>
                <SettingRow
                    label={t('support.support_tools_enable_tool_using_ai_v2', 'Enable tool-using AI (v2)')}
                    hint={t('support.support_tools_lets_the_support_agent_call_read_only', 'Lets the support agent call read-only lookups (customer profile, organization, subscription status, recent threads, knowledge base) before replying. Costs more per reply. When off, the agent answers from injected KB context only.')}
                >
                    <div className="flex md:justify-end">
                        <Toggle checked={v2Enabled} onChange={setV2Enabled} ariaLabel={t('support.support_tools_enable_tool_using_ai_v2', 'Enable tool-using AI (v2)')} />
                    </div>
                </SettingRow>
                <SettingRow
                    htmlFor="support-auto-resolve"
                    label={t('support.support_tools_auto_resolve_confidence_threshold', 'Auto-resolve confidence threshold')}
                    hint={t('support.support_tools_when_the_ai_signals_it_fully_resolved', 'When the AI signals it fully resolved an issue and the top knowledge-base match scores above this, the thread is marked resolved and the customer gets a confirmation + CSAT email.')}
                >
                    <div className="flex items-center gap-3">
                        <input id="support-auto-resolve" type="range" min="0" max="1" step="0.01" value={threshold} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setThreshold(parseFloat(e.target.value))} className="flex-1 accent-[var(--accent-primary)]" />
                        <span className="w-12 text-right text-sm tabular-nums text-[var(--text-primary)]">{Number(threshold).toFixed(2)}</span>
                    </div>
                </SettingRow>
            </SettingsList>

            <div className="flex items-center gap-3">
                <button type="button" onClick={save} disabled={busy} className={SAVE_BUTTON}>
                    <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> {busy ? t('support.tabs_saving', 'Saving…') : t('support.tabs_save', 'Save')}
                </button>
                {saved && <span className="text-xs text-[var(--success-ink)]">{t('support.support_tools_saved', 'Saved')}</span>}
            </div>
        </div>
    );
}
