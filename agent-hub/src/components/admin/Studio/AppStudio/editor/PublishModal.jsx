import { AlertTriangle, CheckCircle2, ExternalLink, Info, LayoutGrid, Loader2, Stethoscope } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import AudiencePicker from './AudiencePicker';
import dryRunIssues from './dryRunIssues';
import { GROUPS, ORG, PRIVATE } from './publishAccessSummary';
import useTranslation from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import { resolveTarget } from '../../../../shared/resolveTarget';
import toast from '../../../../shared/Toast';
import { studioAppsApi } from '../studioAppsApi';

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

/** Which audience the app is CURRENTLY published to. */
function audienceOf(app) {
    const published = !!(app?.isPublished ?? app?.is_published);
    if (!published) return PRIVATE;
    const groups = sharedGroupsOf(app);
    return groups.length > 0 ? GROUPS : ORG;
}

function sharedGroupsOf(app) {
    const g = app?.sharedGroups ?? app?.shared_groups;
    return Array.isArray(g) ? g.map((x) => String(x)).filter(Boolean) : [];
}

function formatWhen(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString();
}

/**
 * Which audience the status line names. A function of t() rather than a
 * lookup table: a table of English is a sentence the Languages panel cannot
 * reach. The three cases are exhaustive — audienceOf() returns nothing else.
 */
function audienceLabel(t, audience) {
    switch (audience) {
        case PRIVATE: return t('app_studio.publish.audience_private', 'Private draft');
        case ORG: return t('app_studio.publish.audience_org', 'Everyone in your organization');
        case GROUPS: return t('app_studio.publish.audience_groups', 'Specific groups');
        default: return '';
    }
}

/**
 * Walk a validator `path` ("screens[0].sections[1].children[2].props.title")
 * down the definition to the thing the editor can actually select: the
 * deepest addressed section/element id, plus the page it sits on. Trailing
 * segments that aren't a screen/section/child step (props, filters, …) stop
 * the walk — they address a field inside the node we already found.
 * Returns null when the path doesn't start at a real screen.
 *
 * The walk itself lives in shared/resolveTarget.js — the one deep-link
 * resolver every "Show me" goes through; this keeps the modal's shape.
 */
export function resolveIssueTarget(definition, path) {
    if (typeof path !== 'string') return null;
    const hit = resolveTarget(definition, { path, kind: 'app' });
    return hit ? { screenId: hit.screenId, screenName: hit.screenName, nodeId: hit.nodeId } : null;
}

function asIssueList(value) {
    return Array.isArray(value) ? value.filter((e) => e && typeof e === 'object') : [];
}

/**
 * The screen a node id sits on, in the { nodeId, screenId, screenName } shape
 * "Show me" wants. resolveIssueTarget walks a validator PATH; the dry run
 * reports the component it actually executed, which only has an id. Same
 * resolver, other direction.
 */
function resolveNodeScreen(definition, nodeId) {
    if (!definition || !nodeId) return null;
    const hit = resolveTarget(definition, { nodeId, kind: 'app' });
    return hit ? { nodeId, screenId: hit.screenId, screenName: hit.screenName } : null;
}

/**
 * What the dialog says after the Nextcloud-menu toggle. The server waited for
 * the org's connector, so the toast can be exact: "reload Nextcloud" only when
 * the icon is really there (or really gone); otherwise the connector's own
 * periodic check picks it up — "within a few minutes".
 */
function ncMenuToast(t, ncRes, enabled) {
    if (ncRes?.ncConnected === false) {
        toast.info(t('app_studio.publish.nc_menu_not_connected', 'Saved — the app icon appears once your organization’s Nextcloud is connected to Bee Flow.'));
    } else if (ncRes?.ncSync === 'synced') {
        toast.success(enabled
            ? t('app_studio.publish.nc_menu_synced', 'Added to the Nextcloud app menu — reload Nextcloud to see it.')
            : t('app_studio.publish.nc_menu_removed', 'Removed from the Nextcloud app menu — reload Nextcloud to update it.'));
    } else {
        toast.info(t('app_studio.publish.nc_menu_pending', 'Saved — the icon appears in Nextcloud within a few minutes.'));
    }
}

export default function PublishModal({ open, onClose, app, onPublished, definition, onRevealNode }) {
    const { t } = useTranslation();
    const currentAudience = audienceOf(app);
    const currentGroups = useMemo(() => sharedGroupsOf(app), [app]);
    const publishedAt = formatWhen(app?.publishedAt ?? app?.published_at);
    const isPublished = !!(app?.isPublished ?? app?.is_published);

    const [audience, setAudience] = useState(currentAudience);
    const [selectedGroups, setSelectedGroups] = useState(() => new Set(currentGroups));
    // Nextcloud app-menu opt-in (stored per app; applied after the publish).
    const [ncMenu, setNcMenu] = useState(!!app?.nextcloudMenu);
    const [busy, setBusy] = useState(false);
    // What the server said stands in the way of publishing, straight from the
    // 422 body: { errors, warnings }. null until a publish is refused.
    const [blockers, setBlockers] = useState(null);
    // The pre-flight check: null = never run, then { errors, warnings }.
    const [checking, setChecking] = useState(false);
    const [checkResult, setCheckResult] = useState(null);

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
            toast.error(err?.message || t('app_studio.publish.check_failed', 'Could not check this app.'));
        } finally {
            setChecking(false);
        }
    };

    // A different audience is a different attempt — the previous refusal no
    // longer describes what the Apply button would do.
    const chooseAudience = (next) => {
        setAudience(next);
        setBlockers(null);
    };

    const toggleGroup = (id) => {
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

    const buildPayload = () => {
        if (audience === PRIVATE) return { isPublished: false };
        if (audience === ORG) return { isPublished: true, sharedGroups: [] };
        return { isPublished: true, sharedGroups: [...selectedGroups] };
    };

    const doApply = async () => {
        if (!app?.id || !canApply) return;
        const payload = buildPayload();
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
                    toast.error(err?.message || t('app_studio.publish.nc_menu_failed', 'The Nextcloud menu setting could not be saved.'));
                }
            }

            onPublished?.({
                ...app,
                isPublished: nextPublished,
                sharedGroups: nextGroups,
                nextcloudMenu: nextNcMenu,
                // Which draft is now live — the server reports it so the "live
                // copy is behind your edits" indicator settles immediately
                // instead of waiting for the next app fetch.
                publishedVersion: res?.publishedVersion ?? app?.publishedVersion ?? null,
                // Stamp an optimistic publish time; the server sets published_at
                // = NOW() and keeps the previous value on unpublish.
                publishedAt: nextPublished
                    ? new Date().toISOString()
                    : (app?.publishedAt ?? app?.published_at ?? null),
            });
            toast.success(
                payload.isPublished
                    ? (audience === GROUPS
                        ? t('app_studio.publish.toast_groups', 'App shared with the selected groups.')
                        : t('app_studio.publish.toast_org', 'App published to your organization.'))
                    : t('app_studio.publish.toast_unpublished', 'App unpublished — it is a private draft again.'),
            );
            onClose?.();
        } catch (err) {
            // 422 = the server already listed exactly what's wrong. Keep the
            // modal open and show that list instead of a toast the user can't
            // act on. Everything else really is an unexpected failure.
            const errors = err?.status === 422 ? asIssueList(err?.body?.errors) : [];
            if (errors.length > 0) {
                setBlockers({ errors, warnings: asIssueList(err?.body?.warnings) });
            } else {
                toast.error(err?.message || t('app_studio.publish.failed', 'Publishing failed.'));
            }
        } finally {
            setBusy(false);
        }
    };

    const liveHref = app?.id ? `/app/apps/${app.id}` : null;

    // Prefer the live editor definition when the chrome hands one down; the
    // stored app row is the fallback for callers that only have the row.
    const resolveAgainst = definition ?? app?.definition ?? null;
    const revealTarget = (issue) => {
        if (!onRevealNode) return null;
        // The dry run names the COMPONENT it executed, not a validator path —
        // so "Show me" has to work from an id as well as from a path.
        if (issue?.nodeId && !issue?.path) {
            const byId = resolveNodeScreen(resolveAgainst, issue.nodeId);
            return byId || null;
        }
        const target = resolveIssueTarget(resolveAgainst, issue?.path);
        return (target && (target.nodeId || target.screenId)) ? target : null;
    };

    const doReveal = (target) => {
        onRevealNode?.({ nodeId: target.nodeId, screenId: target.screenId });
        onClose?.();
    };

    return (
        <Modal
            open={open}
            onClose={() => !busy && onClose?.()}
            title={t('app_studio.publish.title', 'Publish app')}
            description={t('app_studio.publish.desc', 'Choose who can open this app. Publishing takes a copy of the app as it is now — you can keep editing afterwards, and readers stay on that copy until you publish again.')}
            size="md"
            footer={(
                <>
                    <button
                        type="button"
                        onClick={() => onClose?.()}
                        disabled={busy}
                        className="rounded-lg bg-white/5 px-4 py-2 text-sm hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
                        style={{ color: 'var(--text-primary)' }}
                    >
                        {t('app_studio.publish.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={doApply}
                        disabled={!canApply}
                        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                        {t('app_studio.publish.apply', 'Apply')}
                    </button>
                </>
            )}
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
                <div
                    className="rounded-lg border px-3 py-2.5"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}
                >
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={doCheck}
                            disabled={checking || !app?.id}
                            className="inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {checking
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                : <Stethoscope className="h-3.5 w-3.5" aria-hidden="true" />}
                            {checking
                                ? t('app_studio.publish.checking', 'Checking…')
                                : t('app_studio.publish.check', 'Check this app')}
                        </button>
                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {t('app_studio.publish.check_hint', 'Tries the app’s screens and logic without changing anything.')}
                        </span>
                    </div>

                    {checkResult && !checking ? (
                        checkResult.errors.length === 0 && checkResult.warnings.length === 0 ? (
                            <p className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                {t('app_studio.publish.check_all_good', 'Everything loaded and every step checks out.')}
                            </p>
                        ) : (
                            <div className="mt-2.5">
                                <BlockerList
                                    errors={checkResult.errors}
                                    warnings={checkResult.warnings}
                                    revealTarget={revealTarget}
                                    onReveal={doReveal}
                                    context="check"
                                />
                            </div>
                        )
                    ) : null}
                </div>

                {/* Current status */}
                <div
                    className="rounded-lg border px-3 py-2.5 text-xs"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}
                >
                    <div className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                        <span>{t('app_studio.publish.currently', 'Currently:')}</span>
                        <strong style={{ color: 'var(--text-primary)' }}>{audienceLabel(t, currentAudience)}</strong>
                        {currentAudience === GROUPS ? (
                            <span style={{ color: 'var(--text-tertiary)' }}>({currentGroups.length})</span>
                        ) : null}
                    </div>
                    {isPublished && publishedAt ? (
                        <div className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
                            {t('app_studio.publish.last_published', 'Last published {when}', { when: publishedAt })}
                        </div>
                    ) : null}
                    {isPublished && liveHref ? (
                        <a
                            href={liveHref}
                            className="mt-1.5 inline-flex items-center gap-1 font-medium hover:underline"
                            style={{ color: 'var(--accent-primary)' }}
                        >
                            {t('app_studio.publish.view_live', 'View live')} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                    ) : null}
                </div>

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
                {audience !== PRIVATE ? (
                    <label
                        className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5"
                        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}
                    >
                        <input
                            type="checkbox"
                            checked={ncMenu}
                            onChange={(e) => setNcMenu(e.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
                        />
                        <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                <LayoutGrid className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                {t('app_studio.publish.nc_menu', 'Show in the Nextcloud app menu')}
                            </span>
                            <span className="mt-0.5 block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {t('app_studio.publish.nc_menu_desc', 'Adds this app to the top bar of your organization’s connected Nextcloud, opening on its own page. The icon shows up after you reload Nextcloud. Everyone on that Nextcloud sees the icon; only the audience you chose above can use the app — others see a notice that it is shared with specific groups.')}
                            </span>
                        </span>
                    </label>
                ) : null}
            </div>
        </Modal>
    );
}

/**
 * `context` distinguishes the two ways this list appears. A refused publish
 * has to say what happened to the readers; a check the author asked for has
 * not changed anything, so saying so would be noise — and it may have no
 * errors at all, only things worth a look.
 */
function BlockerList({ errors, warnings, revealTarget, onReveal, context = 'publish' }) {
    const { t } = useTranslation();
    const isCheck = context === 'check';
    // Four headings, not two halves of one: "{n} things ${isCheck ? 'are
    // broken' : 'to fix'}" glues an English predicate onto a count, which no
    // translation can take apart. Singular and plural are a key each (§2.1),
    // and both carry {n} so the count sits where the language wants it.
    const errorTitle = isCheck
        ? (errors.length === 1
            ? t('app_studio.publish.check_errors_title', '{n} thing is broken', { n: errors.length })
            : t('app_studio.publish.check_errors_title_plural', '{n} things are broken', { n: errors.length }))
        : (errors.length === 1
            ? t('app_studio.publish.errors_title', '{n} thing to fix before publishing', { n: errors.length })
            : t('app_studio.publish.errors_title_plural', '{n} things to fix before publishing', { n: errors.length }));
    return (
        <div className="space-y-3">
            {errors.length > 0 ? (
                <IssuePanel
                    issues={errors}
                    icon={<AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" style={{ color: '#b45309' }} />}
                    title={errorTitle}
                    note={isCheck
                        ? t('app_studio.publish.check_errors_note', 'These stop the app working for the people you share it with.')
                        : t('app_studio.publish.errors_note', 'Nothing changed for your readers — they still see the version you published last.')}
                    panelStyle={{ borderColor: '#b45309', background: 'color-mix(in srgb, #b45309 8%, transparent)' }}
                    revealTarget={revealTarget}
                    onReveal={onReveal}
                />
            ) : null}
            {warnings.length > 0 ? (
                <IssuePanel
                    issues={warnings}
                    icon={<Info className="h-4 w-4 shrink-0" aria-hidden="true" style={{ color: 'var(--text-tertiary)' }} />}
                    title={warnings.length === 1
                        ? t('app_studio.publish.warnings_title', '{n} thing worth a look', { n: warnings.length })
                        : t('app_studio.publish.warnings_title_plural', '{n} things worth a look', { n: warnings.length })}
                    note={t('app_studio.publish.warnings_note', 'These do not stop you publishing.')}
                    panelStyle={{ borderColor: 'var(--border-subtle)' }}
                    revealTarget={revealTarget}
                    onReveal={onReveal}
                />
            ) : null}
        </div>
    );
}

function IssuePanel({ issues, icon, title, note, panelStyle, revealTarget, onReveal }) {
    return (
        <div className="rounded-lg border p-3" style={panelStyle}>
            <div className="flex items-center gap-2">
                {icon}
                <strong className="text-sm" style={{ color: 'var(--text-primary)' }}>{title}</strong>
            </div>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>{note}</p>
            <ul className="mt-2.5 space-y-2">
                {issues.map((issue, i) => (
                    <IssueRow
                        key={`${issue.code || 'issue'}-${issue.path || i}`}
                        issue={issue}
                        target={revealTarget(issue)}
                        onReveal={onReveal}
                    />
                ))}
            </ul>
        </div>
    );
}

function IssueRow({ issue, target, onReveal }) {
    const { t } = useTranslation();
    // The save-notices panel's own button, same words and the same job
    // (SaveStatusPill) — one key, not two.
    const showMe = t('app_studio.header.show_me', 'Show me');
    return (
        <li className="text-xs">
            <span className="block" style={{ color: 'var(--text-primary)' }}>{issue.message}</span>
            {issue.hint ? (
                <span className="mt-0.5 block" style={{ color: 'var(--text-tertiary)' }}>{issue.hint}</span>
            ) : null}
            {target ? (
                <span className="mt-1 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => onReveal(target)}
                        className="rounded-md bg-white/5 px-2 py-1 font-medium hover:bg-[var(--bg-card-hover)]"
                        style={{ color: 'var(--accent-primary)' }}
                    >
                        {showMe}
                    </button>
                    {target.screenName ? (
                        <span style={{ color: 'var(--text-tertiary)' }}>
                            {t('app_studio.publish.on_screen', 'on “{screen}”', { screen: target.screenName })}
                        </span>
                    ) : null}
                </span>
            ) : null}
        </li>
    );
}

