import { Copy, Check, X } from 'lucide-react';
import React, { useEffect, useId, useRef, useState } from 'react';

import { useTranslation } from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../utils/helpers';
import Modal from '../../shared/Modal';
import { memoryRefusal } from './memoryErrors';

// The prompt goes to ANOTHER assistant, so it stays English whatever the UI language is.
const EXPORT_PROMPT = `Export all of my stored memories and any context you've learned about me from past conversations. Preserve my words verbatim where possible, especially for instructions and preferences.

Group by category (if applicable, in this order):
- Instructions (standing rules — always/never do X)
- People (people I know or work with)
- Projects (project details, tech stacks, URLs)
- Preferences (settings, tone, formatting)
- Workflows (how I like to work)
- Facts (specific facts about me or my work)
- Context (general background)

Return one concise bullet per memory. Do not add commentary.`;

const MAX_CHARS = 50000;

interface ImportMemoryModalProps {
    onClose?: () => void;
    onImported?: () => void;
}

interface ImportResult {
    imported?: number;
    /** Total skipped. */
    skipped?: number;
    skippedBy?: { sensitive?: number; identifier?: number; duplicate?: number };
}

export default function ImportMemoryModal({ onClose, onImported }: ImportMemoryModalProps) {
    const { t } = useTranslation();
    const titleId = useId();
    const [pasted, setPasted] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [copied, setCopied] = useState(false);
    const [result, setResult] = useState<ImportResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

    const skippedTotal = result?.skipped ?? 0;
    const skippedSensitive = result?.skippedBy?.sensitive ?? 0;
    const skippedIdentifier = result?.skippedBy?.identifier ?? 0;

    const canSubmit = pasted.trim().length > 0 && !submitting && !result;

    const copyPrompt = async () => {
        try {
            await navigator.clipboard.writeText(EXPORT_PROMPT);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable: the prompt stays selectable */ }
    };

    const submit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: pasted.trim() }),
            });
            const data = (await res.json().catch(() => ({}))) as ImportResult & { error?: string; code?: string };
            if (!res.ok) {
                const known = memoryRefusal(t, data?.code ?? null, res.status);
                if (known) throw new Error(known);
                if (res.status === 403) {
                    throw new Error(t('knowledge.memory_import_err_paused', 'Importing is not available while memory is paused or turned off.'));
                }
                throw new Error(data?.error || `${t('settings.memory_import_error', 'Import failed')} (HTTP ${res.status})`);
            }
            setResult(data);
            onImported?.();
            closeTimer.current = setTimeout(() => { onClose?.(); }, 1800);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    };

    const step = 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg-tertiary)] text-[11px] font-semibold text-[var(--text-primary)]';

    return (
        <Modal open onClose={() => onClose?.()} variant="bare" size="auto" labelledBy={titleId} className="max-w-xl">
            <div className="w-full overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-2xl">
                <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-6 py-4">
                    <h2 id={titleId} className="text-base font-semibold text-[var(--text-primary)]">
                        {t('settings.memory_import_modal_title', 'Import memory')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('knowledge.memory_close', 'Close')}
                        className="rounded-md p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="space-y-5 px-6 py-5">
                    <div>
                        <div className="mb-2 flex items-center gap-2">
                            <span className={step}>1</span>
                            <p className="text-[13px] text-[var(--text-primary)]">
                                {t('settings.memory_import_step1', 'Copy this prompt into a chat with your other AI provider')}
                            </p>
                        </div>
                        <div className="relative">
                            <textarea
                                value={EXPORT_PROMPT}
                                readOnly
                                rows={6}
                                aria-label={t('knowledge.memory_import_prompt_label', 'Export prompt')}
                                className="w-full resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-3 pr-20 text-[12px] leading-normal text-[var(--text-secondary)]"
                            />
                            <button
                                type="button"
                                onClick={copyPrompt}
                                className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)]"
                            >
                                {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
                                {copied ? t('settings.memory_import_copied', 'Copied') : t('settings.memory_import_copy', 'Copy')}
                            </button>
                        </div>
                    </div>

                    <div>
                        <div className="mb-2 flex items-center gap-2">
                            <span className={step}>2</span>
                            <label htmlFor={`${titleId}-paste`} className="text-[13px] text-[var(--text-primary)]">
                                {t('settings.memory_import_step2', 'Paste results below to add to memory')}
                            </label>
                        </div>
                        <textarea
                            id={`${titleId}-paste`}
                            value={pasted}
                            onChange={(e) => setPasted(e.target.value)}
                            rows={7}
                            maxLength={MAX_CHARS}
                            placeholder={t('settings.memory_import_placeholder', 'Paste your memory details here')}
                            disabled={submitting || !!result}
                            className="w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-3 text-[12px] leading-normal text-[var(--text-primary)]"
                        />
                        <div className="mt-1 flex justify-end">
                            <span className="text-[10px] text-[var(--text-tertiary)]">
                                {pasted.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
                            </span>
                        </div>
                    </div>

                    {error && (
                        <div role="alert" className="rounded-lg bg-rose-500/10 p-2 text-[12px] text-[var(--error)]">{error}</div>
                    )}
                    {result && (
                        <div role="status" className="rounded-lg bg-emerald-500/10 p-2 text-[12px] text-emerald-600 dark:text-emerald-400">
                            {(result.imported ?? 0) > 0
                                ? t('settings.memory_import_success', 'Added {count} memories', { count: result.imported })
                                : t('settings.memory_import_none', 'No memories could be extracted from the text.')}
                            {skippedTotal > 0 && (
                                <span className="text-[var(--text-tertiary)]"> {t('knowledge.import_memory_modal_skipped_skipped', '· {skipped} skipped', { skipped: skippedTotal })}</span>
                            )}
                            {skippedSensitive > 0 && (
                                <span className="block text-[var(--text-tertiary)]">
                                    {t('knowledge.memory_import_skipped_sensitive', '{count} skipped because they are about a sensitive topic.', { count: skippedSensitive })}
                                </span>
                            )}
                            {skippedIdentifier > 0 && (
                                <span className="block text-[var(--text-tertiary)]">
                                    {t('knowledge.memory_import_skipped_identifier', '{count} skipped because they look like a password, account or ID number.', { count: skippedIdentifier })}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-3 border-t border-[var(--border-subtle)] px-6 py-4">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={submitting}
                        className="rounded-lg border border-[var(--border-default)] px-4 py-2 text-[13px] font-medium text-[var(--text-primary)] disabled:opacity-50"
                    >
                        {t('settings.memory_import_cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!canSubmit}
                        className="rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                    >
                        {submitting ? t('settings.memory_import_submitting', 'Importing…') : t('settings.memory_import_submit', 'Add to memory')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
