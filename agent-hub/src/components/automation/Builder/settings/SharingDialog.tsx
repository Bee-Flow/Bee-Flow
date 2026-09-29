import React, { useMemo, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import Modal from '../../../shared/Modal';
import { useTranslation } from '../../../../hooks/useTranslation';
import {
    ROLES, useAutomationShares, useSaveShares, useTransferOwner,
    type Principal, type Share, type ShareRole, type TransferResult,
} from '../../../../api/queries/automation/people';
import PrincipalPicker, { PrincipalAvatar, principalDetail } from './PrincipalPicker';
import { PRIMARY_BTN, SECONDARY_BTN, SELECT } from './settingsUi';

type T = ReturnType<typeof useTranslation>['t'];

export function roleLabel(role: ShareRole, t: T): string {
    if (role === 'edit') return t('routines.sharing.role_edit', 'Can edit');
    if (role === 'view') return t('routines.sharing.role_view', 'Can view');
    return t('routines.sharing.role_run', 'Can start');
}

function roleHint(role: ShareRole, t: T): string {
    if (role === 'edit') return t('routines.sharing.role_edit_hint', 'Change steps, activate');
    if (role === 'view') return t('routines.sharing.role_view_hint', 'See steps and all runs');
    return t('routines.sharing.role_run_hint', 'Use the button, see their own runs');
}

/** The licence gate's refusal in words; otherwise the server's own sentence, else a generic one. */
export function sharingErrorText(e: { status?: number; code?: string | null; serverMessage?: string | null }, t: T): string {
    if (e.code === 'feature_locked' || e.code === 'feature_disabled') {
        return t('routines.sharing.locked', 'Sharing with colleagues is not part of your plan.');
    }
    if (e.serverMessage) return e.serverMessage;
    if (e.status === 403) return t('routines.sharing.owner_only', 'Only the owner can change who has access.');
    return t('routines.sharing.save_failed', 'Could not save who has access. Try again.');
}

function loadingText(loading: boolean, t: T): string {
    return loading ? t('routines.people.loading', 'Loading people…') : '';
}

const keyOf = (s: { principalType?: string; type?: string; principalId?: string; id?: string }) =>
    `${s.principalType || s.type}:${s.principalId || s.id}`;

/**
 * "Who can do what with <routine>" (artboard 5e-5): add a person or group
 * with a role, change or remove roles, and hand the routine over. Every change
 * saves right away; "Done" only closes.
 */
export default function SharingDialog({ open, onClose, automationId, title, isMine, youOwn, canAdd = true, onTransferred }: {
    open: boolean;
    onClose: () => void;
    automationId: string;
    title: string;
    /** The viewer may change who has access (the owner, or an org admin). */
    isMine: boolean;
    /** The viewer IS the owner (not an admin acting for them): "(you)". */
    youOwn?: boolean;
    /** The plan allows adding people (removing is always allowed). */
    canAdd?: boolean;
    /** The routine changed hands; carries the row as the caller now sees it. */
    onTransferred?: (result: TransferResult) => void;
}) {
    const { t } = useTranslation();
    const shares = useAutomationShares(automationId, { enabled: open });
    const save = useSaveShares(automationId);
    const [transferring, setTransferring] = useState(false);
    const [transferNote, setTransferNote] = useState<string | null>(null);
    const transfer = useTransferOwner(automationId, {
        onDone: (result) => {
            setTransferring(false);
            setTransferNote(result.warnings[0] || null);
            onTransferred?.(result);
        },
    });
    const list = useMemo(() => shares.data?.shares || [], [shares.data]);
    const taken = useMemo(() => new Set(list.map(keyOf)), [list]);
    const owner = shares.data?.owner;
    const runsAs = shares.data?.runsAs || owner;
    const editors = list.filter(s => s.principalType === 'user' && s.role === 'edit');
    const error = save.error || transfer.error;

    const add = (p: Principal, role: ShareRole) => save.mutate([...list, {
        principalType: p.type, principalId: p.id, name: p.name, memberCount: p.memberCount, role,
    }]);
    const setRole = (s: Share, role: ShareRole | '') => save.mutate(role
        ? list.map(x => (keyOf(x) === keyOf(s) ? { ...x, role } : x))
        : list.filter(x => keyOf(x) !== keyOf(s)));

    const ownerLabel = owner ? owner.name : loadingText(shares.isLoading, t);
    const heading = t('routines.sharing.dialog_title', 'Who can do what with "{title}"', { title });
    return (
        <Modal open={open} onClose={onClose} size="auto" className="w-full max-w-[620px]" label={heading} variant="bare">
            <div className="rounded-[14px] bg-[var(--bg-card)] shadow-xl text-xs text-[var(--text-primary)] flex flex-col max-h-[90vh] overflow-hidden">
                <div className="px-[18px] py-3.5 flex items-center gap-2 border-b border-[var(--border-default)]">
                    <h2 className="font-semibold text-sm truncate">{heading}</h2>
                    <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')} className="ml-auto p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <X className="w-[15px] h-[15px]" aria-hidden />
                    </button>
                </div>
                <div className="@container/share px-[18px] py-3.5 flex flex-col gap-2.5 overflow-y-auto">
                    {isMine && canAdd && <AddRow automationId={automationId} taken={taken} onAdd={add} />}

                    <ul className="flex flex-col rounded-[10px] border border-[var(--border-default)] overflow-hidden" aria-label={t('routines.sharing.list', 'People with access')}>
                        <OwnerRow name={owner?.name} label={ownerLabel} you={youOwn ?? isMine} />
                        {list.map(s => (
                            <ShareRow key={keyOf(s)} share={s} editable={isMine} busy={save.isPending} onRole={(role) => setRole(s, role)} />
                        ))}
                    </ul>

                    <RoleCards />
                    <RunsAsLine name={runsAs?.name} canChange={isMine} open={transferring} onToggle={() => setTransferring(v => !v)} />
                    {transferring && (
                        <TransferOwner
                            editors={editors}
                            busy={transfer.isPending}
                            onTransfer={(userId) => transfer.mutate(userId)}
                        />
                    )}
                    {transferNote && <p role="status" className="text-[var(--warning)]">{transferNote}</p>}
                    {error && <p role="alert" className="text-[var(--error)]">{sharingErrorText(error, t)}</p>}
                </div>
                <div className="px-[18px] py-3 border-t border-[var(--border-default)] flex justify-end">
                    <button type="button" onClick={onClose} className={PRIMARY_BTN}>{t('routines.sharing.done', 'Done')}</button>
                </div>
            </div>
        </Modal>
    );
}

function OwnerRow({ name, label, you }: { name?: string; label: string; you: boolean }) {
    const { t } = useTranslation();
    return (
        <li className="flex items-center gap-2.5 px-3 py-[9px]">
            <PrincipalAvatar principal={{ type: 'user', name: name || '?' }} />
            <div className="font-medium min-w-0 truncate">
                {label}
                {you && <span className="text-[var(--text-tertiary)]"> {t('routines.sharing.you', '(you)')}</span>}
            </div>
            <span className="ml-auto text-[var(--text-secondary)]">{t('routines.sharing.role_owner', 'Owner')}</span>
        </li>
    );
}

/** Search field + the role the new person or group gets. */
function AddRow({ automationId, taken, onAdd }: { automationId: string; taken: Set<string>; onAdd: (p: Principal, role: ShareRole) => void }) {
    const { t } = useTranslation();
    const [role, setRole] = useState<ShareRole>('run');
    return (
        <div className="flex gap-2">
            <PrincipalPicker automationId={automationId} onPick={(p) => onAdd(p, role)} exclude={taken} />
            <select
                aria-label={t('routines.sharing.new_role', 'Role for the new person or group')}
                value={role}
                onChange={(e) => setRole(e.target.value as ShareRole)}
                className={`${SELECT} py-[7px]`}
            >
                {ROLES.map(r => <option key={r} value={r}>{roleLabel(r, t)}</option>)}
            </select>
        </div>
    );
}

function ShareRow({ share, editable, busy, onRole }: { share: Share; editable: boolean; busy: boolean; onRole: (role: ShareRole | '') => void }) {
    const { t } = useTranslation();
    return (
        <li className="flex items-center gap-2.5 px-3 py-[9px] border-t border-[var(--border-default)]">
            <PrincipalAvatar principal={{ type: share.principalType, name: share.name }} />
            <div className="min-w-0">
                <div className="font-medium truncate">{share.name}</div>
                <div className="text-[var(--text-tertiary)] truncate">{principalDetail({ type: share.principalType, memberCount: share.memberCount }, t)}</div>
            </div>
            {editable ? (
                <select
                    aria-label={t('routines.sharing.role_of', 'Role of {name}', { name: share.name })}
                    value={share.role}
                    // One change at a time: each save sends the whole list.
                    disabled={busy}
                    onChange={(e) => onRole(e.target.value as ShareRole | '')}
                    className={`${SELECT} ml-auto`}
                >
                    {ROLES.map(r => <option key={r} value={r}>{roleLabel(r, t)}</option>)}
                    <option value="">{t('routines.sharing.remove', 'Remove access')}</option>
                </select>
            ) : (
                <span className="ml-auto text-[var(--text-secondary)]">{roleLabel(share.role, t)}</span>
            )}
        </li>
    );
}

function RoleCards() {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-1 @[480px]/share:grid-cols-3 gap-2">
            {ROLES.map(r => (
                <div key={r} className="p-2.5 rounded-[10px] bg-[var(--bg-secondary)]">
                    <div className="font-semibold">{roleLabel(r, t)}</div>
                    <div className="text-[var(--text-tertiary)] leading-[15px] mt-0.5">{roleHint(r, t)}</div>
                </div>
            ))}
        </div>
    );
}

/** "Steps run as <owner>, not as whoever starts it · change" */
function RunsAsLine({ name, canChange, open, onToggle }: { name?: string; canChange: boolean; open: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 flex-wrap px-3 py-[9px] rounded-lg border border-[var(--border-default)]">
            <KeyRound className="w-[13px] h-[13px] text-[var(--text-secondary)]" aria-hidden />
            <span>{t('routines.sharing.runs_as', 'Steps run as')}</span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-secondary)] font-medium">{name || t('routines.sharing.role_owner', 'Owner')}</span>
            <span className="text-[var(--text-tertiary)]">{t('routines.sharing.runs_as_not', 'not as whoever starts it')}</span>
            {canChange && (
                <button type="button" onClick={onToggle} aria-expanded={open} className="ml-auto underline text-[var(--text-secondary)]">
                    {t('routines.sharing.change', 'change')}
                </button>
            )}
        </div>
    );
}

/**
 * Hand the routine to someone who can already edit it. Steps then run as that
 * person: their connections and their access, so this is said before it happens.
 */
function TransferOwner({ editors, busy, onTransfer }: { editors: Share[]; busy: boolean; onTransfer: (userId: string) => void }) {
    const { t } = useTranslation();
    const [userId, setUserId] = useState('');
    if (!editors.length) {
        return (
            <p className="px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                {t('routines.sharing.transfer_none', 'Give someone "Can edit" first. Then you can make them the owner, and steps run as them.')}
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg bg-[var(--bg-secondary)]">
            <p className="text-[var(--text-secondary)]">
                {t('routines.sharing.transfer_hint', 'From the next run, steps use the new owner\'s connections and access.')}
            </p>
            <div className="flex gap-2 items-center">
                <select
                    aria-label={t('routines.sharing.transfer_to', 'New owner')}
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    className={`${SELECT} flex-1 min-w-0`}
                >
                    <option value="">{t('routines.sharing.transfer_pick', 'Choose the new owner…')}</option>
                    {editors.map(s => <option key={s.principalId} value={s.principalId}>{s.name}</option>)}
                </select>
                <button type="button" disabled={!userId || busy} onClick={() => onTransfer(userId)} className={SECONDARY_BTN}>
                    {t('routines.sharing.transfer', 'Make owner')}
                </button>
            </div>
        </div>
    );
}
