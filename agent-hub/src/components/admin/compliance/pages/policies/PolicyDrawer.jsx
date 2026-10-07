import React, { useEffect, useEffectEvent, useState } from 'react';
import { Save, UploadCloud } from 'lucide-react';
import { baselineOf, draftOf, publishQuestion, unchangedSincePublished } from './policyDraft';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerSection, DrawerId, DrawerFooter } from '../../../../shared/SideDrawer';
import FindingRow from '../../../../shared/FindingRow';
import RegisterStatePill from '../../shared/RegisterStatePill';
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
 * first. It is a drawer-sized callout (FindingRow size="sm"), not the
 * loudest text on the page.
 *
 * Publishing asks every member to acknowledge again, so it is never a
 * reflex: "Publish" is disabled while title and text equal the published
 * version (ismsDocStore.getDoc's `published`), and otherwise asks first,
 * inline, with the number of acknowledgements it resets. A document never
 * published (or a server that does not send `published`) can always be
 * published, still behind the same question (policyDraft.ts holds those
 * rules). Save draft (left) and Publish (right) sit in the DrawerFooter.
 */
export const POLICY_DRAWER_WIDTH = 460;

/** The status pill with the version: "Published · v3" / "Draft". The table draws the same one. */
export function PolicyStatusPill({ status, version, className = '', testId = undefined }) {
    const { t } = useTranslation();
    const published = status === 'published';
    return (
        <RegisterStatePill state={published ? 'published' : 'draft'} className={className} testId={testId}>
            {published
                ? t('compliance.pol_status_published_v', 'Published · v{n}', { n: version ?? '—' })
                : t('compliance.pol_status_draft', 'Draft')}
        </RegisterStatePill>
    );
}

export default function PolicyDrawer({
    doc, orgUsers = null, busy = false, onLoadDoc, onSave, onPublish, onClose, mode = 'inline',
}) {
    const { t } = useTranslation();
    const slug = doc?.slug || null;
    const [draft, setDraft] = useState(null);
    const [baseline, setBaseline] = useState(null);
    const [failed, setFailed] = useState(false);
    const [confirming, setConfirming] = useState(false);

    const loadDoc = useEffectEvent((s) => onLoadDoc?.(s));
    useEffect(() => {
        let alive = true;
        setDraft(null);
        setBaseline(null);
        setFailed(false);
        setConfirming(false);
        if (!slug) return undefined;
        (async () => {
            try {
                const full = await loadDoc(slug);
                if (!alive) return;
                if (!full) { setFailed(true); return; }
                setDraft(draftOf(full));
                setBaseline(baselineOf(full));
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
    const set = (p) => { setDraft(d => ({ ...d, ...p })); if ('title' in p || 'body' in p) setConfirming(false); };

    const status = draft ? draft.status : doc.status;
    const version = draft ? draft.current_version : doc.current_version;
    const published = status === 'published';
    const unchanged = unchangedSincePublished(draft, baseline);
    const nextVersion = (Number(version) || 0) + 1;
    const acks = typeof draft?.ack_count === 'number' ? draft.ack_count : (typeof doc.ack_count === 'number' ? doc.ack_count : null);

    const publish = async () => {
        setConfirming(false);
        await onSave?.(slug, patch());
        await onPublish?.(slug);
        // The new version is now the baseline: read it back rather than guess.
        try {
            const full = await onLoadDoc?.(slug);
            if (full) { setDraft(draftOf(full)); setBaseline(baselineOf(full)); }
        } catch { /* the list refresh still shows the new version */ }
    };

    const saveButton = (
        <ActionButton icon={Save} disabled={busy} onClick={() => onSave?.(slug, patch())} data-testid="policy-drawer-save">
            {t('compliance.policies_save', 'Save draft')}
        </ActionButton>
    );

    const footer = draft && (confirming ? (
        <div className="flex flex-col gap-2" role="group" aria-label={t('compliance.policies_publish', 'Publish')} data-testid="policy-drawer-confirm">
            <p className="m-0 text-xs text-[var(--text-primary)]" data-testid="policy-drawer-confirm-text">{publishQuestion(t, { published, acks, nextVersion })}</p>
            <DrawerFooter
                primary={(
                    <ActionButton variant="primary" icon={UploadCloud} disabled={busy} autoFocus onClick={publish} data-testid="policy-drawer-confirm-go">
                        {t('compliance.pol_publish_go', 'Publish v{n}', { n: nextVersion })}
                    </ActionButton>
                )}
            >
                <ActionButton onClick={() => setConfirming(false)} data-testid="policy-drawer-confirm-cancel">
                    {t('common.cancel', 'Cancel')}
                </ActionButton>
            </DrawerFooter>
        </div>
    ) : (
        <>
            {unchanged && (
                <p className="m-0 text-[11px] text-[var(--text-tertiary)]" data-testid="policy-drawer-unchanged">
                    {t('compliance.pol_publish_nothing', 'Nothing changed since the published version')}
                </p>
            )}
            <DrawerFooter
                primary={(
                    <ActionButton
                        variant="primary"
                        icon={UploadCloud}
                        disabled={busy || unchanged}
                        title={t('compliance.policies_publish_hint', 'Freezes this text as a numbered version that members acknowledge.')}
                        onClick={() => setConfirming(true)}
                        data-testid="policy-drawer-publish"
                    >
                        {t('compliance.policies_publish', 'Publish')}
                    </ActionButton>
                )}
            >
                {saveButton}
            </DrawerFooter>
        </>
    ));

    return (
        <SideDrawer
            open
            onClose={onClose}
            mode={mode}
            width={POLICY_DRAWER_WIDTH}
            ariaLabel={doc.title || doc.slug}
            testId="policy-drawer"
            footer={footer}
            header={(
                <div className="flex flex-col gap-1 min-w-0">
                    <DrawerId testId="policy-drawer-slug" className="text-[var(--text-tertiary)]">{doc.slug}</DrawerId>
                    <span className="text-sm font-bold text-[var(--text-primary)] truncate">{doc.title}</span>
                    <PolicyStatusPill status={status} version={version} className="self-start" testId="policy-drawer-status" />
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
                            size="sm"
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
                </>
            )}
        </SideDrawer>
    );
}
