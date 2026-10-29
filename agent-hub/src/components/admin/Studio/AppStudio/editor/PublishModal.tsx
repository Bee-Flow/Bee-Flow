import { useEffect, useMemo, useState } from 'react';
import AudiencePicker from './AudiencePicker';
import dryRunIssues, { type DryRunIssue } from './dryRunIssues';
import type { Findings, IssueTarget, PublishModalProps, PublishPayload } from './PublishModal.types';
import type { HeaderApp } from './header/headerModel';
import { GROUPS, ORG, PRIVATE } from './publishAccessSummary';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { errorBodyRecord, errorStatus, messageOf } from '@/utils/caughtError';
import Modal from '@/components/shared/Modal';
import toast from '@/components/shared/Toast';
import { studioAppsApi } from '../studioAppsApi';
import { audienceOf, sharedGroupsOf, formatWhen, resolveIssueTarget, asIssueList, resolveNodeScreen, ncMenuToast } from './PublishModal.helpers';
import { BlockerList } from './BlockerList';
import { CheckPanel, NcMenuOption, PublishFooter, PublishModalSection } from './PublishModalParts';
export { resolveIssueTarget } from './PublishModal.helpers';
/**
 * Publish modal — the three-way audience picker for an App Studio app.
 *
 *   Private            → unpublish            → PATCH { isPublished: false }
 *   Entire organization→ share org-wide       → PATCH { isPublished: true, sharedGroups: [] }
 *   Specific groups    → share to groups only  → PATCH { isPublished: true, sharedGroups: [ids] }
 *
 * The server (PATCH /:id/publish) validates sharedGroups against the app's org;
 * the modal only builds the payload. On success it hands the merged, id-bearing
 * app back through onPublished so the editor chrome (and the shell's open row)
 * stay in sync — the same success shape EditorHeader's old inline stub used, but
 * merged with the app so the identity/name survive.
 *
 * A publish the server refuses (422) is NOT an error toast: the response
 * carries the full { errors, warnings } list of what stands in the way, each
 * entry a { code, severity, path, message, hint }. The modal stays open and
 * renders that list, resolving each entry's `path` back to the node it points
 * at so "Show me" can jump the user straight to it.
 *
 * The audience choice and what it hands people in the app's tables live in
 * AudiencePicker — the modal only owns the payload and the server's answer.
 */

/** What Apply sends for the chosen audience. */
function publishPayloadFor(audience: string, selectedGroups: Set<string>): PublishPayload {
    if (audience === PRIVATE) return { isPublished: false };
    if (audience === ORG) return { isPublished: true, sharedGroups: [] };
    return { isPublished: true, sharedGroups: [...selectedGroups] };
}

interface PublishOutcome {
    nextPublished: boolean;
    nextGroups: string[];
    nextNcMenu: boolean;
    publishedVersion: number | null | undefined;
}

/** The app row as it stands after a publish, for the caller. */
function publishedApp(app: HeaderApp, { nextPublished, nextGroups, nextNcMenu, publishedVersion }: PublishOutcome): HeaderApp {
    return {
        ...app,
        isPublished: nextPublished,
        sharedGroups: nextGroups,
        nextcloudMenu: nextNcMenu,
        // Which draft is now live — the server reports it so the "live
        // copy is behind your edits" indicator settles immediately
        // instead of waiting for the next app fetch.
        publishedVersion: publishedVersion ?? app?.publishedVersion ?? null,
        // Stamp an optimistic publish time; the server sets published_at
        // = NOW() and keeps the previous value on unpublish.
        publishedAt: nextPublished
            ? new Date().toISOString()
            : (app?.publishedAt ?? app?.published_at ?? null),
    };
}

/** The toast after a successful Apply. */
function publishedToast(t: TranslateFn, isPublished: boolean, audience: string) {
    return isPublished
        ? (audience === GROUPS
            ? t('app_studio.publish.toast_groups', 'App shared with the selected groups.')
            : t('app_studio.publish.toast_org', 'App published to your organization.'))
        : t('app_studio.publish.toast_unpublished', 'App unpublished — it is a private draft again.');
}

/**
 * Where "Show me" goes for one issue. The dry run names the COMPONENT it
 * executed, not a validator path — so it has to work from an id as well as
 * from a path.
 */
function issueTargetFor(resolveAgainst: Parameters<typeof resolveIssueTarget>[0], issue: DryRunIssue): IssueTarget | null {
    if (issue?.nodeId && !issue?.path) {
        const byId = resolveNodeScreen(resolveAgainst, issue.nodeId);
        return byId || null;
    }
    const target = resolveIssueTarget(resolveAgainst, issue?.path);
    return (target && (target.nodeId || target.screenId)) ? target : null;
}

export default function PublishModal({ open, onClose, app, onPublished, definition, onRevealNode, managed = false }: PublishModalProps) {
    const { t } = useTranslation();
    // `managed`: a Solution stage manages the app, so its deploys publish it
    // and the stage's operator decides only WHO opens it. Audience only: no
    // pre-flight check of a draft there is no way to change.
    const currentAudience = audienceOf(app);
    const currentGroups = useMemo(() => sharedGroupsOf(app), [app]);
    const publishedAt = formatWhen(app?.publishedAt ?? app?.published_at);
    const isPublished = !!(app?.isPublished ?? app?.is_published);

    const [audience, setAudience] = useState(currentAudience);
    const [selectedGroups, setSelectedGroups] = useState<Set<string>>(() => new Set(currentGroups));
    // Nextcloud app-menu opt-in (stored per app; applied after the publish).
    const [ncMenu, setNcMenu] = useState(!!app?.nextcloudMenu);
    const [busy, setBusy] = useState(false);
    // What the server said stands in the way of publishing, straight from the
    // 422 body: { errors, warnings }. null until a publish is refused.
    const [blockers, setBlockers] = useState<Findings | null>(null);
    // The pre-flight check: null = never run, then { errors, warnings }.
    const [checking, setChecking] = useState(false);
    const [checkResult, setCheckResult] = useState<Findings | null>(null);

    // Reset the draft each time the modal opens so a re-open starts from the
    // app's real, current audience.
    useEffect(() => {
        if (!open) return;
        setAudience(audienceOf(app));
        setSelectedGroups(new Set(sharedGroupsOf(app)));
        setNcMenu(!!app?.nextcloudMenu);
        setBusy(false);
        setBlockers(null);
        setChecking(false);
        setCheckResult(null);
    }, [open, app]);

    /**
     * Try the app without publishing it.
     *
     * The publish gate only refuses what it can prove statically. The things a
     * hand-builder actually gets wrong — a table with no rows behind a list, a
     * screen that is blank for everyone but them, a save step writing a column
     * that was renamed — are only visible by executing the bindings, which is
     * what the server's dry run does read-only. Until now nothing but the AI
     * builder could ask for it.
     */
    const doCheck = async () => {
        if (!app?.id || checking) return;
        setChecking(true);
        setBlockers(null);
        try {
            const result = await studioAppsApi.checkApp(app.id);
            setCheckResult(dryRunIssues(result, resolveAgainst, t));
        } catch (err) {
            toast.error(messageOf(err, t('app_studio.publish.check_failed', 'Could not check this app.')));
        } finally {
            setChecking(false);
        }
    };

    // A different audience is a different attempt — the previous refusal no
    // longer describes what the Apply button would do.
    const chooseAudience = (next: string) => {
        setAudience(next);
        setBlockers(null);
    };

    const toggleGroup = (id: string) => {
        setSelectedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    // "Specific groups" needs at least one group selected — otherwise it is
    // indistinguishable from an org-wide publish (and the server would treat an
    // empty list as org-wide).
    const groupsIncomplete = audience === GROUPS && selectedGroups.size === 0;
    const canApply = !busy && !groupsIncomplete;

    const doApply = async () => {
        if (!app?.id || !canApply) return;
        const payload = publishPayloadFor(audience, selectedGroups);
        setBusy(true);
        setBlockers(null);
        try {
            const res = await studioAppsApi.publish(app.id, payload);
            const nextPublished = res?.isPublished ?? payload.isPublished;
            const nextGroups = res?.sharedGroups ?? payload.sharedGroups ?? [];

            // Apply the Nextcloud app-menu opt-in AFTER the publish settled —
            // enabling requires a live published copy, which the publish call
            // just created. Best-effort: a hiccup here must not roll back a
            // successful publish, so it reports its own toast and moves on.
            // Only touched when publishing and actually changed; unpublishing
            // leaves the stored flag as-is (the server hides the entry via the
            // is_published filter, and re-publishing restores it).
            let nextNcMenu = !!app?.nextcloudMenu;
            if (payload.isPublished && ncMenu !== nextNcMenu) {
                try {
                    const ncRes = await studioAppsApi.setNextcloudMenu(app.id, ncMenu);
                    nextNcMenu = !!ncRes?.nextcloudMenu;
                    ncMenuToast(t, ncRes, ncMenu);
                } catch (err) {
                    toast.error(messageOf(err, t('app_studio.publish.nc_menu_failed', 'The Nextcloud menu setting could not be saved.')));
                }
            }

            onPublished?.(publishedApp(app, { nextPublished, nextGroups, nextNcMenu, publishedVersion: res?.publishedVersion }));
            toast.success(publishedToast(t, payload.isPublished, audience));
            onClose?.();
        } catch (err) {
            // 422 = the server already listed exactly what's wrong. Keep the
            // modal open and show that list instead of a toast the user can't
            // act on. Everything else really is an unexpected failure.
            const errors = errorStatus(err) === 422 ? asIssueList(errorBodyRecord(err)?.errors) : [];
            if (errors.length > 0) {
                setBlockers({ errors, warnings: asIssueList(errorBodyRecord(err)?.warnings) });
            } else {
                toast.error(messageOf(err, t('app_studio.publish.failed', 'Publishing failed.')));
            }
        } finally {
            setBusy(false);
        }
    };

    const liveHref = app?.id ? `/app/apps/${app.id}` : null;

    // Prefer the live editor definition when the chrome hands one down; the
    // stored app row is the fallback for callers that only have the row.
    const resolveAgainst = definition ?? app?.definition ?? null;
    const revealTarget = (issue: DryRunIssue): IssueTarget | null => (onRevealNode ? issueTargetFor(resolveAgainst, issue) : null);

    const doReveal = (target: IssueTarget) => {
        onRevealNode?.({ nodeId: target.nodeId, screenId: target.screenId });
        onClose?.();
    };

    return (
        <Modal
            open={open}
            onClose={() => !busy && onClose?.()}
            title={t('app_studio.publish.title', 'Publish app')}
            description={managed
                ? t('app_studio.header.publish_unknown_title', 'Choose who can use this app')
                : t('app_studio.publish.desc', 'Choose who can open this app. Publishing takes a copy of the app as it is now — you can keep editing afterwards, and readers stay on that copy until you publish again.')}
            size="md"
            footer={<PublishFooter t={t} busy={busy} canApply={canApply} onCancel={() => onClose?.()} onApply={doApply} />}
        >
            <div className="space-y-4">
                {/* What the server refused to publish, and why */}
                {blockers ? (
                    <BlockerList
                        errors={blockers.errors}
                        warnings={blockers.warnings}
                        revealTarget={revealTarget}
                        onReveal={doReveal}
                    />
                ) : null}

                {/*
                  * Try it before anyone else has to. The publish gate only
                  * refuses what it can prove statically; this actually runs the
                  * app's data reads, so an empty list, a screen that is blank
                  * for everyone but the owner, or a save step writing a column
                  * that was renamed all surface here rather than in front of a
                  * colleague.
                  */}
                {!managed && <CheckPanel t={t} checking={checking} canCheck={!!app?.id} onCheck={doCheck} checkResult={checkResult} revealTarget={revealTarget} onReveal={doReveal} />}

                {/* Current status */}
                <PublishModalSection t={t} currentAudience={currentAudience} currentGroups={currentGroups} isPublished={isPublished} publishedAt={publishedAt} liveHref={liveHref} />

                {/* Audience picker, the group list it needs, and what the choice shares */}
                <AudiencePicker
                    open={open}
                    appId={app?.id}
                    audience={audience}
                    onChoose={chooseAudience}
                    selectedGroups={selectedGroups}
                    onToggleGroup={toggleGroup}
                    incomplete={groupsIncomplete}
                />

                {/*
                  * Nextcloud app menu — only meaningful for a published app,
                  * so the section hides under "Private". The entry's ICON is
                  * visible to everyone on the connected Nextcloud: AppAPI's
                  * top-menu entries are instance-wide (admin-only is the only
                  * gate it offers), so a group-scoped audience cannot hide the
                  * icon. Opening the app still enforces the audience above;
                  * an org member outside it gets the "shared with specific
                  * groups" screen. The copy says exactly that.
                  */}
                {audience !== PRIVATE ? <NcMenuOption t={t} checked={ncMenu} onChange={setNcMenu} /> : null}
            </div>
        </Modal>
    );
}
