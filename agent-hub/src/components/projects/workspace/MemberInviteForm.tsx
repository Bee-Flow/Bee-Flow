// Invite a person or a group into a project (owner only).
//
// Listing the organisation's users and groups is an admin permission. For an
// owner without it the directory answers 403, and the picker becomes a plain
// id field: invite still works, it just cannot show names.

import { UserPlus } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useInviteMember, type ProjectMembers } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import SegmentedControl from '../../shared/SegmentedControl';
import { useDirectoryGroups, useDirectoryUsers } from './homeQueries';
import { ErrorText, INPUT_CLASS, PrimaryButton, SELECT_CLASS } from './workspaceUi';

type InviteType = 'user' | 'group';
type InvitePermission = 'editor' | 'viewer';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PickerOption { id: string; label: string }

/** Directory entries that are not in the project yet, or null when the directory is closed to the caller. */
function useCandidates(type: InviteType, members: ProjectMembers | undefined): { options: PickerOption[] | null; loading: boolean } {
    const users = useDirectoryUsers(true);
    const groups = useDirectoryGroups(true);
    return useMemo(() => {
        const taken = new Set((members?.members || []).filter((m) => m.sharedWithType === type).map((m) => m.sharedWithId));
        if (type === 'user') {
            if (members?.ownerId) taken.add(members.ownerId);
            if (users.isPending) return { options: [], loading: true };
            if (!users.data) return { options: null, loading: false };
            return {
                options: users.data.filter((u) => !taken.has(u.id)).map((u) => ({ id: u.id, label: u.email && u.email !== u.name ? `${u.name} (${u.email})` : u.name })),
                loading: false,
            };
        }
        if (groups.isPending) return { options: [], loading: true };
        if (!groups.data) return { options: null, loading: false };
        return { options: groups.data.filter((g) => !taken.has(g.id)).map((g) => ({ id: g.id, label: g.name })), loading: false };
    }, [type, members, users.isPending, users.data, groups.isPending, groups.data]);
}

function SubjectPicker({ type, options, loading, value, onChange, inputRef }: {
    type: InviteType;
    options: PickerOption[] | null;
    loading: boolean;
    value: string;
    onChange: (v: string) => void;
    inputRef: React.RefObject<HTMLInputElement & HTMLSelectElement | null>;
}) {
    const { t } = useTranslation();
    const label = type === 'user'
        ? t('project_home.members.pick_user', 'Person')
        : t('project_home.members.pick_group', 'Group');
    if (options === null) {
        return (
            <input
                ref={inputRef}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                aria-label={type === 'user' ? t('project_home.members.user_id', 'User id') : t('project_home.members.group_id', 'Group id')}
                placeholder={t('project_home.members.id_placeholder', 'Paste the id (you cannot list the directory)')}
                className={`${INPUT_CLASS} h-8 py-1`}
                data-testid="member-invite-id"
            />
        );
    }
    return (
        <select
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
            disabled={loading}
            className={`${SELECT_CLASS} w-full`}
            data-testid="member-invite-picker"
        >
            <option value="">
                {loading ? t('project_home.loading', 'Loading…') : t('project_home.members.choose', 'Choose…')}
            </option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
    );
}

export default function MemberInviteForm({ projectId, members, focusRequest = 0 }: {
    projectId: string;
    members: ProjectMembers | undefined;
    /** Bump to move the focus into the form (the header's Invite button). */
    focusRequest?: number;
}) {
    const { t } = useTranslation();
    const headingId = useId();
    const invite = useInviteMember(projectId);
    const [type, setType] = useState<InviteType>('user');
    const [subject, setSubject] = useState('');
    const [permission, setPermission] = useState<InvitePermission>('viewer');
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement & HTMLSelectElement | null>(null);
    const { options, loading } = useCandidates(type, members);

    // Honour a focus request once the control can take focus: the picker is
    // disabled while the directory loads, and a disabled control ignores it.
    const focusHandled = useRef(0);
    useEffect(() => {
        if (focusRequest <= focusHandled.current || loading || !inputRef.current) return;
        focusHandled.current = focusRequest;
        inputRef.current.focus();
    }, [focusRequest, loading]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const id = subject.trim();
        if (!id) { setError(t('project_home.members.pick_first', 'Choose who to invite first.')); return; }
        if (options === null && !UUID_RX.test(id)) { setError(t('project_home.members.bad_id', 'That is not a valid id.')); return; }
        setError(null);
        try {
            await invite.mutateAsync({ sharedWithType: type, sharedWithId: id, permission });
            setSubject('');
        } catch (err) {
            setError(err instanceof Error ? err.message : t('project_home.members.invite_failed', 'Could not invite this member.'));
        }
    };

    return (
        <form onSubmit={submit} aria-labelledby={headingId} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3.5 space-y-3" data-testid="member-invite">
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <h3 id={headingId} className="text-[13px] font-semibold text-[var(--text-primary)] m-0">
                    {t('project_home.members.invite_title', 'Invite people')}
                </h3>
                <SegmentedControl
                    size="sm"
                    value={type}
                    onChange={(v) => { setType(v); setSubject(''); setError(null); }}
                    ariaLabel={t('project_home.members.invite_type', 'Invite a person or a group')}
                    options={[
                        { value: 'user', label: t('project_home.members.type_user', 'Person') },
                        { value: 'group', label: t('project_home.members.type_group', 'Group') },
                    ]}
                />
            </div>
            <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                <div className="flex-1 min-w-[12rem]">
                    <SubjectPicker type={type} options={options} loading={loading} value={subject} onChange={setSubject} inputRef={inputRef} />
                </div>
                <select
                    value={permission}
                    onChange={(e) => setPermission(e.target.value as InvitePermission)}
                    aria-label={t('project_home.members.invite_role', 'Role for the invite')}
                    className={SELECT_CLASS}
                    data-testid="member-invite-role"
                >
                    <option value="editor">{t('project_home.role.editor', 'Editor')}</option>
                    <option value="viewer">{t('project_home.role.viewer', 'Viewer')}</option>
                </select>
                <PrimaryButton type="submit" busy={invite.isPending} data-testid="member-invite-submit">
                    <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('project_home.members.invite', 'Invite')}
                </PrimaryButton>
            </div>
            <ErrorText testId="member-invite-error">{error}</ErrorText>
        </form>
    );
}
