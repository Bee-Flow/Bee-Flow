// Organisation settings › "Memory": the organisation's switch for the assistant
// remembering things about people, the sensitive-topics rule, the cap per person,
// and a danger zone that deletes every memory. It shows COUNTS only: what a
// person's memories say is theirs and is never shown here. It also names the
// model that picks memories out of a chat (`runsOn`, set by the server
// administrator), because that is the model that reads the conversations.
//
// The page title is the dashboard frame's (AdminPage); the blocks below carry
// their own sub-headings so the panel also reads on the phone page that stacks it.

import { useState } from 'react';
import {
    ORG_MEMORY_MAX_PER_USER, ORG_MEMORY_MIN_PER_USER,
    useClearOrgMemory, useOrgMemory, useSaveOrgMemory, type OrgMemoryState,
} from '@/api/queries/orgMemory';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { nOf } from '@/utils/plural';
import Button from '@/components/shared/Button';
import FormField from '@/components/shared/FormField';
import Modal from '@/components/shared/Modal';
import SaveFooter from '@/components/shared/SaveFooter';
import Section from '@/components/shared/Section';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { toast } from '@/components/shared/Toast';
import Toggle from '@/components/shared/Toggle';
import useConfirm from '@/components/shared/useConfirm';
import { INPUT } from '@/components/shared/adminUi';
import { errorStatus } from '@/utils/caughtError';
import OrgEditorLoad from './OrgEditorLoad';

const CONFIRM_WORD = 'DELETE';

/** The cap typed so far, as a whole number in range, else null. */
export function parseMaxPerUser(raw: string): number | null {
    if (!/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw);
    return n >= ORG_MEMORY_MIN_PER_USER && n <= ORG_MEMORY_MAX_PER_USER ? n : null;
}

/**
 * The extraction model's display name, when the read carries one. The query
 * (api/queries/orgMemory) passes only the fields it knows, so this reads the
 * optional extra without trusting its type.
 */
function runsOnOf(state: OrgMemoryState): string | null {
    const value: unknown = (state as OrgMemoryState & { runsOn?: unknown }).runsOn;
    return typeof value === 'string' && value.trim() ? value : null;
}

function ClearDialog({ orgId, open, onClose }: { orgId: string; open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const clear = useClearOrgMemory(orgId);
    const [typed, setTyped] = useState('');
    const close = () => { setTyped(''); onClose(); };
    const run = () => {
        clear.mutate(undefined, {
            onSuccess: ({ deleted }) => {
                toast.success(nOf(t, 'admin.org_memory.cleared', deleted, 'Deleted 1 memory in this organisation.', 'Deleted {count} memories in this organisation.'));
                close();
            },
            onError: () => toast.error(t('admin.org_memory.clear_failed', 'Could not delete the memories. Nothing was changed.')),
        });
    };
    return (
        <Modal
            open={open}
            onClose={() => { if (!clear.isPending) close(); }}
            title={t('admin.org_memory.clear_title', 'Delete all memories in this organisation?')}
            description={t('admin.org_memory.clear_desc', 'Every memory of every member is removed for good. This cannot be undone.')}
            size="sm"
            role="alertdialog"
            footer={(
                <>
                    <Button variant="secondary" onClick={close} disabled={clear.isPending}>{t('common.cancel', 'Cancel')}</Button>
                    <Button variant="danger" onClick={run} busy={clear.isPending} disabled={typed !== CONFIRM_WORD} data-testid="org-memory-clear-confirm">
                        {t('admin.org_memory.clear_confirm', 'Delete all memories')}
                    </Button>
                </>
            )}
        >
            <FormField label={t('admin.org_memory.clear_type', 'Type {word} to confirm', { word: CONFIRM_WORD })} htmlFor="org-memory-clear-input">
                <input
                    id="org-memory-clear-input"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    className={INPUT}
                />
            </FormField>
        </Modal>
    );
}

function StatsSection({ stats }: { stats: OrgMemoryState['stats'] }) {
    const { t } = useTranslation();
    return (
        <Section
            title={t('admin.org_memory.stats_title', 'What is stored')}
            description={t('admin.org_memory.stats_desc', 'Counts only. What a memory says stays private to the person it belongs to.')}
        >
            <p className="m-0 text-sm text-[var(--text-primary)]" data-testid="org-memory-stats">
                {t('admin.org_memory.stats', 'Active memories: {memories}. People with memories: {users}.', {
                    memories: stats.activeMemories, users: stats.users,
                })}
            </p>
        </Section>
    );
}

/** Removes every memory of every member: the typed-word dialog guards it. */
function DangerZone({ onClear }: { onClear: () => void }) {
    const { t } = useTranslation();
    return (
        <section className="rounded-lg border border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[var(--bg-primary)] p-4">
            <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{t('admin.org_memory.danger_title', 'Danger zone')}</h3>
            <p className="m-0 mt-0.5 mb-3 text-xs text-[var(--text-secondary)]">
                {t('admin.org_memory.danger_desc', 'Removes every memory of every member. Use it when the organisation wants a clean start.')}
            </p>
            <Button variant="danger" onClick={onClear} data-testid="org-memory-clear">
                {t('admin.org_memory.clear_button', 'Delete all memories in this organisation')}
            </Button>
        </section>
    );
}

interface Draft {
    enabled: boolean;
    sensitive: boolean;
    maxRaw: string;
}

function draftOf(server: OrgMemoryState): Draft {
    return { enabled: server.settings.enabled, sensitive: server.settings.sensitiveOptInAllowed, maxRaw: String(server.settings.maxPerUser) };
}

/** The two switches and the cap per person. */
function SettingsFields({ draft, set, max, busy, t }: { draft: Draft; set: (patch: Partial<Draft>) => void; max: number | null; busy: boolean; t: TranslateFn }) {
    // The bounds in the language on screen: "10,000" / "10.000", not "10000".
    const fmt = useLocaleFormat();
    const range = { min: fmt.number(ORG_MEMORY_MIN_PER_USER), max: fmt.number(ORG_MEMORY_MAX_PER_USER) };
    return (
        <>
            <SettingsList>
                <Toggle
                    flat
                    checked={draft.enabled}
                    onChange={(enabled) => set({ enabled })}
                    label={t('admin.org_memory.enabled', 'Memory enabled for this organisation')}
                    description={t('admin.org_memory.enabled_desc', 'When off, nobody in the organisation has anything remembered or read in chats. Existing memories are kept until someone deletes them.')}
                    disabled={busy}
                />
                <Toggle
                    flat
                    checked={draft.sensitive}
                    onChange={(sensitive) => set({ sensitive })}
                    label={t('admin.org_memory.sensitive', 'Allow members to opt in to sensitive topics')}
                    description={t('admin.org_memory.sensitive_desc', 'Members can then choose, in their own settings, to let memory keep things such as health or beliefs. Nobody is opted in by default.')}
                    disabled={busy}
                />
            </SettingsList>
            <FormField
                label={t('admin.org_memory.max_label', 'Memories per person')}
                htmlFor="org-memory-max"
                hint={t('admin.org_memory.max_hint', 'Between {min} and {max}. When someone reaches it, the least useful memories are retired first.', range)}
                error={max === null ? t('admin.org_memory.max_invalid', 'Enter a whole number between {min} and {max}.', range) : undefined}
            >
                <input
                    id="org-memory-max"
                    type="number"
                    inputMode="numeric"
                    min={ORG_MEMORY_MIN_PER_USER}
                    max={ORG_MEMORY_MAX_PER_USER}
                    value={draft.maxRaw}
                    onChange={(e) => set({ maxRaw: e.target.value })}
                    disabled={busy}
                    aria-invalid={max === null}
                    className={`${INPUT} max-w-[8rem]`}
                />
            </FormField>
        </>
    );
}

function Form({ orgId, server }: { orgId: string; server: OrgMemoryState }) {
    const { t } = useTranslation();
    const save = useSaveOrgMemory(orgId);
    const { confirm, confirmDialog } = useConfirm();
    const [draft, setDraft] = useState<Draft>(() => draftOf(server));
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [clearOpen, setClearOpen] = useState(false);
    const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

    const max = parseMaxPerUser(draft.maxRaw);
    const dirty = draft.enabled !== server.settings.enabled
        || draft.sensitive !== server.settings.sensitiveOptInAllowed
        || (max !== null && max !== server.settings.maxPerUser);
    const runsOn = runsOnOf(server);

    const onSave = async () => {
        if (max === null) return;
        // Turning the permission off deletes members' sensitive memories and their opt-ins.
        if (server.settings.sensitiveOptInAllowed && !draft.sensitive) {
            const ok = await confirm({
                title: t('admin.org_memory.sensitive_off_title', 'Stop allowing sensitive topics?'),
                description: t('admin.org_memory.sensitive_off_desc', 'Members\' sensitive memories, and their choice to keep such memories, will be deleted. This cannot be undone.'),
                confirmLabel: t('admin.org_memory.sensitive_off_confirm', 'Turn off and delete'),
                destructive: true,
            });
            if (!ok) return;
        }
        save.mutate({ enabled: draft.enabled, sensitiveOptInAllowed: draft.sensitive, maxPerUser: max }, {
            onSuccess: (saved) => {
                set({ maxRaw: String(saved.settings.maxPerUser) });
                setSavedAt(new Date());
                if (saved.deletedSensitive > 0) {
                    toast.info(nOf(t, 'admin.org_memory.deleted_sensitive', saved.deletedSensitive, 'Deleted 1 sensitive memory.', 'Deleted {count} sensitive memories.'));
                }
            },
            onError: (e) => toast.error(errorStatus(e) === 403
                ? t('admin.org_memory.forbidden', 'Only an admin of this organisation can change this.')
                : t('admin.org_memory.save_failed', 'Could not save the memory settings')),
        });
    };

    return (
        <div className="space-y-6">
            <SettingsGroup
                title={t('admin_org_ai.memory_settings_title', 'Memory in this organisation')}
                description={t('admin.org_memory.intro', 'Whether the assistant remembers things about people across chats, and how much. Applies to everyone in the organisation.')}
            >
                <SettingsFields draft={draft} set={set} max={max} busy={save.isPending} t={t} />
                {runsOn && (
                    <p className="m-0 text-xs text-[var(--text-secondary)]" data-testid="org-memory-runs-on">
                        {t('admin_org_ai.memory_runs_on', 'Memories are picked out of chats by {model}, which the server administrator chooses.', { model: runsOn })}
                    </p>
                )}
                <SaveFooter
                    onSave={() => { void onSave(); }}
                    onCancel={dirty && !save.isPending ? () => setDraft(draftOf(server)) : undefined}
                    saving={save.isPending}
                    dirty={dirty}
                    disabled={max === null}
                    saveState={save.isPending ? 'saving' : save.isError ? 'error' : 'idle'}
                    lastSavedAt={savedAt}
                    onRetry={() => { void onSave(); }}
                />
            </SettingsGroup>

            <StatsSection stats={server.stats} />
            <DangerZone onClear={() => setClearOpen(true)} />
            <ClearDialog orgId={orgId} open={clearOpen} onClose={() => setClearOpen(false)} />
            {confirmDialog}
        </div>
    );
}

export default function OrgMemoryEditor({ orgId }: { orgId: string | null | undefined }) {
    const { t } = useTranslation();
    const query = useOrgMemory(orgId);
    if (!orgId) return null;
    return (
        <div className="space-y-4" data-testid="org-memory">
            <OrgEditorLoad
                loading={query.isPending}
                error={query.isError ? t('admin.org_memory.load_failed', 'Could not load the memory settings.') : null}
                onRetry={() => { void query.refetch(); }}
            >
                {query.data && <Form key={orgId} orgId={orgId} server={query.data} />}
            </OrgEditorLoad>
        </div>
    );
}
