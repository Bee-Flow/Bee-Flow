import React, { useState } from 'react';
import { Save } from 'lucide-react';
import { API_BASE } from '../../../utils/helpers';
import { useSupportConfigQuery } from '../../../api/queries/supportPanels';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorMessage } from '../../../utils/caughtError';
import { mutate, errorBody, RefusedError } from '../../../api/mutate';

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
                await mutate(`${API_BASE}/api/support/config`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ v2Enabled, autoResolveThreshold: Number(threshold) }),
            });
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
        <div className="max-w-2xl mx-auto p-4">
            <h3 className="text-sm font-semibold mb-1 text-[var(--text-primary)]">{t('support.support_tools_ai_behaviour', 'AI behaviour')}</h3>
            <p className="text-xs mb-4 text-[var(--text-muted)]">
                {t('support.support_tools_controls_for_the_deeper_ai_handling', 'Controls for the deeper AI handling. These apply to the live auto-responder.')}
            </p>
            {error && <div className="text-xs mb-3 px-3 py-2 rounded [background:rgba(220,38,38,0.08)] [color:#dc2626]!">{error}</div>}

            <div className="rounded-lg border p-4 mb-3 border-[var(--border-default)] bg-[var(--bg-card)]">
                <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={v2Enabled} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setV2Enabled(e.target.checked)} className="mt-1" />
                    <div>
                        <div className="text-sm font-medium text-[var(--text-primary)]">{t('support.support_tools_enable_tool_using_ai_v2', 'Enable tool-using AI (v2)')}</div>
                        <div className="text-xs mt-0.5 text-[var(--text-muted)]">
                            {t('support.support_tools_lets_the_support_agent_call_read_only', 'Lets the support agent call read-only lookups (customer profile, organization, subscription status, recent threads, knowledge base) before replying. Costs more per reply. When off, the agent answers from injected KB context only.')}
                        </div>
                    </div>
                </label>
            </div>

            <div className="rounded-lg border p-4 mb-4 border-[var(--border-default)] bg-[var(--bg-card)]">
                <div className="text-sm font-medium mb-1 text-[var(--text-primary)]">{t('support.support_tools_auto_resolve_confidence_threshold', 'Auto-resolve confidence threshold')}</div>
                <div className="text-xs mb-2 text-[var(--text-muted)]">
                    {t('support.support_tools_when_the_ai_signals_it_fully_resolved', 'When the AI signals it fully resolved an issue and the top knowledge-base match scores above this, the thread is marked resolved and the customer gets a confirmation + CSAT email.')}
                </div>
                <div className="flex items-center gap-3">
                    <input type="range" min="0" max="1" step="0.01" value={threshold} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setThreshold(parseFloat(e.target.value))} className="flex-1" />
                    <span className="text-sm tabular-nums w-12 text-right text-[var(--text-primary)]">{Number(threshold).toFixed(2)}</span>
                </div>
            </div>

            <div className="flex items-center gap-3">
                <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 disabled:opacity-50 [background:var(--accent-primary)] [color:white]!">
                    <Save className="w-3.5 h-3.5" /> {busy ? 'Saving…' : 'Save'}
                </button>
                {saved && <span className="text-xs [color:#059669]!">{t('support.support_tools_saved', 'Saved')}</span>}
            </div>
        </div>
    );
}
