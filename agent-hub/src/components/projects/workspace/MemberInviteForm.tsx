// Invite a person or a group into a project by typing a name.
//
// The picker searches the project's own organisation on the server (two
// characters or more) and never shows an e-mail address. Whoever may invite
// (the owner, and editors while the project allows it) sees this form; a 403
// from the search means the caller may not, and the form says so quietly.

import { UserPlus, X } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import type { Principal } from '../../../api/queries/automation/people';
import { useInviteMember, useProjectPrincipals, type ProjectMembers } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import PrincipalPicker, { PrincipalAvatar, principalDetail } from '../../automation/Builder/settings/PrincipalPicker';
import { projectErrorText } from './projectErrorText';
import { ErrorText, GhostButton, PrimaryButton, SELECT_CLASS } from './workspaceUi';

type InvitePermission = 'editor' | 'viewer';

/** `type:id` of everybody already in the project, so the picker does not offer them. */
function takenKeys(members: ProjectMembers | undefined): Set<string> {
    const taken = new Set<string>((members?.members || []).map((m) => `${m.sharedWithType}:${m.sharedWithId}`));
    if (members?.ownerId) taken.add(`user:${members.ownerId}`);
    return taken;
}

function ChosenPrincipal({ principal, onClear }: { principal: Principal; onClear: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]" data-testid="member-invite-chosen">
            <PrincipalAvatar principal={principal} />
            <span className="min-w-0 flex-1 text-xs">
                <span className="block truncate font-medium text-[var(--text-primary)]">{principal.name}</span>
                <span className="block truncate text-[var(--text-tertiary)]">{principalDetail(principal, t)}</span>
            </span>
            <GhostButton onClick={onClear} aria-label={t('project_home.members.pick_other', 'Choose someone else')}>
                <X className="w-3.5 h-3.5" aria-hidden="true" />
            </GhostButton>
        </div>
    );
}

function principalsOf(data: ReturnType<typeof useProjectPrincipals>['data']): Principal[] {
    return [
        ...(data?.groups || []).map((g): Principal => ({ type: 'group', id: g.id, name: g.name, detail: null, memberCount: g.memberCount })),
        ...(data?.users || []).map((u): Principal => ({ type: 'user', id: u.id, name: u.name, detail: null, memberCount: null })),
    ];
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
    const [query, setQuery] = useState('');
    const [chosen, setChosen] = useState<Principal | null>(null);
    const [permission, setPermission] = useState<InvitePermission>('viewer');
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const search = useProjectPrincipals(projectId, query);
    const taken = useMemo(() => takenKeys(members), [members]);

    const principals = useMemo(() => principalsOf(search.data), [search.data]);

    // Honour a focus request once the input exists.
    const focusHandled = useRef(0);
    useEffect(() => {
        if (focusRequest <= focusHandled.current || !inputRef.current) return;
        focusHandled.current = focusRequest;
        inputRef.current.focus();
    }, [focusRequest, chosen]);

    if (search.error instanceof ApiError && search.error.status === 403) {
        return (
            <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]" data-testid="member-invite-owner-only">
                {t('project_home.members.ask_owner', 'Ask the owner to invite people.')}
            </p>
        );
    }

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!chosen) { setError(t('project_home.members.pick_first', 'Choose who to invite first.')); return; }
        setError(null);
        try {
            await invite.mutateAsync({ sharedWithType: chosen.type, sharedWithId: chosen.id, permission });
            setChosen(null);
            setQuery('');
        } catch (err) {
            setError(projectErrorText(t, err, t('project_home.members.invite_failed', 'Could not invite this member.')));
        }
    };

    return (
        <form onSubmit={submit} aria-labelledby={headingId} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3.5 space-y-3" data-testid="member-invite">
            <h3 id={headingId} className="text-[13px] font-semibold text-[var(--text-primary)] m-0">
                {t('project_home.members.invite_title', 'Invite people')}
            </h3>
            <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                <div className="flex-1 min-w-[12rem]">
                    {chosen ? (
                        <ChosenPrincipal principal={chosen} onClear={() => setChosen(null)} />
                    ) : (
                        <PrincipalPicker
                            inputRef={inputRef}
                            exclude={taken}
                            onPick={(p) => { setChosen(p); setError(null); }}
                            label={t('project_home.members.search_label', 'Search people and groups')}
                            placeholder={t('project_home.members.search_placeholder', 'Type a name…')}
                            source={{ principals, loading: search.isFetching, onQuery: setQuery, minChars: 2 }}
                        />
                    )}
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
