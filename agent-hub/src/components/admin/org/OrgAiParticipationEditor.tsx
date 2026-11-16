// Organisation settings › Projects › "AI that joins by itself": whether a
// team chat (and a comment thread) may let the AI take part on its own, how
// eager the check behind it is, and the limits that keep it quiet. The rules
// these feed are server/projects/participation/; the server clamps every
// number again, this screen only offers the ranges it was sent.
//
// It shares its page with "Edit together in real time", so it opens with its
// own sub-heading; the page title is the dashboard frame's (AdminPage).

import { useState } from 'react';
import {
    useOrgAiParticipation, useSaveOrgAiParticipation,
    type AiSensitivity, type OrgAiParticipationPolicy, type OrgAiParticipationSettings,
} from '@/api/queries/aiParticipation';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import ChoiceCards from '@/components/shared/ChoiceCards';
import SaveFooter from '@/components/shared/SaveFooter';
import { SettingBlock, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import { INPUT } from '@/components/shared/adminUi';
import OrgEditorLoad from './OrgEditorLoad';

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
        <fieldset className="m-0 min-w-0 space-y-3 border-0 px-4 py-3" disabled={disabled}>
            <legend className="float-left m-0 w-full p-0 text-[13px] font-medium text-[var(--text-primary)]">{t('project_participation.org_limits', 'Limits')}</legend>
            <p className="clear-both m-0 text-xs text-[var(--text-tertiary)]">
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
                                className={`${INPUT} max-w-[8rem] tabular-nums`} />
                        </div>
                    );
                })}
            </div>
        </fieldset>
    );
}

function sensitivityOptions(t: TranslateFn): { value: AiSensitivity; label: string; description: string }[] {
    return [
        { value: 'conservative', label: t('project_participation.org_sensitivity_conservative', 'Reserved'), description: t('project_participation.org_sensitivity_conservative_desc', 'Joins only when it is very sure it helps.') },
        { value: 'balanced', label: t('project_participation.org_sensitivity_balanced', 'Balanced'), description: t('project_participation.org_sensitivity_balanced_desc', 'Recommended. Joins for clear questions and requests.') },
        { value: 'eager', label: t('project_participation.org_sensitivity_eager', 'Eager'), description: t('project_participation.org_sensitivity_eager_desc', 'Joins more often, also when it is less sure.') },
    ];
}

/** The three switches: may the AI join by itself, also in comment threads, and may a chat choose "Always". */
function Switches({ values, busy, set, t }: { values: OrgAiParticipationSettings; busy: boolean; set: (patch: Partial<OrgAiParticipationSettings>) => void; t: TranslateFn }) {
    return (
        <>
            <Toggle flat checked={values.autoAllowed} disabled={busy} onChange={(v) => set({ autoAllowed: v })}
                label={t('project_participation.org_auto_allowed', 'Let the AI join conversations by itself')}
                description={t('project_participation.org_auto_allowed_desc', 'Team chats set to Auto get an answer from the AI when it can help: a question it can answer, a request for a summary, a question nobody answered. Chats start in "On mention"; an editor of the chat chooses Auto.')} />
            <Toggle flat checked={values.commentsAutoAllowed && values.autoAllowed} disabled={busy || !values.autoAllowed} onChange={(v) => set({ commentsAutoAllowed: v })}
                label={t('project_participation.org_comments_allowed', 'Also in comment threads')}
                description={t('project_participation.org_comments_allowed_desc', 'Comment threads on documents and notebooks can be set to Auto as well.')} />
            <Toggle flat checked={values.alwaysAllowed} disabled={busy} onChange={(v) => set({ alwaysAllowed: v })}
                label={t('project_participation.org_always_allowed', 'Allow "Always"')}
                description={t('project_participation.org_always_allowed_desc', 'A team chat may let the AI answer every message.')} />
        </>
    );
}

function Editor({ orgId, server }: { orgId: string; server: OrgAiParticipationPolicy }) {
    const { t } = useTranslation();
    const save = useSaveOrgAiParticipation(orgId);
    const [draft, setDraft] = useState<Partial<OrgAiParticipationSettings>>({});
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const values: OrgAiParticipationSettings = { ...settingsOf(server), ...draft };
    const dirty = SETTING_KEYS.some((key) => key in draft && draft[key] !== server[key]);
    const set = (patch: Partial<OrgAiParticipationSettings>) => setDraft((d) => ({ ...d, ...patch }));
    const onSave = () => {
        save.mutate(values, {
            onSuccess: () => { setDraft({}); setSavedAt(new Date()); },
        });
    };
    const busy = save.isPending;
    const locked = busy || !values.autoAllowed;
    return (
        <div className="space-y-4">
            <SettingsList>
                <Switches values={values} busy={busy} set={set} t={t} />
                <SettingBlock label={t('project_participation.org_sensitivity', 'How readily the AI joins')}>
                    <ChoiceCards value={values.sensitivity} onChange={(v) => set({ sensitivity: v })} options={sensitivityOptions(t)} columns={3}
                        ariaLabel={t('project_participation.org_sensitivity', 'How readily the AI joins')} disabled={locked} />
                </SettingBlock>
                <Limits values={values} ranges={server.ranges} disabled={locked} onChange={(key, n) => set({ [key]: n })} />
            </SettingsList>
            <p className="m-0 text-xs text-[var(--text-muted)]">
                {t('project_participation.org_privacy_note', 'Before it joins, a short check reads the latest messages under pseudonyms and through the Privacy Shield. Its reasons are kept as codes, never as text. Everyone can stop their own messages from making it join.')}
            </p>
            <SaveFooter
                onSave={onSave}
                onCancel={dirty && !busy ? () => setDraft({}) : undefined}
                saving={busy}
                dirty={dirty}
                saveState={busy ? 'saving' : save.isError ? 'error' : 'idle'}
                lastSavedAt={savedAt}
                onRetry={onSave}
                saveLabel={t('project_participation.org_save', 'Save')}
                cancelLabel={t('project_participation.org_cancel', 'Cancel')}
            />
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
        <SettingsGroup
            title={t('project_participation.org_title', 'AI that joins by itself')}
            description={t('project_participation.org_intro', 'Whether the AI may take part in team conversations on its own, and how much. It never interrupts: it answers in the conversation, briefly, and says why it joined.')}
        >
            <div data-testid="org-ai-participation">
                <OrgEditorLoad
                    loading={query.isPending}
                    error={query.isError ? t('project_participation.org_load_failed', 'Could not load these settings.') : null}
                    onRetry={() => { void query.refetch(); }}
                >
                    {query.data && <Editor key={orgId} orgId={orgId} server={query.data} />}
                </OrgEditorLoad>
            </div>
        </SettingsGroup>
    );
}
