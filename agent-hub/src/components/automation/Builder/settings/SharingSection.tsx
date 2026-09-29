import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useAutomationShares, type AutomationShares, type Share, type ShareRole } from '../../../../api/queries/automation/people';
import SharingDialog from './SharingDialog';
import { SectionHeading, type SaveFn, type SettingsAutomation } from './settingsUi';
import { useSharingLocked } from './useSharingLocked';

type T = ReturnType<typeof useTranslation>['t'];

/** "everyone in Finance, S. de Boer" for one role, or null when nobody has it. */
function whoHas(shares: Share[], role: ShareRole, t: T): string | null {
    const names = shares.filter(s => s.role === role).map(s => (s.principalType === 'group'
        ? t('routines.sharing.everyone_in', 'everyone in {name}', { name: s.name })
        : s.name));
    return names.length ? names.join(', ') : null;
}

function Pill({ label, value }: { label: string; value: string }) {
    return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full border border-[var(--border-default)] bg-[var(--bg-card)]">
            <b className="font-semibold">{label}</b>
            <span className="text-[var(--text-secondary)]">{value}</span>
        </span>
    );
}

function RolePills({ list, onChange, canChange }: { list: Share[]; onChange?: () => void; canChange: boolean }) {
    const { t } = useTranslation();
    const onlyOwner = t('routines.sharing.only_owner', 'only the owner');
    const viewers = whoHas(list, 'view', t);
    return (
        <>
            <Pill label={t('routines.sharing.role_edit', 'Can edit')} value={whoHas(list, 'edit', t) || onlyOwner} />
            <Pill label={t('routines.sharing.role_run', 'Can start')} value={whoHas(list, 'run', t) || onlyOwner} />
            {viewers && <Pill label={t('routines.sharing.role_view', 'Can view')} value={viewers} />}
            {onChange && (
                <button
                    type="button"
                    onClick={onChange}
                    className="px-2.5 py-[5px] rounded-full border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                >
                    {canChange ? t('routines.sharing.change_pill', 'Change') : t('routines.sharing.view_pill', 'View')}
                </button>
            )}
        </>
    );
}

/** What the section shows, from the shares answer (when it came) and what the page knows. */
function viewOf(data: AutomationShares | undefined, planLocked: boolean, isMine: boolean, t: T) {
    const fallbackOwner = isMine ? t('routines.sharing.you_plain', 'you') : '';
    if (!data) return { locked: planLocked, canManage: isMine, ownerName: fallbackOwner };
    return {
        locked: planLocked || data.sharingAvailable === false,
        canManage: data.canManage ?? isMine,
        ownerName: data.owner?.name || fallbackOwner,
    };
}

function routineFacts(a: SettingsAutomation | null) {
    return {
        id: a?.id || null,
        title: a?.title || '',
        // A row without `myRole` predates sharing: only its owner could load it.
        isMine: (a?.myRole ?? 'owner') === 'owner',
        // An org admin gets myRole 'owner' too, but is not the owner.
        youOwn: (a?.myRole ?? 'owner') === 'owner' && a?.accessVia !== 'admin',
    };
}

/**
 * Settings › Who can do what (artboard 5b): who owns the routine, who may edit
 * and who may start it, as pills; "Change" opens the sharing dialog (5e-5).
 * Sharing is a plan feature (`automation_sharing`); without it the section
 * shows the owner and says why there is nothing to change.
 */
export default function SharingSection({ automation, onAutomationChange }: {
    automation: SettingsAutomation | null;
    onSave?: SaveFn;
    /** The routine row changed outside `onSave` (an ownership transfer). */
    onAutomationChange?: (next: SettingsAutomation) => void;
}) {
    const { t } = useTranslation();
    const planLocked = useSharingLocked();
    const [open, setOpen] = useState(false);
    const { id, title, isMine, youOwn } = routineFacts(automation);
    const shares = useAutomationShares(id);
    const { locked, canManage, ownerName } = viewOf(shares.data, planLocked, isMine, t);
    // Existing shares keep working after the plan lapses, and taking access
    // away is never gated: they stay visible and removable.
    const existing = shares.data?.shares || [];
    const showList = !locked || existing.length > 0;

    return (
        <div className="flex flex-col gap-2.5 text-xs" data-testid="sharing-section">
            <SectionHeading>{t('routines.sharing.title', 'Who can do what')}</SectionHeading>
            <div className="flex gap-2 flex-wrap items-center">
                <Pill label={t('routines.sharing.role_owner', 'Owner')} value={ownerName} />
                {showList && <RolePills list={existing} canChange={canManage} onChange={id ? () => setOpen(true) : undefined} />}
            </div>
            {locked && (
                <p className="flex items-center gap-1.5 text-[var(--text-tertiary)]" data-testid="sharing-locked">
                    <Lock className="w-3 h-3" aria-hidden />
                    {existing.length
                        ? t('routines.sharing.locked_hint_existing', 'Sharing with more colleagues is available on a higher plan. The people who already have access keep it, and you can still remove them.')
                        : t('routines.sharing.locked_hint', 'Sharing an automation with colleagues is available on a higher plan. Until then only you can see, start and edit it.')}
                </p>
            )}
            {id && showList && (
                <SharingDialog
                    open={open}
                    onClose={() => setOpen(false)}
                    automationId={id}
                    title={title}
                    isMine={canManage}
                    youOwn={youOwn}
                    canAdd={!locked}
                    onTransferred={(result) => {
                        if (result.automation && automation) onAutomationChange?.({ ...automation, ...result.automation });
                    }}
                />
            )}
        </div>
    );
}
