import { ServerCog } from 'lucide-react';
import { useState } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import Toggle from '@/components/shared/Toggle';

/** The platform role that makes an account a platform admin (server: users.role). */
export const PLATFORM_ADMIN_ROLE = 'admin';

export interface PlatformAdminFieldProps {
    /** The platform role in the form right now. */
    role: string;
    /** The platform role the account had when the form opened ('' for a new account). */
    storedRole: string;
    /** Who the form is for, as the confirmation names them. */
    personName: string;
    /** The form edits the signed-in account itself. */
    isSelf: boolean;
    /** The server's reason for refusing the last save of this field, if any. */
    refusal?: string | null;
    onChange: (role: string) => void;
    t: TranslateFn;
}

type Pending = 'grant' | 'stepDown' | null;

/**
 * The platform administrator switch of the user form. Shown only to a platform
 * admin, the one caller the server lets set or clear the role.
 *
 * Turning it on asks first, naming the person. Turning it off for someone else
 * is immediate; for yourself it asks first, because it ends your own access
 * to the instance-wide settings. The server keeps the last active platform
 * admin and refuses the save (code last_platform_admin); `refusal` shows that
 * reason here.
 */
export default function PlatformAdminField({ role, storedRole, personName, isSelf, refusal, onChange, t }: PlatformAdminFieldProps) {
    const [pending, setPending] = useState<Pending>(null);
    const checked = role === PLATFORM_ADMIN_ROLE;
    // Turning it off gives back the role the account had, or the plain user role.
    const roleWhenOff = storedRole && storedRole !== PLATFORM_ADMIN_ROLE ? storedRole : 'user';
    const name = personName || t('admin_org.platform_admin_this_person', 'this person');

    const request = (next: boolean) => {
        if (next) setPending('grant');
        else if (isSelf) setPending('stepDown');
        else onChange(roleWhenOff);
    };
    const confirm = () => {
        onChange(pending === 'grant' ? PLATFORM_ADMIN_ROLE : roleWhenOff);
        setPending(null);
    };

    return (
        <section aria-labelledby="platform-admin-heading" className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
            <div className="mb-1 flex items-center gap-2">
                <ServerCog className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
                <h4 id="platform-admin-heading" className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('admin_org.user_modal_server_access', 'Whole server')}
                </h4>
            </div>
            <Toggle
                id="user-platform-admin"
                checked={checked}
                onChange={request}
                label={t('admin_org.user_modal_platform_admin', 'Platform administrator')}
                description={t('admin_org.user_modal_platform_admin_hint', 'Can change settings for the whole server and see every organisation.')}
            />
            {refusal && (
                <p role="alert" className="mt-2 text-xs text-[var(--error-ink)]">{refusal}</p>
            )}
            <ConfirmDialog
                open={pending === 'grant'}
                title={t('admin_org.platform_admin_grant_title', 'Make {name} a platform administrator?', { name })}
                description={t('admin_org.platform_admin_grant_desc', '{name} can change settings for the whole server and see every organisation.', { name })}
                confirmLabel={t('admin_org.platform_admin_grant_confirm', 'Make platform administrator')}
                cancelLabel={t('admin.sec_cancel', 'Cancel')}
                onConfirm={confirm}
                onCancel={() => setPending(null)}
            />
            <ConfirmDialog
                open={pending === 'stepDown'}
                title={t('admin_org.platform_admin_self_off_title', 'Give up your platform administrator rights?')}
                description={t('admin_org.platform_admin_self_off_desc', 'After saving you can no longer change settings for the whole server or see every organisation. Another platform administrator would have to give the rights back.')}
                confirmLabel={t('admin_org.platform_admin_self_off_confirm', 'Give them up')}
                cancelLabel={t('admin.sec_cancel', 'Cancel')}
                destructive
                onConfirm={confirm}
                onCancel={() => setPending(null)}
            />
        </section>
    );
}
