import { Loader2, ShieldCheck, X } from 'lucide-react';
import React from 'react';
import { normalizePermissions } from './permissionCopy';
import PermissionList from './PermissionList';
import { useTranslation } from '../../../hooks/useTranslation';
import Modal from '../../shared/Modal';

// mv2 permission consent. Opens when an install/update/sideload fails with
// consent_required; Accept re-fires the action with acceptedPermissions set to
// exactly the ids shown here. `diff` (update mode) marks which ids are new
// relative to the already-granted set.
export default function PermissionConsentDialog({ module, permissions, mode = 'install', diff = null, busy = false, onAccept, onCancel }) {
    const { t } = useTranslation();
    const perms = normalizePermissions(permissions);
    const title = mode === 'update'
        ? t('modules.consent_title_update', { name: module?.name || module?.id || '' })
        : t('modules.consent_title_install', { name: module?.name || module?.id || '' });

    return (
        <Modal
            open
            onClose={onCancel}
            size="lg"
            data-testid="permission-consent-dialog"
            // Granting permissions is a decision, not something to dismiss by
            // clicking past it.
            disableBackdropClose
            disableEscapeClose={busy}
            // Opened from inside the sideload dialog, which is itself a modal.
            zIndex={60}
            title={
                <span className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4" style={{ color: '#f59e0b' }} aria-hidden="true" />
                    {title}
                </span>
            }
            headerActions={
                <button onClick={onCancel} disabled={busy} className="p-1 rounded hover:bg-[var(--bg-tertiary)]" aria-label={t('modules.cancel')}>
                    <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </button>
            }
            footer={
                <>
                    <button
                        onClick={onCancel}
                        disabled={busy}
                        className="px-3 py-2 rounded-lg text-sm border disabled:opacity-50"
                        style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)', borderColor: 'var(--border-default)' }}
                    >
                        {t('modules.cancel')}
                    </button>
                    <button
                        onClick={() => onAccept(perms.map((p) => p.id))}
                        disabled={busy || perms.length === 0}
                        className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                        style={{ background: 'var(--accent-primary)', color: '#fff' }}
                        data-testid="consent-accept"
                    >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                        {t('modules.consent_accept')}
                    </button>
                </>
            }
        >
            <div className="space-y-3">
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {t('modules.consent_body')}
                </p>
                <div className="max-h-72 overflow-y-auto pr-1">
                    <PermissionList permissions={perms} diff={diff} />
                </div>
            </div>
        </Modal>
    );
}
