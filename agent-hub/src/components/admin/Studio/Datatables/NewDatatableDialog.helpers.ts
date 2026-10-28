import React from 'react';
import { sourceErrorMessage } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import { ORG_SCOPE_PERMISSION } from './newDatatable/constants';
import { checkPermission, type PermissionUser } from '@/hooks/usePermissionCheck';
import type { TableColumn } from '../AppStudio/inspector/aiFieldMatching';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { WizardError } from './spreadsheet/wizardState';
import type { ConnectionOption } from '../Solutions/pipeline/settings/stageSettingsApi';
import type { AiTableDraft } from './AiTablePanel';
import { type SubmitDraftArgs } from './NewDatatableDialog.types';

/**
 * May this account create an ORGANISATION table?
 *
 * Three answers, not two, and the third is the one worth writing down. The
 * dialog is handed a session, and a session that carries no permission facts
 * at ALL — no `permissions` array, no `isAdmin` — has not told us "no", it has
 * told us nothing. Reading that silence as a refusal would hide the
 * organisation card from the org admin the Studio section exists for, on every
 * call site that never passed a user. So unknown keeps the choice; only a
 * session that states its permissions and lacks this one loses it, and the
 * server stays the authority either way.
 */
function mayCreateOrgTable(user: PermissionUser | null) {
    const stated = Array.isArray(user?.permissions) || typeof user?.isAdmin === 'boolean';
    if (!stated) return true;
    return checkPermission(user, ORG_SCOPE_PERMISSION);
}

/** What each machine-readable refusal means to a person. */
function messageFor(t: TranslateFn, err: WizardError) {
    const source = sourceErrorMessage(t, err);
    if (source) return source;
    switch (err?.code) {
        case 'key_taken': return t('datatables.err_key_taken', 'There is already a table with this key. Pick another one.');
        case 'no_organisation': return t('datatables.err_no_org', 'This account is not in an organisation, so it can only make a personal table.');
        // The server's refusal says which limit, in the reader's language, and what to do about it.
        case 'quota_exceeded': return err?.message || t('datatables.err_quota', 'You have reached the limit on tables here.');
        case 'bad_scope': return t('datatables.err_bad_scope', 'Choose whether the table is for your organisation or for this account.');
        case 'unknown_managed_kind': return t('datatables.err_unknown_kind', 'This workspace does not know how to fill in that kind of table.');
        default: return err?.message || t('datatables.err_create', 'Could not create the table');
    }
}

/**
 * Whether this account may CHOOSE the organisation, and whether the choice is
 * missing only because a permission is.
 */
export function orgScopeChoice(scope: ConnectionOption | null, user: PermissionUser | null) {
    // The server's default for this caller, so the dialog opens on the answer
    // it would have given. Keyed on 'org' rather than on NOT-'user', because
    // the list can also answer `scope: null` (no tenancy at all): the old
    // condition then showed the personal sentence and submitted `organisation`,
    // which is the shape of copy-says-one-thing-request-says-another that sent
    // BFSF-412 round twice.
    //
    // And the tenancy is only half the question. The choice needs BOTH a
    // tenancy to put a table in and the permission the server asks for before
    // it will accept one; offering it on the tenancy alone is the same failure
    // one layer down, answered after the click by a 403 instead of before it.
    const mayUseOrgScope = mayCreateOrgTable(user);
    const canChoose = scope?.kind === 'org' && mayUseOrgScope;
    // The organisation is there, the permission is not — the one case that
    // gets its own sentence, because a missing card with no explanation reads
    // as a product that forgot the feature.
    const orgScopeWithheld = scope?.kind === 'org' && !mayUseOrgScope;
    return { canChoose, orgScopeWithheld };
}

export async function submitDraft(e: React.SyntheticEvent<Element, Event> | React.SubmitEvent<HTMLFormElement>, {
    nextcloud, spreadsheet, managed, target, name, effectiveKey, description, fields, t, onCreated,
    setPicking, setBusy, setError, setCreated,
}: SubmitDraftArgs) {
    e.preventDefault();
    if (nextcloud) { setPicking('nextcloud'); return; }
    if (spreadsheet) { setPicking('spreadsheet'); return; }
    setBusy(true);
    setError(null);
    try {
        if (managed) {
            const body = await datatablesApi.createManaged({
                kind: 'http_cache',
                scope: target,
                name: name.trim(),
                key: effectiveKey,
                // Omitted, not blanked: undefined is what makes the server
                // use its own Art. 30 sentence for the kind.
                ...(description.trim() ? { description: description.trim() } : {}),
            });
            setCreated(body);
        } else {
            const body = await datatablesApi.create({
                scope: target,
                name: name.trim(),
                key: effectiveKey,
                description: description.trim(),
                fields: fields.map(f => ({ key: f.key, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })),
            });
            onCreated(body.datatable);
        }
    } catch (err) {
        // Read the CODE, not the sentence: the server's wording is a
        // server-side decision and a client that matches on it breaks the
        // day somebody improves the copy.
        setError(messageFor(t, err as WizardError));
    } finally {
        setBusy(false);
    }
}

/** An AI draft (or its undo) fills the dialog; nothing is created until "Create". */
export function applyDraft(d: AiTableDraft, { setName, setDescription, setFields, setKeyTouched }: {
    setName: (name: string) => void;
    setDescription: (description: string) => void;
    setFields: (fields: TableColumn[]) => void;
    setKeyTouched: (touched: boolean) => void;
}) {
    // Undo hands back what the dialog held; a draft fills
    // name, purpose and columns and lets the key follow the
    // name again. Nothing is created until "Create".
    setName(d.name || '');
    setDescription(d.description || '');
    setFields((Array.isArray(d.fields) ? d.fields as TableColumn[] : []).map(f => ({
        key: f.key, name: f.name, type: f.type,
        ...(f.options ? { options: f.options } : {}),
        ...(f.required ? { required: true } : {}),
    })));
    if (!d.undo) setKeyTouched(false);
}
