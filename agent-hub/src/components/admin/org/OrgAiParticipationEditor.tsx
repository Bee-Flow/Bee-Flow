// Organisation settings › AI context › "AI that joins by itself": whether a
// team chat (and a comment thread) may let the AI take part on its own, how
// eager the check behind it is, and the limits that keep it quiet. The rules
// these feed are server/projects/participation/; the server clamps every
// number again, this screen only offers the ranges it was sent.

import { AlertTriangle, Loader2, MessagesSquare } from 'lucide-react';
import React, { useState } from 'react';
import {
    useOrgAiParticipation, useSaveOrgAiParticipation,
    type AiSensitivity, type OrgAiParticipationPolicy, type OrgAiParticipationSettings,
} from '../../../api/queries/aiParticipation';
import { useTranslation, type TranslateFn } from '../../../hooks/useTranslation';
import ChoiceCards from '../../shared/ChoiceCards';
import Toggle from '../../shared/Toggle';

const SETTING_KEYS: (keyof OrgAiParticipationSettings)[] = [
    'autoAllowed', 'alwaysAllowed', 'commentsAutoAllowed', 'sensitivity', 'cooldownMinutes', 'maxAutoPerChatHour',
    'maxAutoPerProjectDay', 'maxGatesPerChatHour', 'maxGatesPerOrgDay', 'quietSeconds', 'maxDebounceSeconds',
    'unansweredMinutes', 'commentUnansweredMinutes',
];

type NumberKey = 'cooldownMinutes' | 'maxAutoPerChatHour' | 'maxAutoPerProjectDay' | 'unansweredMinutes';
const LIMITS: NumberKey[] = ['cooldownMinutes', 'maxAutoPerChatHour', 'maxAutoPerProjectDay', 'unansweredMinutes'];

function limitLabel(key: NumberKey, t: TranslateFn): string {
    if (key === 'cooldownMinutes') return t('project_participation.org_cooldown', 'Quiet time after an answer (minutes)');
    if (key === 'maxAutoPerChatHour') return t('project_participation.org_max_chat_hour', 'Answers per chat, per hour');
    if (key === 'maxAutoPerProjectDay') return t('project_participation.org_max_project_day', 'Answers per project, per day');
    return t('project_participation.org_unanswered', 'Minutes colleagues get to answer a question first');
}

/** The settings as the server holds them, without its extras. */
function settingsOf(policy: OrgAiParticipationPolicy): OrgAiParticipationSettings {
    const out = {} as Record<string, unknown>;
    for (const key of SETTING_KEYS) out[key] = policy[key];
    return out as unknown as OrgAiParticipationSettings;
}

function Limits({ values, ranges, disabled, onChange }: {
    values: OrgAiParticipationSettings;
    ranges: OrgAiParticipationPolicy['ranges'];
    disabled: boolean;
    onChange: (key: NumberKey, value: number) => void;
}) {
    const { t } = useTranslation();
    return (
        <fieldset className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-4" disabled={disabled}>
            <legend className="px-1 text-sm font-medium text-[var(--text-primary)]">{t('project_participation.org_limits', 'Limits')}</legend>
            <p className="m-0 text-xs text-[var(--text-muted)]">
                {t('project_participation.org_limits_hint', 'The AI stays within these even when it could say more. An answer somebody asks for with @ai does not count, but it does start the quiet time.')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {LIMITS.map((key) => {
                    const [min, max] = ranges?.[key] || [1, 1000];
                    const id = `ai-participation-${key}`;
                    return (
                        <div key={key} className="space-y-1">
                            <label htmlFor={id} className="block text-[13px] text-[var(--text-secondary)]">{limitLabel(key, t)}</label>
                            <input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} value={values[key]}
                                onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(key, n); }}
                                className="w-32 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[13px] text-[var(--text-primary)] tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]" />
                        </div>
                    );
                })}
            </div>
        </fieldset>
    );
}

function Editor({ orgId, server }: { orgId: string; server: OrgAiParticipationPolicy }) {
    const { t } = useTranslation();
    const save = useSaveOrgAiParticipation(orgId);
    const [draft, setDraft] = useState<Partial<OrgAiParticipationSettings>>({});
    const [status, setStatus] = useState<'saved' | 'failed' | null>(null);
    const values: OrgAiParticipationSettings = { ...settingsOf(server), ...draft };
    const dirty = SETTING_KEYS.some((key) => key in draft && draft[key] !== server[key]);
    const set = (patch: Partial<OrgAiParticipationSettings>) => {
        setStatus(null);
        setDraft((d) => ({ ...d, ...patch }));
    };
    const onSave = () => {
        save.mutate(values, {
            onSuccess: () => { setDraft({}); setStatus('saved'); },
            onError: () => setStatus('failed'),
        });
    };
    const busy = save.isPending;
    const sensitivity: { value: AiSensitivity; label: string; description: string }[] = [
        { value: 'conservative', label: t('project_participation.org_sensitivity_conservative', 'Reserved'), description: t('project_participation.org_sensitivity_conservative_desc', 'Joins only when it is very sure it helps.') },
        { value: 'balanced', label: t('project_participation.org_sensitivity_balanced', 'Balanced'), description: t('project_participation.org_sensitivity_balanced_desc', 'Recommended. Joins for clear questions and requests.') },
        { value: 'eager', label: t('project_participation.org_sensitivity_eager', 'Eager'), description: t('project_participation.org_sensitivity_eager_desc', 'Joins more often, also when it is less sure.') },
    ];
    return (
        <div className="space-y-4">
            <div className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-4">
                <Toggle checked={values.autoAllowed} disabled={busy} onChange={(v) => set({ autoAllowed: v })}
                    label={t('project_participation.org_auto_allowed', 'Let the AI join conversations by itself')}
                    description={t('project_participation.org_auto_allowed_desc', 'Team chats set to Auto get an answer from the AI when it can help: a question it can answer, a request for a summary, a question nobody answered. Chats start in "On mention"; an editor of the chat chooses Auto.')} />
                <Toggle checked={values.commentsAutoAllowed && values.autoAllowed} disabled={busy || !values.autoAllowed} onChange={(v) => set({ commentsAutoAllowed: v })}
                    label={t('project_participation.org_comments_allowed', 'Also in comment threads')}
                    description={t('project_participation.org_comments_allowed_desc', 'Comment threads on documents and notebooks can be set to Auto as well.')} />
                <Toggle checked={values.alwaysAllowed} disabled={busy} onChange={(v) => set({ alwaysAllowed: v })}
                    label={t('project_participation.org_always_allowed', 'Allow "Always"')}
                    description={t('project_participation.org_always_allowed_desc', 'A team chat may let the AI answer every message.')} />
            </div>
            <div className="space-y-2">
                <p className="m-0 text-sm font-medium text-[var(--text-primary)]">{t('project_participation.org_sensitivity', 'How readily the AI joins')}</p>
                <ChoiceCards value={values.sensitivity} onChange={(v) => set({ sensitivity: v })} options={sensitivity} columns={3}
                    ariaLabel={t('project_participation.org_sensitivity', 'How readily the AI joins')} disabled={busy || !values.autoAllowed} />
            </div>
            <Limits values={values} ranges={server.ranges} disabled={busy || !values.autoAllowed} onChange={(key, n) => set({ [key]: n })} />
            <p className="m-0 text-xs text-[var(--text-muted)]">
                {t('project_participation.org_privacy_note', 'Before it joins, a short check reads the latest messages under pseudonyms and through the Privacy Shield. Its reasons are kept as codes, never as text. Everyone can stop their own messages from making it join.')}
            </p>
            <div className="flex items-center gap-3 border-t border-[var(--border-subtle)] pt-4">
                <button type="button" onClick={onSave} disabled={!dirty || busy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-[var(--accent-primary-fg)] disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90">
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                    {t('project_participation.org_save', 'Save')}
                </button>
                {dirty && !busy && (
                    <button type="button" onClick={() => { setDraft({}); setStatus(null); }} className="text-sm underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                        {t('project_participation.org_cancel', 'Cancel')}
                    </button>
                )}
                {status === 'saved' && <span role="status" className="text-sm text-[var(--text-secondary)]">{t('project_participation.org_saved', 'Saved. It applies to the next message.')}</span>}
                {status === 'failed' && <span role="alert" className="text-sm text-[var(--error-ink)]">{t('project_participation.org_save_failed', 'Could not save these settings. Try again.')}</span>}
            </div>
        </div>
    );
}

/**
 * `enabled` false (Projects cannot be used here: plan or operator switch,
 * useProjectsAvailable) shows nothing and reads nothing — the setting only
 * acts inside projects.
 */
export default function OrgAiParticipationEditor({ orgId, enabled = true }: { orgId: string | null | undefined; enabled?: boolean }) {
    const { t } = useTranslation();
    const query = useOrgAiParticipation(enabled ? orgId : null);
    if (!orgId || !enabled) return null;
    return (
        <section className="space-y-4 p-1" data-testid="org-ai-participation" aria-labelledby="org-ai-participation-title">
            <header>
                <h2 id="org-ai-participation-title" className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
                    <MessagesSquare className="h-5 w-5" aria-hidden="true" />
                    {t('project_participation.org_title', 'AI that joins by itself')}
                </h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {t('project_participation.org_intro', 'Whether the AI may take part in team conversations on its own, and how much. It never interrupts: it answers in the conversation, briefly, and says why it joined.')}
                </p>
            </header>
            {query.isPending && (
                <div className="flex items-center gap-2 p-2 text-sm text-[var(--text-secondary)]" role="status">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('project_participation.org_loading', 'Loading…')}
                </div>
            )}
            {query.isError && (
                <div className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)]" role="alert">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 text-[var(--error-ink)]" aria-hidden="true" />
                    <span className="flex-1">{t('project_participation.org_load_failed', 'Could not load these settings.')}</span>
                    <button type="button" onClick={() => query.refetch()} className="text-sm underline">{t('project_participation.retry', 'Try again')}</button>
                </div>
            )}
            {query.data && <Editor key={orgId} orgId={orgId} server={query.data} />}
        </section>
    );
}
