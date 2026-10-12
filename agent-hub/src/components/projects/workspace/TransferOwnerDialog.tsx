// Hand a project to one of its members. The owner chooses what they stay as;
// an organisation admin rescuing a project whose owner is gone leaves no seat
// for that owner (the server decides), so the choice is not offered to them.

import React, { useState } from 'react';
import { useProjectMembersQuery, useTransferOwner } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import Modal from '../../shared/Modal';
import toast from '../../shared/Toast';
import { projectErrorText } from './projectErrorText';
import { ErrorText, PrimaryButton, SecondaryButton, SELECT_CLASS } from './workspaceUi';

type KeepAs = 'editor' | 'viewer' | 'none';

export default function TransferOwnerDialog({ open, onClose, projectId, ownerId, currentUserId }: {
    open: boolean;
    onClose: () => void;
    projectId: string;
    /** The owner the caller sees now; sent back so a change in between is refused. */
    ownerId: string | undefined;
    currentUserId: string | null | undefined;
}) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(open ? projectId : null);
    const transfer = useTransferOwner(projectId);
    const [target, setTarget] = useState('');
    const [keepMeAs, setKeepMeAs] = useState<KeepAs>('editor');
    const [error, setError] = useState<string | null>(null);
    const isOwner = !!currentUserId && currentUserId === ownerId;
    const candidates = (members.data?.members || [])
        .filter((m) => m.sharedWithType === 'user' && m.sharedWithId !== ownerId)
        .map((m) => ({ id: m.sharedWithId, name: members.data?.people?.[m.sharedWithId]?.name || t('project_home.transfer.unnamed', 'A member') }));

    const submit = async () => {
        if (!target) { setError(t('project_home.transfer.pick_first', 'Choose the new owner first.')); return; }
        setError(null);
        try {
            await transfer.mutateAsync({ toUserId: target, keepMeAs: isOwner ? keepMeAs : 'none', ...(ownerId ? { expectedOwnerId: ownerId } : {}) });
            toast.success(t('project_home.transfer.done', 'Ownership transferred.'));
            onClose();
        } catch (e) {
            setError(projectErrorText(t, e, t('project_home.transfer.failed', 'Could not transfer ownership.')));
        }
    };

    const keepOptions: Array<{ value: KeepAs; label: string }> = [
        { value: 'editor', label: t('project_home.transfer.keep_editor', 'Stay as editor') },
        { value: 'viewer', label: t('project_home.transfer.keep_viewer', 'Stay as viewer') },
        { value: 'none', label: t('project_home.transfer.keep_none', 'Leave the project') },
    ];

    return (
        <Modal
            open={open}
            onClose={onClose}
            title={t('project_home.transfer.title', 'Transfer ownership')}
            description={t('project_home.transfer.body', 'The new owner manages members and can delete the project. Only a member can become the owner.')}
            size="md"
            footer={(
                <div className="flex justify-end gap-2">
                    <SecondaryButton onClick={onClose}>{t('project_home.transfer.cancel', 'Cancel')}</SecondaryButton>
                    <PrimaryButton onClick={submit} busy={transfer.isPending} data-testid="transfer-confirm">
                        {t('project_home.transfer.confirm', 'Transfer')}
                    </PrimaryButton>
                </div>
            )}
        >
            <div className="space-y-4" data-testid="transfer-dialog">
                <label className="block space-y-1">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">{t('project_home.transfer.new_owner', 'New owner')}</span>
                    <select value={target} onChange={(e) => setTarget(e.target.value)} className={`${SELECT_CLASS} w-full`} data-testid="transfer-target">
                        <option value="">{members.isPending ? t('project_home.loading', 'Loading…') : t('project_home.members.choose', 'Choose…')}</option>
                        {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </label>
                {isOwner && (
                    <fieldset className="space-y-1.5 border-0 p-0 m-0">
                        <legend className="text-xs font-medium text-[var(--text-secondary)] mb-1">{t('project_home.transfer.afterwards', 'Afterwards, you')}</legend>
                        {keepOptions.map((o) => (
                            <label key={o.value} className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
                                <input type="radio" name="transfer-keep" value={o.value} checked={keepMeAs === o.value} onChange={() => setKeepMeAs(o.value)} />
                                {o.label}
                            </label>
                        ))}
                    </fieldset>
                )}
                <ErrorText testId="transfer-error">{error}</ErrorText>
            </div>
        </Modal>
    );
}
