import { ChevronDown, Globe, Lock, Building2, Users, Check } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import AnchoredMenu from './AnchoredMenu';
import useConfirm from './useConfirm';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * VisibilityCapsule — THE "who can see this" control (Personal / Entire
 * organisation / Groups), shared by agents, Steps, knowledge bases, webpages,
 * skills and meeting notes. Formerly `AgentWizard/pickers/PublishMenu.jsx`,
 * which now re-exports this file so its consumers did not have to move.
 *
 * Fully CONTROLLED. The component owns no publish state: it derives the mode
 * from `isPublished` + `sharedGroups` and calls back `onSetPersonal`,
 * `onSetEntireOrg`, `onToggleGroup(groupId)`. The server contract is the same
 * pair of columns, and its one rule is the only truth this file knows about
 * an empty group list (`server/auth/audience.js` canSeePublished):
 *
 *     published + sharedGroups: []  ⇒  the WHOLE ORGANISATION can see it.
 *
 * `[]` is therefore never "nobody". Two consequences are built in here so a
 * consumer cannot get them wrong:
 *   - unticking the LAST group on a published thing calls `onSetPersonal`,
 *     not `onToggleGroup` — sending `[]` would silently widen the audience
 *     to everyone, the opposite of what the click meant;
 *   - with `confirmWidening`, handing access to people who did not have it a
 *     second ago (personal → org, personal → a group, groups → org) asks
 *     first with a sentence that names WHO. Taking access away stays one
 *     click: making "stop sharing" slower than "share" is backwards. The rule
 *     and its wording come from Studio/Datatables/DatatableSharing.jsx.
 *
 * Two looks, one behaviour, both theme-neutral in EVERY state — no emerald
 * when published; decorative green was removed from all header chrome on
 * this branch, the status pill first:
 *   variant 'pill'     — the original rounded-full trigger (default, so the
 *                        consumers that predate the redesign are untouched;
 *                        only its publish tint went, the shape stayed);
 *   variant 'capsule'  — the redesign's 32px / radius-10 capsule
 *                        (Studio Home artboard 1b: border-default, bg-card,
 *                        12px text, glyph in --text-secondary).
 *
 * The capsule's group list REFUSES to untick the last group: the box stays
 * ticked and a hint under the list says "Choose Personal to stop sharing".
 * `useAudienceActions` would otherwise route that click to `onSetPersonal`,
 * and every consumer's onSetPersonal also closes the popover — a checkbox
 * click that slams the menu shut and silently unpublishes. The chip list in
 * AudienceRows is not a popover and keeps the "last chip → Personal" path.
 *
 * `anchored` swaps the in-flow popover for a portalled `AnchoredMenu`, which
 * is what a capsule inside a 48px header bar needs: those bars sit inside
 * scrolling and `overflow:hidden` chrome that clips an `absolute` panel
 * (BFSF-328). Default false until each consumer opts in.
 *
 * The trigger label reads the audience NAME — "Personal", "Entire
 * organisation", "Group Sales", "3 groups" — never "Published (2)". Names come
 * from `groupNames` (id → name) when given, else from the `orgGroups` list.
 *
 * Props (all optional except the state pair and the callbacks):
 *   t                  translator; falls back to useTranslation()
 *   agent              the entity (its `name` is used in the confirm sentence)
 *   open / onToggle / onClose   menu state, owned by the caller
 *   isPublished, sharedGroups   the server's audience pair
 *   onSetPersonal / onSetEntireOrg / onToggleGroup(groupId)
 *   orgGroups          [{id, name}] — the org directory (useOrgDirectory)
 *   groupsUnavailable  that directory could not be READ. An empty list and a
 *                      failed read look identical on screen, and the panel
 *                      would simply drop the "Or specific groups" section —
 *                      indistinguishable from an org that has no groups. Set
 *                      it and the panel SAYS so instead
 *   onRetryGroups      re-ask, offered next to that sentence
 *   groupNames         Record<id, name> | Map — overrides orgGroups for labels
 *   embedEnabled       shows the "web embed is on" hint (agents)
 *   extraSection       extension slot under the options (webpages' share links)
 *   variant            'pill' | 'capsule'
 *   anchored           portal the panel through AnchoredMenu
 *   confirmWidening    ask before widening the audience
 *   disabled           trigger disabled (read-only viewers)
 */

export const PERSONAL = 'personal';
export const ORG = 'org';
export const GROUPS = 'groups';

/** The one derivation, shared with AudienceRows. Empty groups on a published thing = org. */
export function audienceModeOf({ isPublished, sharedGroups }) {
    if (!isPublished) return PERSONAL;
    return (Array.isArray(sharedGroups) && sharedGroups.length > 0) ? GROUPS : ORG;
}

/** id → display name, from `groupNames` (object or Map) first, then the directory list. */
export function makeGroupNamer({ groupNames, orgGroups } = {}) {
    const fromMap = (id) => {
        if (!groupNames) return undefined;
        if (groupNames instanceof Map) return groupNames.get(id);
        return groupNames[id];
    };
    const list = Array.isArray(orgGroups) ? orgGroups : [];
    return (id) => {
        const named = fromMap(id);
        if (named) return named;
        const hit = list.find(g => g && g.id === id);
        return (hit && hit.name) || id;
    };
}

/**
 * t() with the placeholders filled in afterwards as well. The real translator
 * interpolates `{name}` itself; a caller-supplied `t` (tests, embeds) may not,
 * and a capsule reading "{count} groups" is worse than no capsule.
 */
function tx(t, key, fallback, params) {
    let value = t(key, fallback, params);
    if (typeof value !== 'string') value = fallback;
    for (const [k, v] of Object.entries(params || {})) {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return value;
}

/** ["a","b","c"] → "a, b and c" — the "and" goes through i18n. */
export function joinAudienceNames(t, names) {
    const list = (names || []).filter(Boolean);
    if (list.length <= 1) return list[0] || '';
    return tx(t, 'visibility.names_and', '{head} and {last}', {
        head: list.slice(0, -1).join(', '),
        last: list[list.length - 1],
    });
}

/** The trigger label: the audience's name, never a count in brackets. */
export function audienceLabel(t, mode, sharedGroups, nameOf) {
    if (mode === PERSONAL) return t('visibility.personal', 'Personal');
    if (mode === ORG) return t('visibility.entire_org', 'Entire organisation');
    const ids = Array.isArray(sharedGroups) ? sharedGroups : [];
    if (ids.length === 1) {
        const name = nameOf ? nameOf(ids[0]) : ids[0];
        return name && name !== ids[0]
            ? tx(t, 'visibility.group_named', 'Group {name}', { name })
            : t('visibility.one_group', '1 group');
    }
    return tx(t, 'visibility.n_groups', '{count} groups', { count: ids.length });
}

/**
 * The three transitions, with the widening rule applied. Shared by the
 * capsule and AudienceRows so the rule lives once. Returns synchronous
 * callbacks when nothing needs asking (existing consumers close their menu
 * inside the callback and expect it to have fired by the time the click
 * handler returns); only a real question goes through the promise.
 */
export function useAudienceActions({
    t, entity, mode, sharedGroups, nameOf, confirmWidening,
    onSetPersonal, onSetEntireOrg, onToggleGroup,
    // Optional: what to do when the LAST group is unticked. Default is
    // `onSetPersonal` (see toggleGroup); a consumer whose list lives inside
    // a popover hands in a refusal instead, because onSetPersonal closes it.
    onLastGroup = null,
}) {
    const { confirm, confirmDialog } = useConfirm();
    const subject = (entity && (entity.name || entity.title)) || t('visibility.this_item', 'this item');

    const ask = (description) => confirm({
        title: t('visibility.confirm_title', 'Share more widely?'),
        description,
        confirmLabel: t('visibility.confirm_share', 'Share'),
        cancelLabel: t('visibility.confirm_keep', 'Keep as is'),
    });

    // Narrowing never asks.
    const choosePersonal = () => { onSetPersonal?.(); };

    const chooseOrg = () => {
        // Personal → org and groups → org both hand access to people who did
        // not have it; org → org is a no-op re-select and just reports back.
        if (!confirmWidening || mode === ORG) { onSetEntireOrg?.(); return; }
        ask(tx(t, 'visibility.confirm_org', 'Everyone in your organisation will be able to see and use “{name}”.', { name: subject }))
            .then((ok) => { if (ok) onSetEntireOrg?.(); });
    };

    const toggleGroup = (gid) => {
        const current = Array.isArray(sharedGroups) ? sharedGroups : [];
        const adding = !current.includes(gid);
        // Unticking the last group: `[]` on a published thing means EVERYONE,
        // so the honest reading of "no groups" is personal — unless the
        // consumer asked to be told instead (the capsule refuses the untick).
        if (!adding && mode === GROUPS && current.length === 1) {
            if (onLastGroup) onLastGroup(); else onSetPersonal?.();
            return;
        }
        // Leaving personal is the widening; ticking a group while the whole
        // org can already see it is a narrowing, and so is unticking.
        if (!confirmWidening || !adding || mode !== PERSONAL) { onToggleGroup?.(gid); return; }
        const groups = nameOf ? nameOf(gid) : gid;
        ask(tx(t, 'visibility.confirm_groups', 'Members of {groups} will be able to see and use “{name}”.', { groups, name: subject }))
            .then((ok) => { if (ok) onToggleGroup?.(gid); });
    };

    return { choosePersonal, chooseOrg, toggleGroup, confirmDialog };
}

/** Checkbox list over the org's groups — the capsule panel and the AudienceRows "+" picker share it. */
export function GroupChecklist({ t, orgGroups = [], groupsUnavailable = false, sharedGroups = [], onToggle, disabled = false, className = '' }) {
    if (!orgGroups.length) {
        // Same distinction the capsule panel makes: an empty list is a fact
        // about the organisation, and only a read that ANSWERED may state it.
        return (
            <div
                className={`px-4 py-2 text-xs ${groupsUnavailable ? '' : 'text-[var(--text-tertiary)]'} ${className}`}
                style={groupsUnavailable ? { color: 'var(--warning-ink, var(--warning))' } : undefined}
                role={groupsUnavailable ? 'status' : undefined}
                data-testid={groupsUnavailable ? 'visibility-groups-unreadable' : undefined}
            >
                {groupsUnavailable
                    ? t('visibility.groups_unreadable', 'The list of groups could not be read, so sharing with specific groups is not offered right now. That is not “this organisation has no groups”.')
                    : t('visibility.no_groups_available', 'No groups in this organisation yet.')}
            </div>
        );
    }
    return (
        <div className={`max-h-40 overflow-y-auto pb-2 ${className}`} data-testid="visibility-group-list">
            {orgGroups.map(g => {
                const checked = sharedGroups.includes(g.id);
                return (
                    <label key={g.id} className="flex items-center gap-2 px-4 py-1.5 text-sm cursor-pointer hover:bg-[var(--bg-secondary)]">
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle?.(g.id)} />
                        <span className="text-[var(--text-primary)]">{g.name || g.id}</span>
                    </label>
                );
            })}
        </div>
    );
}

const MODE_ICON = { [PERSONAL]: Lock, [ORG]: Building2, [GROUPS]: Users };

export default function VisibilityCapsule({
    t: tProp,
    agent,
    open = false,
    onToggle,
    onClose,
    isPublished = false,
    onSetPersonal,
    onSetEntireOrg,
    embedEnabled = false,
    orgGroups = [],
    groupsUnavailable = false,
    onRetryGroups = null,
    sharedGroups = [],
    onToggleGroup,
    extraSection = null,
    variant = 'pill',
    anchored = false,
    groupNames = null,
    confirmWidening = false,
    disabled = false,
    className = '',
}) {
    const { t: tHook } = useTranslation();
    const t = tProp || tHook;
    const popoverRef = useRef(null);
    const triggerRef = useRef(null);

    // Click-outside for the in-flow popover. The anchored path leaves this to
    // AnchoredMenu, which also ignores presses on a scrollbar.
    useEffect(() => {
        if (!open || anchored) return undefined;
        const onDoc = (e) => {
            if (popoverRef.current?.contains(e.target)) return;
            if (triggerRef.current?.contains(e.target)) return;
            onClose?.();
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open, anchored, onClose]);

    const groups = Array.isArray(sharedGroups) ? sharedGroups : [];
    const mode = audienceModeOf({ isPublished, sharedGroups: groups });
    const nameOf = makeGroupNamer({ groupNames, orgGroups });
    const label = audienceLabel(t, mode, groups, nameOf);
    // Shown under the group list after a refused "untick the last group";
    // gone again the moment the menu closes or the audience changes. The
    // refusal records the audience it happened in, and the hint only shows
    // while that is still the audience — derived, so no reset effect.
    const [lastGroupHintAt, setLastGroupHintAt] = useState(null);
    const audienceKey = open ? `${mode}:${groups.length}` : null;
    const lastGroupHint = audienceKey !== null && lastGroupHintAt === audienceKey;
    const { choosePersonal, chooseOrg, toggleGroup, confirmDialog } = useAudienceActions({
        t, entity: agent, mode, sharedGroups: groups, nameOf, confirmWidening,
        onSetPersonal, onSetEntireOrg, onToggleGroup,
        onLastGroup: () => setLastGroupHintAt(audienceKey),
    });

    const isCapsule = variant === 'capsule';
    const CapsuleIcon = MODE_ICON[mode];

    const trigger = isCapsule ? (
        <button
            ref={triggerRef}
            type="button"
            onClick={onToggle}
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={t('visibility.aria_label', 'Visibility')}
            data-testid="visibility-capsule"
            data-variant="capsule"
            data-mode={mode}
            className={`inline-flex items-center gap-2 text-xs font-medium whitespace-nowrap transition-colors hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
            style={{
                height: 32,
                padding: '0 12px',
                borderRadius: 10,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-card)',
                color: 'var(--text-primary)',
            }}
        >
            <CapsuleIcon size={13} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
            <span>{label}</span>
            <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: 'var(--text-tertiary)' }} />
        </button>
    ) : (
        <button
            ref={triggerRef}
            type="button"
            onClick={onToggle}
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-testid="visibility-capsule"
            data-variant="pill"
            data-mode={mode}
            className={`flex items-center gap-1.5 px-5 py-2 rounded-full text-sm font-semibold transition shadow-sm disabled:opacity-50 bg-[var(--bg-secondary)] text-[var(--text-primary)] ring-1 ring-[var(--border-default)] hover:bg-[var(--bg-tertiary)] ${className}`}
        >
            {isPublished ? <Globe size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
            {label}
            <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
    );

    const tileStyle = { background: 'color-mix(in srgb, var(--text-secondary) 12%, transparent)' };
    const panelBody = (
        <>
            <div className="px-4 py-3 border-b border-[var(--border-default)]">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                    {t('visibility.title', 'Publish to…')}
                </div>
                <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                    {t('visibility.choose_who', 'Choose who can see this.')}
                </div>
            </div>

            {/* Personal — only the owner can access. */}
            <button
                type="button"
                onClick={choosePersonal}
                data-audience-option={PERSONAL}
                aria-current={mode === PERSONAL ? 'true' : undefined}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[var(--bg-secondary)] transition-colors text-left"
            >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={tileStyle}>
                    <Lock size={16} aria-hidden="true" className="text-[var(--text-secondary)]" />
                </div>
                <div className="flex-1">
                    <div className="text-sm font-medium text-[var(--text-primary)]">{t('visibility.personal', 'Personal')}</div>
                    <div className="text-xs text-[var(--text-tertiary)]">{t('visibility.personal_desc', 'Only you can access')}</div>
                </div>
                {mode === PERSONAL && <Check size={16} aria-hidden="true" className="text-[var(--text-primary)]" />}
            </button>

            {/* Entire organisation — published, no group restriction. */}
            <button
                type="button"
                onClick={chooseOrg}
                data-audience-option={ORG}
                aria-current={mode === ORG ? 'true' : undefined}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[var(--bg-secondary)] transition-colors text-left border-t border-[var(--border-default)]"
            >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={tileStyle}>
                    <Building2 size={16} aria-hidden="true" className="text-[var(--text-secondary)]" />
                </div>
                <div className="flex-1">
                    <div className="text-sm font-medium text-[var(--text-primary)]">{t('visibility.entire_org', 'Entire organisation')}</div>
                    <div className="text-xs text-[var(--text-tertiary)]">{t('visibility.entire_org_desc', 'All members can access')}</div>
                </div>
                {mode === ORG && <Check size={16} aria-hidden="true" className="text-[var(--text-primary)]" />}
            </button>

            {/* The group directory could not be read. Without this the section
                below is simply ABSENT, which reads as "this organisation has no
                groups" — a claim about the org made off a request that failed. */}
            {orgGroups.length === 0 && groupsUnavailable && (
                <div
                    className="px-4 py-2 border-t border-[var(--border-default)] text-[11px] flex flex-wrap items-baseline gap-x-2"
                    style={{ color: 'var(--warning-ink, var(--warning))' }}
                    role="status"
                    data-testid="visibility-groups-unreadable"
                >
                    <span>
                        {t('visibility.groups_unreadable', 'The list of groups could not be read, so sharing with specific groups is not offered right now. That is not “this organisation has no groups”.')}
                    </span>
                    {onRetryGroups && (
                        <button
                            type="button"
                            onClick={onRetryGroups}
                            data-testid="visibility-groups-retry"
                            className="underline decoration-dotted text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                        >
                            {t('visibility.groups_retry', 'Try again')}
                        </button>
                    )}
                </div>
            )}

            {orgGroups.length > 0 && (
                <>
                    <div className="px-4 py-2 border-t border-[var(--border-default)]">
                        <div className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
                            {t('visibility.or_specific_groups', 'Or specific groups')}
                        </div>
                    </div>
                    <GroupChecklist t={t} orgGroups={orgGroups} sharedGroups={groups} onToggle={toggleGroup} />
                    {lastGroupHint && (
                        <div className="px-4 pb-2 text-[11px] text-[var(--text-tertiary)]" role="status" data-testid="visibility-last-group-hint">
                            {t('visibility.last_group_hint', 'Choose Personal to stop sharing')}
                        </div>
                    )}
                </>
            )}

            {embedEnabled && agent?.id && (
                <div className="text-[11px] text-[var(--text-tertiary)] px-4 py-2 border-t border-[var(--border-default)]">
                    {t('visibility.embed_hint', 'Web embed is on — manage it in Behavior.')}
                </div>
            )}

            {/* Extension slot — webpages mount their external-share manager here.
                Agents leave it null and the menu reads identically to before. */}
            {extraSection}
        </>
    );

    const panelWidth = extraSection ? 380 : 320;

    return (
        <>
            {trigger}
            {anchored ? (
                <AnchoredMenu
                    open={open}
                    onClose={onClose}
                    anchorRef={triggerRef}
                    align="right"
                    width={panelWidth}
                    role="dialog"
                    aria-label={t('visibility.title', 'Publish to…')}
                    data-testid="visibility-panel"
                    className="overflow-hidden"
                    style={{ background: 'var(--bg-card)', borderRadius: 12, padding: 0 }}
                >
                    {panelBody}
                </AnchoredMenu>
            ) : (open && (
                <div
                    ref={popoverRef}
                    role="dialog"
                    aria-label={t('visibility.title', 'Publish to…')}
                    data-testid="visibility-panel"
                    className={`absolute z-30 right-8 top-full mt-1 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-xl overflow-hidden ${extraSection ? 'w-[380px]' : 'w-[320px]'}`}
                >
                    {panelBody}
                </div>
            ))}
            {confirmDialog}
        </>
    );
}
