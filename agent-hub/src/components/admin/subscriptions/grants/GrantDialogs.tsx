// The three small dialogs of the licence grants list, in place of the
// browser's window.prompt: copy a blob by hand when the clipboard refuses,
// move an expiry date with a date picker, and import a blob into an
// organisation picked from the list (or the one the blob names).

import { useState } from 'react';
import { Copy } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { PRIMARY_BTN, SECONDARY_BTN } from '@/components/shared/adminUi';
import { Modal } from '../ui/Modal';
import { Field, Input, Select, Textarea } from '../ui/Input';

/** An organisation the import can bind to. */
interface GrantDialogOrg {
    id: string;
    name: string;
}

/** The blob in a read-only field, selected for copying, when the clipboard is not available. */
export function CopyBlobDialog({ blob, onClose }: { blob: string | null; onClose: () => void }) {
    const { t } = useTranslation();
    const copy = () => { void navigator.clipboard?.writeText(blob || '').catch(() => {}); };
    return (
        <Modal
            open={blob != null}
            onClose={onClose}
            title={t('admin_subscriptions.grants_copy_title', 'Copy the licence blob')}
            subtitle={t('admin_subscriptions.grants_copy_hint', 'The clipboard is not available here: select the text and copy it.')}
            width="max-w-lg"
            footer={(
                <>
                    <button type="button" onClick={copy} className={SECONDARY_BTN}><Copy className="h-3.5 w-3.5" aria-hidden="true" />{t('admin_subscriptions.grants_copy_again', 'Try copying again')}</button>
                    <button type="button" onClick={onClose} className={PRIMARY_BTN}>{t('admin_subscriptions.grants_done', 'Done')}</button>
                </>
            )}
        >
            <Field label={t('admin_subscriptions.grants_blob', 'Licence blob')}>
                <Textarea aria-label={t('admin_subscriptions.grants_blob', 'Licence blob')} readOnly rows={6} value={blob || ''} onFocus={e => e.currentTarget.select()} className="font-mono text-[11px]" />
            </Field>
        </Modal>
    );
}

interface ExtendDialogProps {
    /** The grant whose expiry moves, with its current expiry; null: closed. */
    grant: { id: string; expiresAt?: string | number | Date } | null;
    busy: boolean;
    onClose: () => void;
    /** The new expiry as YYYY-MM-DD. */
    onSave: (date: string) => void;
}

/** A new expiry date for a grant, picked in a date field (today or later). */
export function ExtendDialog({ grant, busy, onClose, onSave }: ExtendDialogProps) {
    const open = grant != null;
    return open ? <ExtendForm grant={grant} busy={busy} onClose={onClose} onSave={onSave} /> : null;
}

function ExtendForm({ grant, busy, onClose, onSave }: ExtendDialogProps & { grant: NonNullable<ExtendDialogProps['grant']> }) {
    const { t } = useTranslation();
    const [date, setDate] = useState(() => (grant.expiresAt ? new Date(grant.expiresAt).toISOString().slice(0, 10) : ''));
    const today = new Date().toISOString().slice(0, 10);
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
    return (
        <Modal
            open
            onClose={busy ? undefined : onClose}
            title={t('admin_subscriptions.grants_extend_title', 'Change the expiry date')}
            footer={(
                <>
                    <button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BTN}>{t('admin_subscriptions.ui_cancel', 'Cancel')}</button>
                    <button type="button" onClick={() => onSave(date)} disabled={busy || !valid} className={PRIMARY_BTN}>
                        {busy ? t('admin_subscriptions.ui_working', 'Working…') : t('admin_subscriptions.grants_extend_save', 'Save expiry')}
                    </button>
                </>
            )}
        >
            <Field label={t('admin_subscriptions.grants_expiry_label', 'Valid until')}>
                <Input type="date" value={date} min={today} onChange={e => setDate(e.target.value)} aria-label={t('admin_subscriptions.grants_expiry_label', 'Valid until')} />
            </Field>
        </Modal>
    );
}

interface ImportDialogProps {
    open: boolean;
    orgs: readonly GrantDialogOrg[];
    busy: boolean;
    onClose: () => void;
    /** The blob, and the organisation to bind it to (null: the one in the blob). */
    onImport: (blob: string, organizationId: string | null) => void;
}

/** Paste a licence blob and pick the organisation it binds to. */
export function ImportDialog({ open, ...rest }: ImportDialogProps) {
    return open ? <ImportForm open {...rest} /> : null;
}

function ImportForm({ orgs, busy, onClose, onImport }: ImportDialogProps) {
    const { t } = useTranslation();
    const [blob, setBlob] = useState('');
    const [orgId, setOrgId] = useState('');
    return (
        <Modal
            open
            onClose={busy ? undefined : onClose}
            title={t('admin_subscriptions.grants_import_title', 'Import a licence blob')}
            width="max-w-lg"
            footer={(
                <>
                    <button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BTN}>{t('admin_subscriptions.ui_cancel', 'Cancel')}</button>
                    <button type="button" onClick={() => onImport(blob.trim(), orgId || null)} disabled={busy || !blob.trim()} className={PRIMARY_BTN}>
                        {busy ? t('admin_subscriptions.ui_working', 'Working…') : t('admin_subscriptions.grants_import', 'Import blob')}
                    </button>
                </>
            )}
        >
            <div className="flex flex-col gap-4">
                <Field label={t('admin_subscriptions.grants_blob', 'Licence blob')}>
                    <Textarea aria-label={t('admin_subscriptions.grants_blob', 'Licence blob')} rows={5} value={blob} onChange={e => setBlob(e.target.value)} placeholder="beeflow-admin-v1.…" className="font-mono text-[11px]" />
                </Field>
                <Field label={t('admin_subscriptions.grants_import_org', 'Organisation')}>
                    <Select aria-label={t('admin_subscriptions.grants_import_org', 'Organisation')} value={orgId} onChange={e => setOrgId(e.target.value)}>
                        <option value="">{t('admin_subscriptions.grants_import_org_blob', 'The organisation named in the blob')}</option>
                        {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </Select>
                </Field>
            </div>
        </Modal>
    );
}
