/**
 * The invite flow any people screen can start: the sheet's state, the role
 * options it offers, and what happens after — a toast when the e-mail went
 * out, or the manual-link banner when it did not. Members, Invitations and
 * billing's "Add user" (via /org/invitations?new=1) all open the same sheet.
 */

import { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import { useOrgRoles } from './queries';
import { roleOptions } from '../model/roles';
import type { InviteResult } from '../model/types';

export interface InviteFlow {
    open: () => void;
    /** Spread onto <InviteSheet>. */
    sheet: {
        visible: boolean;
        onClose: () => void;
        roleIds: readonly string[];
        onInvited: (result: InviteResult, address: string) => void;
    };
    /** The link to share by hand, when the e-mail did not go out. */
    manualLink: string | null;
    dismissLink: () => void;
}

export function useInviteFlow(enabled: boolean, startOpen = false): InviteFlow {
    const t = useTranslation();
    const { toast } = useToast();
    const roles = useOrgRoles(enabled);
    const [inviting, setInviting] = useState(enabled && startOpen);
    const [manualLink, setManualLink] = useState<string | null>(null);

    const onInvited = (result: InviteResult, address: string) => {
        setInviting(false);
        if (result.emailSent || !result.inviteUrl) {
            setManualLink(null);
            toast(t('mobile.orgPeople.invite_sent', 'Invitation sent to {email}', { email: address }), 'success');
        } else {
            setManualLink(result.inviteUrl);
        }
    };

    return {
        open: () => setInviting(true),
        sheet: {
            visible: inviting,
            onClose: () => setInviting(false),
            roleIds: roleOptions(roles.data?.roles ?? []),
            onInvited,
        },
        manualLink,
        dismissLink: () => setManualLink(null),
    };
}
