import React, { useEffect, useEffectEvent, useState } from 'react';
import { Save, UploadCloud } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerSection, DrawerId } from '../../../../shared/SideDrawer';
import FindingRow from '../../../../shared/FindingRow';
import StatusPill from '../../shared/StatusPill';
import {
    Field, TextInput, DateInput, UserSelect, ActionButton, INPUT_CLASS, ReadFailed,
} from '../audits/auditForms';

/**
 * PolicyDrawer — the editor for one ISMS policy document (ISO 27001 A.5.1 /
 * clause 7.5). The legacy inline editor's handlers survive unchanged:
 * `onLoadDoc(slug)` fills the draft, `onSave(slug, patch)` writes it, and
 * "Publish" saves first and then freezes an immutable version.
 *
 * The "template not customised" nudge stays until the body actually diverges
 * from the seed (`edited`) — an unedited template is what an auditor spots
 * first.
 */
export default function PolicyDrawer({
    doc, orgUsers = null, busy = false, onLoadDoc, onSave, onPublish, onClose, mode = 'inline',
}) {
    const { t } = useTranslation();
    const slug = doc?.slug || null;
    const [draft, setDraft] = useState(null);
    const [failed, setFailed] = useState(false);

    const loadDoc = useEffectEvent((s) => onLoadDoc?.(s));
    useEffect(() => {
        let alive = true;
        setDraft(null);
        setFailed(false);
        if (!slug) return undefined;
        (async () => {
            try {
                const full = await loadDoc(slug);
                if (!alive) return;
                if (!full) { setFailed(true); return; }
                setDraft({
                    title: full.title || '',
                    body: full.draft_body || '',
                    owner_user_id: full.owner_user_id || '',
                    review_due_at: full.review_due_at ? String(full.review_due_at).slice(0, 10) : '',
                    edited: !!full.edited,
                    status: full.status,
                    current_version: full.current_version,
                    ack_count: full.ack_count,
                });
            } catch {
                if (alive) setFailed(true);
            }
        })();
        return () => { alive = false; };
    }, [slug]);

    if (!doc) return null;

    const patch = () => ({
        title: draft.title,
        body: draft.body,
        owner_user_id: draft.owner_user_id || null,
        review_due_at: draft.review_due_at || null,
    });
    const set = (p) => setDraft(d => ({ ...d, ...p }));

    const published = (draft ? draft.status : doc.status) === 'published';

    return (
        <SideDrawer
            open
            onClose={onClose}
            mode={mode}
            width={460}
            ariaLabel={doc.title || doc.slug}
            testId="policy-drawer"
            header={(
                <div className="flex flex-col gap-1 min-w-0">
                    <DrawerId testId="policy-drawer-slug">{doc.slug}</DrawerId>
                    <span className="text-sm font-bold text-[var(--text-primary)] truncate">{doc.title}</span>
                    <StatusPill tone={published ? 'success' : 'warning'} testId="policy-drawer-status">
                        {published
                            ? t('compliance.policies_published_v', 'Published v{version}', { version: doc.current_version })
                            : t('compliance.policies_draft', 'Draft')}
                    </StatusPill>
                </div>
            )}
        >
            {failed && (
                <ReadFailed testId="policy-drawer-failed">
                    {t('compliance.policies_read_failed', 'This document could not be read.')}
                </ReadFailed>
            )}

            {!failed && !draft && (
                <div className="text-xs text-[var(--text-tertiary)]" data-testid="policy-drawer-loading">
                    {t('compliance.policies_loading', 'Opening the document…')}
                </div>
            )}

            {draft && (
                <>
                    {!draft.edited && (
                        <FindingRow
                            severity="warning"
                            message={t('compliance.policies_customise_nudge', 'This is still the template text word for word. Adjust it to how you actually work before you publish it.')}
                            testId="policy-drawer-nudge"
                        />
                    )}

                    <DrawerSection label={t('compliance.policies_title_label', 'Title')}>
                        <TextInput value={draft.title} onChange={v => set({ title: v })} data-testid="policy-drawer-title" />
                    </DrawerSection>

                    <DrawerSection label={t('compliance.policies_body_label', 'Document text')}>
                        <textarea
                            value={draft.body}
                            rows={16}
                            spellCheck={false}
                            onChange={e => set({ body: e.target.value })}
                            aria-label={t('compliance.policies_body_label', 'Document text')}
                            className={`${INPUT_CLASS} font-mono text-[12px] leading-relaxed resize-y`}
                            data-testid="policy-drawer-body"
                        />
                    </DrawerSection>

                    <div className="grid grid-cols-2 gap-3">
                        <Field label={t('compliance.policies_owner', 'Owner')}>
                            <UserSelect
                                value={draft.owner_user_id}
                                orgUsers={orgUsers}
                                noneLabel={t('compliance.soa_owner_none', 'No owner')}
                                onChange={v => set({ owner_user_id: v })}
                                data-testid="policy-drawer-owner"
                            />
                        </Field>
                        <Field label={t('compliance.policies_review_due', 'Review due')}>
                            <DateInput value={draft.review_due_at} onChange={v => set({ review_due_at: v })} data-testid="policy-drawer-review" />
                        </Field>
                    </div>

                    {published && (
                        <div className="text-[11px] text-[var(--text-tertiary)]" data-testid="policy-drawer-republish">
                            {t('compliance.policies_republish_note', 'Publishing again creates a new version; acknowledgements are asked again.')}
                        </div>
                    )}

                    <div className="flex items-center gap-2 flex-wrap">
                        <ActionButton icon={Save} disabled={busy} onClick={() => onSave?.(slug, patch())} data-testid="policy-drawer-save">
                            {t('compliance.policies_save', 'Save draft')}
                        </ActionButton>
                        <ActionButton
                            variant="primary"
                            icon={UploadCloud}
                            disabled={busy}
                            title={t('compliance.policies_publish_hint', 'Freezes this text as a numbered version that members acknowledge.')}
                            onClick={async () => { await onSave?.(slug, patch()); await onPublish?.(slug); }}
                            data-testid="policy-drawer-publish"
                        >
                            {t('compliance.policies_publish', 'Publish')}
                        </ActionButton>
                    </div>
                </>
            )}
        </SideDrawer>
    );
}
