// Organisation settings › "Memory": the organisation's switch for the assistant
// remembering things about people, the sensitive-topics rule, the cap per person,
// and a danger zone that deletes every memory. It shows COUNTS only: what a
// person's memories say is theirs and is never shown here.

import { AlertTriangle, Brain, Loader2 } from 'lucide-react';
import React, { useState } from 'react';
import {
    ORG_MEMORY_MAX_PER_USER, ORG_MEMORY_MIN_PER_USER,
    useClearOrgMemory, useOrgMemory, useSaveOrgMemory, type OrgMemoryState,
} from '../../../api/queries/orgMemory';
import { useTranslation } from '../../../hooks/useTranslation';
import { nOf } from '../Studio/KnowledgeStudio/plural';
import Button from '../../shared/Button';
import FormField from '../../shared/FormField';
import Modal from '../../shared/Modal';
import Section from '../../shared/Section';
import { toast } from '../../shared/Toast';
import Toggle from '../../shared/Toggle';
import useConfirm from '../../shared/useConfirm';

const CONFIRM_WORD = 'DELETE';

/** The cap typed so far, as a whole number in range, else null. */
export function parseMaxPerUser(raw: string): number | null {
    if (!/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw);
    return n >= ORG_MEMORY_MIN_PER_USER && n <= ORG_MEMORY_MAX_PER_USER ? n : null;
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
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]"
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

function Form({ orgId, server }: { orgId: string; server: OrgMemoryState }) {
    const { t } = useTranslation();
    const save = useSaveOrgMemory(orgId);
    const { confirm, confirmDialog } = useConfirm();
    const [enabled, setEnabled] = useState(server.settings.enabled);
    const [sensitive, setSensitive] = useState(server.settings.sensitiveOptInAllowed);
    const [maxRaw, setMaxRaw] = useState(String(server.settings.maxPerUser));
    const [clearOpen, setClearOpen] = useState(false);

    const max = parseMaxPerUser(maxRaw);
    const dirty = enabled !== server.settings.enabled
        || sensitive !== server.settings.sensitiveOptInAllowed
        || (max !== null && max !== server.settings.maxPerUser);
    const canSave = dirty && max !== null && !save.isPending;

    const onSave = async () => {
        if (max === null) return;
        // Turning the permission off deletes members' sensitive memories and their opt-ins.
        if (server.settings.sensitiveOptInAllowed && !sensitive) {
            const ok = await confirm({
                title: t('admin.org_memory.sensitive_off_title', 'Stop allowing sensitive topics?'),
                description: t('admin.org_memory.sensitive_off_desc', 'Members\' sensitive memories, and their choice to keep such memories, will be deleted. This cannot be undone.'),
                confirmLabel: t('admin.org_memory.sensitive_off_confirm', 'Turn off and delete'),
                destructive: true,
            });
            if (!ok) return;
        }
        save.mutate({ enabled, sensitiveOptInAllowed: sensitive, maxPerUser: max }, {
            onSuccess: (saved) => {
                setMaxRaw(String(saved.settings.maxPerUser));
                toast.success(t('admin.org_memory.saved', 'Memory settings saved'));
                if (saved.deletedSensitive > 0) {
                    toast.info(nOf(t, 'admin.org_memory.deleted_sensitive', saved.deletedSensitive, 'Deleted 1 sensitive memory.', 'Deleted {count} sensitive memories.'));
                }
            },
            onError: (e) => toast.error((e as { status?: number }).status === 403
                ? t('admin.org_memory.forbidden', 'Only an admin of this organisation can change this.')
                : t('admin.org_memory.save_failed', 'Could not save the memory settings')),
        });
    };

    return (
        <div className="space-y-4">
            <Section>
                <div className="space-y-3">
                    <Toggle
                        checked={enabled}
                        onChange={setEnabled}
                        label={t('admin.org_memory.enabled', 'Memory enabled for this organisation')}
                        description={t('admin.org_memory.enabled_desc', 'When off, nobody in the organisation has anything remembered or read in chats. Existing memories are kept until someone deletes them.')}
                        disabled={save.isPending}
                    />
                    <Toggle
                        checked={sensitive}
                        onChange={setSensitive}
                        label={t('admin.org_memory.sensitive', 'Allow members to opt in to sensitive topics')}
                        description={t('admin.org_memory.sensitive_desc', 'Members can then choose, in their own settings, to let memory keep things such as health or beliefs. Nobody is opted in by default.')}
                        disabled={save.isPending}
                    />
                    <FormField
                        label={t('admin.org_memory.max_label', 'Memories per person')}
                        htmlFor="org-memory-max"
                        hint={t('admin.org_memory.max_hint', 'Between {min} and {max}. When someone reaches it, the least useful memories are retired first.', { min: ORG_MEMORY_MIN_PER_USER, max: ORG_MEMORY_MAX_PER_USER })}
                        error={max === null ? t('admin.org_memory.max_invalid', 'Enter a whole number between {min} and {max}.', { min: ORG_MEMORY_MIN_PER_USER, max: ORG_MEMORY_MAX_PER_USER }) : undefined}
                    >
                        <input
                            id="org-memory-max"
                            type="number"
                            inputMode="numeric"
                            min={ORG_MEMORY_MIN_PER_USER}
                            max={ORG_MEMORY_MAX_PER_USER}
                            value={maxRaw}
                            onChange={(e) => setMaxRaw(e.target.value)}
                            disabled={save.isPending}
                            aria-invalid={max === null}
                            className="w-32 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]"
                        />
                    </FormField>
                </div>
                <div className="mt-4 flex items-center gap-3 border-t border-[var(--border-subtle)] pt-4">
                    <Button onClick={onSave} disabled={!canSave} busy={save.isPending}>{save.isPending ? t('common.saving', 'Saving...') : t('common.save', 'Save')}</Button>
                    {dirty && !save.isPending && (
                        <Button variant="ghost" onClick={() => { setEnabled(server.settings.enabled); setSensitive(server.settings.sensitiveOptInAllowed); setMaxRaw(String(server.settings.maxPerUser)); }}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                    )}
                </div>
            </Section>

            <StatsSection stats={server.stats} />

            <Section
                title={t('admin.org_memory.danger_title', 'Danger zone')}
                description={t('admin.org_memory.danger_desc', 'Removes every memory of every member. Use it when the organisation wants a clean start.')}
                className="border-rose-600/30"
            >
                <Button variant="danger" onClick={() => setClearOpen(true)} data-testid="org-memory-clear">
                    {t('admin.org_memory.clear_button', 'Delete all memories in this organisation')}
                </Button>
            </Section>
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
        <section className="space-y-4 p-1" data-testid="org-memory" aria-labelledby="org-memory-title">
            <header>
                <h2 id="org-memory-title" className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
                    <Brain className="h-5 w-5" aria-hidden="true" />
                    {t('admin.org_memory.title', 'Memory')}
                </h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {t('admin.org_memory.intro', 'Whether the assistant remembers things about people across chats, and how much. Applies to everyone in the organisation.')}
                </p>
            </header>
            {query.isPending && (
                <div className="flex items-center gap-2 p-2 text-sm text-[var(--text-secondary)]" role="status">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('common.loading', 'Loading...')}
                </div>
            )}
            {query.isError && (
                <div className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)]" role="alert">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 text-[var(--error-ink)]" aria-hidden="true" />
                    <span className="flex-1">{t('admin.org_memory.load_failed', 'Could not load the memory settings.')}</span>
                    <button type="button" onClick={() => query.refetch()} className="text-sm underline">{t('admin.org_memory.retry', 'Try again')}</button>
                </div>
            )}
            {query.data && <Form key={orgId} orgId={orgId} server={query.data} />}
        </section>
    );
}
