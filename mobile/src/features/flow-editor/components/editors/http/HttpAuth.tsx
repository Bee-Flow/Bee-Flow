/**
 * Who the request signs in as — the web's HttpAuthPicker. Only the opaque
 * connection id lives in the automation; the secret stays in the vault and is
 * never shown. A step that names a credential this account can no longer
 * reach keeps showing it as such, rather than silently pointing elsewhere.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { SelectField } from '@/features/flow-editor/components/fields';
import { useHttpConnections } from '@/features/flow-editor/hooks';
import { TextField } from '@/shared/ui';

import { HTTP_KIND_NAMES } from './httpModel';
import { say } from '../declarative/runtime';
import { Note } from '../shared/Note';

/** The example in the fallback id box: an identifier, not copy. */
const CREDENTIAL_ID_EXAMPLE = 'credential id';

export function HttpAuth({ value, onChange, disabled }: { value: string; onChange: (connectionId: string | null) => void; disabled: boolean }) {
    const t = useTranslation();
    const conns = useHttpConnections();
    if (conns.isError) {
        return (
            <>
                <TextField value={value} onChangeText={(v) => onChange(v || null)} placeholder={CREDENTIAL_ID_EXAMPLE} autoCapitalize="none" autoCorrect={false} editable={!disabled} />
                <Note>{t('mobile.flow.http.credentials_unreadable', 'Could not load your credentials — paste a credential id instead.')}</Note>
            </>
        );
    }
    if (!conns.data) return <Note>{t('mobile.flow.http.credentials_loading', 'Loading credentials…')}</Note>;
    const known = !value || conns.data.some((c) => c.id === value);
    const kind = (k: string) => (HTTP_KIND_NAMES[k] ? say(t, HTTP_KIND_NAMES[k]) : k);
    return (
        <>
            <SelectField
                label={t('mobile.flow.http.credential', 'Credential')}
                value={value}
                options={[
                    { value: '', label: t('mobile.flow.http.no_credential', 'None (no credential)') },
                    ...(known ? [] : [{ value, label: t('mobile.flow.http.unknown_credential', 'Unknown credential (not accessible) — pick another'), disabled: true }]),
                    ...conns.data.map((c) => ({
                        value: c.id,
                        label: c.label,
                        description: c.access === 'lent' ? `${kind(c.kind)} · ${t('mobile.flow.http.shared_with_you', 'shared with you')}` : kind(c.kind),
                    })),
                ]}
                onChange={(id) => onChange(id || null)}
                disabled={disabled}
                testID="http-credential"
            />
            <Note>{t('mobile.flow.http.vault', "The secret is stored encrypted in your organization's vault and injected at run time. It is never shown here and never stored in the flow.")}</Note>
        </>
    );
}
