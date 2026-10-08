import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../../components/shared/Modal';
import useTranslation from '../../../hooks/useTranslation';
import { documentRequest } from '../documentsApi';
import { docKeys, type LibraryRow } from '../documentQueries';
import { isNotebookRow } from './useLibrary';
import SharingRecipients, { type SharingDirectory } from './SharingRecipients';

interface Sharing { audience: 'private' | 'organisation' | 'restricted'; sharedGroups: string[]; sharedUserIds: string[]; organizationId?: string | null }
const CONTROL = 'rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 text-sm';
const needsRecipient = (value: Sharing | undefined) => value?.audience === 'restricted' && !value.sharedGroups.length && !value.sharedUserIds.length;

export default function DocumentSharingDialog({ row, onClose }: { row: LibraryRow; onClose: () => void }) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const base = `${isNotebookRow(row) ? '/notebooks' : ''}/${encodeURIComponent(row.id)}/sharing`;
    const [draft, setDraft] = useState<Sharing | null>(null);
    const sharing = useQuery({ queryKey: [...docKeys.all, 'sharing', row.docType, row.id], queryFn: async () => (await documentRequest(base) as { sharing: Sharing }).sharing });
    const directory = useQuery({ queryKey: [...docKeys.all, 'sharing-directory', row.docType, row.id], queryFn: () => documentRequest(`${base}/principals`) as Promise<SharingDirectory> });
    const value = draft || sharing.data;
    const save = useMutation({
        mutationFn: () => documentRequest(base, { audience: value!.audience, sharedGroups: value!.audience === 'restricted' ? value!.sharedGroups : [], sharedUserIds: value!.audience === 'restricted' ? value!.sharedUserIds : [] }, 'PUT'),
        onSuccess: async () => { await qc.invalidateQueries({ queryKey: docKeys.all }); onClose(); },
    });
    const change = (patch: Partial<Sharing>) => { if (value) setDraft({ ...value, ...patch }); save.reset(); };
    const toggle = (field: 'sharedGroups' | 'sharedUserIds', id: string) => {
        if (value) change({ [field]: value[field].includes(id) ? value[field].filter((x) => x !== id) : [...value[field], id] });
    };
    const error = sharing.error || directory.error || save.error;
    const empty = needsRecipient(value);
    return (
        <Modal open onClose={() => { if (!save.isPending) onClose(); }} title={t('documents.sharing.title', 'Share {name}', { name: row.name })} size="md"
            footer={<div className="flex justify-end gap-2"><button type="button" className={CONTROL} onClick={onClose} disabled={save.isPending}>{t('documents.cancel', 'Cancel')}</button><button type="button" className={`${CONTROL} bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]`} disabled={!value || sharing.isError || directory.isError || save.isPending || empty} onClick={() => save.mutate()}>{save.isPending ? t('documents.saving', 'Saving…') : t('common.save', 'Save')}</button></div>}>
            <div className="space-y-4">
                <p className="text-sm text-[var(--text-secondary)]">{t('documents.sharing.read_access', 'Recipients can read this document. Existing project edit permissions still apply.')}</p>
                {sharing.isPending && <p role="status">{t('documents.sharing.loading', 'Loading sharing settings…')}</p>}
                {error && <p role="alert" className="text-sm text-[var(--error)]">{error.message}</p>}
                {value && <>
                    <label className="block text-sm">{t('documents.sharing.audience', 'Who has access')}
                        <select className={`${CONTROL} block mt-1 w-full`} value={value.audience} disabled={save.isPending} onChange={(e) => change({ audience: e.target.value as Sharing['audience'] })}>
                            <option value="private">{t('documents.sharing.private', 'Private')}</option>
                            <option value="organisation" disabled={!value.organizationId}>{t('documents.sharing.organisation', 'Entire organisation')}</option>
                            <option value="restricted" disabled={!value.organizationId}>{t('documents.sharing.restricted', 'Specific users and groups')}</option>
                        </select>
                    </label>
                    {value.audience === 'restricted' && <SharingRecipients value={value} directory={directory.data} loading={directory.isPending} pending={save.isPending} empty={!!empty} toggle={toggle} clear={() => change({ sharedGroups: [], sharedUserIds: [] })} />}
                    {value.audience !== 'private' && <p className="text-sm text-[var(--text-secondary)]">{t('documents.sharing.encryption', 'When encryption is enabled, shared content uses organisation encryption so recipients can open it.')}</p>}
                </>}
            </div>
        </Modal>
    );
}
