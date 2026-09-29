import { Code2, Database, Download, Eye, History, Link2, Upload, Users } from 'lucide-react';
import React from 'react';
import { visibilityOf } from './webpageVisibility';
import StatusActionPill from '../../components/shared/StatusActionPill';
import statusOf from '../../components/shared/statusOf';
import StudioSectionHeader, { OBJHEAD, OBJHEAD_FOLD } from '../../components/shared/StudioSectionHeader';
import VisibilityCapsule from '../../components/shared/VisibilityCapsule';
import useTranslation from '../../hooks/useTranslation';

/**
 * WebpageEditorHeader — the ONE 48px row an open webpage starts with (Bee Flow
 * Builder redesign, Sep 2026; plan W2 "Editor-chrome"). Replaces the ad-hoc
 * back-arrow + name + pencil + globe bar the editor carried since W0, and
 * hoists the Add-image / ZIP buttons out of the IDE's own toolbar so a user
 * finds them in the same place as in every other Studio section.
 *
 * It is a COMPOSITION, not a new widget: `StudioSectionHeader` owns the row,
 * `SegmentedControl` (through its `tabs` prop) owns the strip, `StatusActionPill`
 * owns the `● DRAFT | Publish` split, and `VisibilityCapsule` owns the
 * audience. Nothing here paints a colour or a measurement of its own.
 *
 * ── THREE THINGS THIS FILE IS CAREFUL ABOUT ──────────────────────────────
 *
 * 1. THE STATUS COMES FROM THE FLAG, NOT FROM THE POINTER.
 *    `statusOf.webpage` prefers `is_published` whenever it is present, and
 *    mapWebpageRow always supplies it — so `published_version_id` is not a
 *    second, competing source of truth here. Reading the pointer instead
 *    would contradict statusOf.test.js, which pins exactly that precedence.
 *
 * 2. A PUBLIC LINK IS WIDER THAN ANY AUDIENCE, AND IS SAID FIRST.
 *    VisibilityCapsule knows Personal / Entire organisation / Groups. It does
 *    NOT know about share links, so on a page that is "Personal" AND reachable
 *    by anyone holding a link it would print "Personal" — the exact lie a
 *    visibility control exists to prevent. `visibilityOf()` (the derivation
 *    the overview card already shares) decides, and when it says public a
 *    marker is rendered BEFORE the capsule.
 *
 * 3. AN UNKNOWN COUNT SHOWS NOTHING.
 *    Tab badges take `undefined` for "not loaded / no endpoint" and the badge
 *    slot then renders nothing at all — not a "0". "Used by" has no endpoint
 *    yet, so it is permanently badge-less rather than confidently zero.
 *
 * Props
 *   page            the webpage row (name, isPublished, sharedGroups, …)
 *   isOwner         owner-only chrome: rename, capsule, publish, add-image
 *   activeTab       one of WEBPAGE_TABS
 *   onTab           (id) => void
 *   counts          { data?, history?, usedBy? } — undefined means "unknown"
 *   statusChip      a ready element (the SaveStatus pill) for the chip slot
 *   onRename        (next) => void
 *   onBack          () => void
 *   onPublish       () => void — the pill's forward action
 *   publishBusy     disables the forward action while a publish is in flight
 *   capsuleOpen / onCapsuleToggle / onCapsuleClose
 *   orgGroups, onSetPersonal, onSetEntireOrg, onToggleGroup
 *   capsuleExtra    node rendered under the capsule's options (share links)
 *   onAddImage      () => void — owner only; omitted → no button
 *   onDownloadZip   () => void
 *   extras          node appended after the built-in extras (viewer menus)
 */

/** The five sections of an open webpage, in artboard order. */
export const WEBPAGE_TABS = Object.freeze(['preview', 'data', 'code', 'history', 'usedby']);

const TAB_ICON = Object.freeze({
    preview: Eye, data: Database, code: Code2, history: History, usedby: Users,
});

/**
 * "Public link" — rendered only when the page really is reachable by link.
 * Deliberately NOT a second visibility control: it states a fact the capsule
 * cannot state, and clicking through to manage the links stays inside the
 * capsule's own share section.
 */
function PublicLinkMarker({ t }) {
    return (
        <span
            data-testid="webpage-public-marker"
            title={t('webpages.publish.public_link_hint', 'Anyone with the link can open this page')}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-medium whitespace-nowrap"
            style={{
                border: '1px solid var(--border-default)',
                background: 'var(--bg-card)',
                color: 'var(--text-primary)',
            }}
        >
            <Link2 size={13} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
            <span className={OBJHEAD_FOLD.label}>{t('webpages.visibility.public', 'Public')}</span>
        </span>
    );
}

/** A 32px square icon button, the shape the header's extras slot expects. */
function ExtraButton({ icon, label, onClick }) {
    // Bound to a local before use — a JSX-only reference to a destructured
    // prop reads as an unused argument to the lint config (StudioSectionHeader
    // does the same in renderGlyph).
    const Icon = icon;
    return (
        <button
            type="button"
            onClick={onClick}
            title={label}
            aria-label={label}
            className="grid place-items-center w-8 h-8 rounded-[10px] flex-shrink-0 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition"
            style={{ border: '1px solid var(--border-default)' }}
        >
            <Icon size={14} aria-hidden="true" />
        </button>
    );
}

/**
 * The sections, filtered to the ones this caller can actually use.
 *
 * Code and History are OWNER-ONLY, and not for tidiness: both server surfaces
 * behind them are owner-scoped (`GET /:id/versions` answers 404 to anyone
 * else, and a save from a viewer is refused the same way). Offering a viewer
 * a code editor whose every keystroke fails to save — over bytes that are the
 * published snapshot, not the live page — is an action the screen cannot
 * carry out, so it is not offered.
 */
function buildTabs(t, counts, isOwner) {
    const c = counts || {};
    return [
        { id: 'preview', label: t('webpages.tab.preview', 'Preview') },
        { id: 'data', label: t('webpages.tab.data', 'Data & links'), count: c.data },
        isOwner && { id: 'code', label: t('webpages.tab.code', 'Code') },
        isOwner && { id: 'history', label: t('webpages.tab.history', 'History'), count: c.history },
        // No endpoint answers "who uses this page" yet, so this badge stays
        // absent. A confident 0 would be a claim the row cannot back up.
        { id: 'usedby', label: t('webpages.tab.used_by', 'Used by'), count: c.usedBy },
    ].filter(Boolean).map(tab => ({ ...tab, icon: TAB_ICON[tab.id] }));
}

/**
 * The slot left of the primary action: the public-link fact FIRST (it is the
 * widest audience there is and the capsule cannot express it), then the
 * capsule itself — owner-only, because a viewer cannot change an audience.
 */
function CapsuleSlot({
    t, page, isOwner, isPublic,
    capsuleOpen, onCapsuleToggle, onCapsuleClose,
    orgGroups, onSetPersonal, onSetEntireOrg, onToggleGroup, capsuleExtra,
}) {
    return (
        <>
            {isPublic && <PublicLinkMarker t={t} />}
            {isOwner && (
                <VisibilityCapsule
                    variant="capsule"
                    anchored
                    confirmWidening
                    agent={page}
                    open={capsuleOpen}
                    onToggle={onCapsuleToggle}
                    onClose={onCapsuleClose}
                    isPublished={!!page?.isPublished}
                    sharedGroups={Array.isArray(page?.sharedGroups) ? page.sharedGroups : []}
                    orgGroups={orgGroups}
                    onSetPersonal={onSetPersonal}
                    onSetEntireOrg={onSetEntireOrg}
                    onToggleGroup={onToggleGroup}
                    embedEnabled={false}
                    extraSection={capsuleExtra}
                />
            )}
        </>
    );
}

/**
 * The forward action: publish a draft, re-freeze a live page.
 *
 * The two titles are not decoration. On a draft this button OPENS the audience
 * capsule rather than publishing (see WebpageEditorPage.handlePublishAction) —
 * a one-click "Publish" would widen a personal page to the whole organisation
 * without naming the audience — and the title is where that is said out loud.
 */
function publishAction(t, status, { isOwner, onPublish, publishBusy }) {
    if (!isOwner || !onPublish) return null;
    const published = status === 'published';
    return {
        label: published
            ? t('webpages.publish.republish', 'Republish')
            : t('webpages.publish.publish', 'Publish'),
        title: published
            ? t('webpages.publish.republish_hint', 'Freeze the current version for the people who can already see this page')
            : t('webpages.publish.choose_audience', 'Choose who can see this page'),
        onClick: onPublish,
        disabled: publishBusy,
        // Republishing IS the forward action here even though the page is
        // already live, so it keeps the accent the pill would otherwise
        // reserve for draft → published.
        primary: true,
    };
}

export default function WebpageEditorHeader({
    page,
    isOwner = false,
    activeTab = 'preview',
    onTab,
    counts,
    statusChip = null,
    onRename,
    onBack,
    onPublish,
    publishBusy = false,
    capsuleOpen = false,
    onCapsuleToggle,
    onCapsuleClose,
    orgGroups = [],
    onSetPersonal,
    onSetEntireOrg,
    onToggleGroup,
    capsuleExtra = null,
    onAddImage,
    onDownloadZip,
    extras = null,
}) {
    const { t } = useTranslation();
    const status = statusOf.webpage(page);
    const { isPublic } = visibilityOf(page);

    // A draft's next step is Publish; a live page's is to re-freeze what its
    // audience reads — which is why the label changes rather than the button
    // disappearing: "published" is not "finished".
    const action = publishAction(t, status, { isOwner, onPublish, publishBusy });

    const capsule = (
        <CapsuleSlot
            t={t}
            page={page}
            isOwner={isOwner}
            isPublic={isPublic}
            capsuleOpen={capsuleOpen}
            onCapsuleToggle={onCapsuleToggle}
            onCapsuleClose={onCapsuleClose}
            orgGroups={orgGroups}
            onSetPersonal={onSetPersonal}
            onSetEntireOrg={onSetEntireOrg}
            onToggleGroup={onToggleGroup}
            capsuleExtra={capsuleExtra}
        />
    );

    return (
        <StudioSectionHeader
            kind="webpage"
            title={page?.name || ''}
            onRename={isOwner ? onRename : undefined}
            statusChip={statusChip}
            tabs={buildTabs(t, counts, isOwner)}
            activeTab={activeTab}
            onTab={onTab}
            capsule={capsule}
            primary={<StatusActionPill status={status} action={action} containerName={OBJHEAD} />}
            extras={(
                <>
                    {isOwner && onAddImage && (
                        <ExtraButton icon={Upload} label={t('webpages.action.add_image', 'Add image')} onClick={onAddImage} />
                    )}
                    {onDownloadZip && (
                        <ExtraButton icon={Download} label={t('webpages.action.download_zip', 'Download ZIP')} onClick={onDownloadZip} />
                    )}
                    {extras}
                </>
            )}
            onBack={onBack}
            backLabel={t('webpages.back_to_list', 'Back to list')}
        />
    );
}
