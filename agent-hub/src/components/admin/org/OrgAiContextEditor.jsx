/**
 * Organisation AI context settings — one switch: conversation compaction.
 *
 * Compaction folds older turns of a long chat into a short summary and
 * truncates long tool results. That used to run for everyone, unconditionally,
 * from the 16th message onward — which is what people report as "it forgot what
 * we were talking about". Modern models carry up to a million tokens of
 * context, so on a normal conversation there is nothing to gain from it.
 *
 * Hence: OFF by default, and the copy here is explicit that turning it on
 * trades recall for cost. The server keeps the conversation inside the model's
 * context window either way (server/core/llm/contextPolicy.js).
 */
import { Brain, AlertTriangle, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../utils/helpers';
import ChoiceCards from '../../shared/ChoiceCards';
import { toast } from '../../shared/Toast';

// "750,000" reads better than "750000" and than "0.75M" at these magnitudes.
const formatTokens = (n) => Math.round(n).toLocaleString();

export default function OrgAiContextEditor({ orgId }) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [server, setServer] = useState(null);    // last loaded server state
    const [enabled, setEnabled] = useState(false); // current selection
    const [budgetPercent, setBudgetPercent] = useState(75);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        if (!orgId) return;
        setLoading(true);
        setLoadError(null);
        try {
            const res = await authFetch(`${API_BASE}/api/org-ai-context/${orgId}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setServer(data);
            setEnabled(!!data.compactionEnabled);
            setBudgetPercent(data.contextBudgetPercent ?? 75);
        } catch (err) {
            // Null the loaded state so Save stays disabled — saving on top of a
            // failed load would write a guess.
            setServer(null);
            setLoadError(err.message);
        } finally {
            setLoading(false);
        }
    }, [orgId]);

    useEffect(() => { load(); }, [load]);

    const isDirty = !!server && (
        enabled !== !!server.compactionEnabled
        || budgetPercent !== server.contextBudgetPercent
    );

    const handleSave = useCallback(async () => {
        if (!server || !isDirty) return;
        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/api/org-ai-context/${orgId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    compactionEnabled: enabled,
                    compactionThreshold: server.compactionThreshold,
                    recentWindow: server.recentWindow,
                    contextBudgetPercent: budgetPercent,
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(body.error || t('admin.ai_context.save_failed', 'Could not save conversation memory settings'));
                return;
            }
            toast.success(t('admin.ai_context.saved', 'Conversation memory settings saved'));
            await load();
        } catch (err) {
            toast.error(err.message || t('admin.ai_context.save_failed', 'Could not save conversation memory settings'));
        } finally {
            setSaving(false);
        }
    }, [server, isDirty, orgId, enabled, budgetPercent, t, load]);

    if (!orgId) return null;

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-4 text-sm opacity-75">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('common.loading', 'Loading...')}
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="p-4">
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                    <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                    {t('admin.ai_context.load_failed', 'Could not load conversation memory settings.')} {loadError}
                </div>
            </div>
        );
    }

    // The server owns the context-window table and the allowed range; the SPA
    // only multiplies. Falling back keeps the screen usable against an older
    // API that doesn't send these yet.
    const examples = Array.isArray(server?.contextWindowExamples) ? server.contextWindowExamples : [];
    const range = server?.contextBudgetRange || { min: 25, max: 95 };

    const options = [
        {
            value: 'off',
            label: t('admin.ai_context.off', 'Keep the full conversation (recommended)'),
            description: t(
                'admin.ai_context.off_desc',
                'The assistant sees every earlier message, tool result and attachment for as long as they fit in the model context window. Best answers; higher token use on very long chats.',
            ),
            Icon: Brain,
        },
        {
            value: 'on',
            label: t('admin.ai_context.on', 'Summarise older messages'),
            description: t(
                'admin.ai_context.on_desc',
                'Once a chat passes about 16 messages, everything older is replaced by a short summary and long tool results are shortened. Cheaper, but detail from earlier in the conversation is permanently lost to the assistant.',
            ),
            Icon: AlertTriangle,
        },
    ];

    return (
        <div className="space-y-5 p-1">
            <header>
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Brain className="h-5 w-5" aria-hidden="true" />
                    {t('admin.ai_context.title', 'Conversation memory')}
                </h2>
                <p className="mt-1 text-sm opacity-75">
                    {t(
                        'admin.ai_context.intro',
                        'How much of a long conversation the assistant keeps in view. Applies to chats and agents across the whole organisation and takes effect on the next message.',
                    )}
                </p>
            </header>

            <ChoiceCards
                value={enabled ? 'on' : 'off'}
                onChange={(v) => setEnabled(v === 'on')}
                options={options}
                columns={1}
                ariaLabel={t('admin.ai_context.choose', 'Conversation memory')}
                disabled={saving}
            />

            {/* The safety limit applies in BOTH modes, so it sits outside the
                choice above rather than under one of the two cards. */}
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] p-4">
                <label htmlFor="ai-context-budget" className="block text-sm font-medium">
                    {t('admin.ai_context.budget_label', 'Safety limit')}
                </label>
                <p className="text-xs opacity-70">
                    {t(
                        'admin.ai_context.safety_note',
                        'A conversation can never overflow the model: once it reaches this share of the context window, the oldest part is summarised automatically.',
                    )}
                </p>
                <div className="flex items-center gap-3">
                    <input
                        id="ai-context-budget"
                        type="range"
                        min={range.min}
                        max={range.max}
                        step={5}
                        value={budgetPercent}
                        disabled={saving}
                        onChange={(e) => setBudgetPercent(Number(e.target.value))}
                        className="flex-1 accent-blue-600"
                        aria-valuetext={`${budgetPercent}%`}
                    />
                    <span className="w-12 text-right text-sm font-medium tabular-nums">{budgetPercent}%</span>
                </div>
                {examples.length > 0 && (
                    <p className="text-xs opacity-70">
                        {examples.map(ex => (
                            `${ex.label} → ~${formatTokens(ex.contextWindow * budgetPercent / 100)} tokens`
                        )).join('   ·   ')}
                    </p>
                )}
            </div>

            <div className="flex items-center gap-3 border-t border-black/10 pt-4 dark:border-white/10">
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!isDirty || saving}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 hover:bg-blue-700"
                >
                    {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
                </button>
                {isDirty && (
                    <button
                        type="button"
                        onClick={() => {
                            setEnabled(!!server.compactionEnabled);
                            setBudgetPercent(server.contextBudgetPercent ?? 75);
                        }}
                        disabled={saving}
                        className="text-sm underline opacity-75 hover:opacity-100"
                    >
                        {t('common.cancel', 'Cancel')}
                    </button>
                )}
            </div>
        </div>
    );
}
