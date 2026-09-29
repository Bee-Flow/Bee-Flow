import { ChevronDown, Lock, Plus, Sparkles } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { createFormAutomation, groupStudioApps, studioLockHint } from './studioApps';
import { useTrainingGates, trainingLockHint } from '../../../hooks/useTrainingGates';
import { useTranslation } from '../../../hooks/useTranslation';
import AnchoredMenu from '../../shared/AnchoredMenu';
import { kindColorVar, kindIcon, kindTint } from '../../shared/kindColors';
import { toast } from '../../shared/Toast';

/**
 * NewMenu — the ONE "New" menu (Studio Home artboard 1b, "overal hetzelfde").
 *
 * Derived, not authored: the items come from `groupStudioApps(sections)` the
 * same way Sidebar.jsx derives the rail's flyout, so the rail and the menu
 * cannot drift — a section that gains a `create` entry in studioApps.jsx
 * shows up here, in its group, in its kind colour, with no edit to this
 * file. `sections` is the resolveStudioNav() output the caller already holds
 * (gate-passing sections plus the locked ones); a locked kind is listed
 * disabled with the same hint the rail shows, so a Community org learns what
 * an App is instead of never hearing of it.
 *
 *   1. "Describe it — AI picks the building blocks" (tinted --type-ai 10%)
 *      — goes wherever the CALLER says. Track H4 shipped the building-block
 *      picker (Studio/studioAi/DescribeItPanel.jsx), and a caller that mounts
 *      it hands this row its own `onAi`; the row then follows that handler
 *      unjudged, because the destination is no longer a Studio section this
 *      file could reason about. StudioHomeHeader.jsx is that caller today.
 *      Without an `onAi` the row still falls back to the automation builder's
 *      assistant (AI_FALLBACK_SECTION below), and is then LOCKED exactly when
 *      Routines are — an enabled item that navigates into a section the server
 *      403s is a button that leads to a refusal, and Studio/index.jsx renders
 *      a section even when its gate is false.
 *   2. per group, divider-separated: Build · AI · Bundle · Add-ons
 *
 * The "Form" item used to be hard-coded here, because forms had no section of
 * their own. Track H2 gave them one, and the item comes from that section's
 * `create` entry like every other — the special case had to go the moment the
 * registry could answer for it, or the menu would have listed Form twice.
 *
 * Rendered over shared/AnchoredMenu (portalled, measure-and-flip), 300px,
 * role="menu" so it gets the ARIA keyboard pattern for free. The split
 * trigger (NewMenuButton) is the 32px / radius-10 capsule the artboards
 * draw — in the ACCENT recipe, not the artboard's ink fill (recorded at
 * BuilderHeader.jsx: interactive elements never use the ink fill).
 *
 * Mounted in the Studio header (StudioHomeHeader.jsx), which also owns the
 * `onAi` destination of row 1.
 */

// Re-exported, not defined here any more: it moved to the registry beside the
// Forms descriptor whose `create` entry uses it (studioApps.jsx). Kept as an
// export so callers that reach for "make me a form" through the menu module
// keep one entry point.
export { createFormAutomation };

const itemFor = (app, t) => {
    const kind = app.create.kind || app.kind || null;
    return {
        type: 'item',
        id: app.id,
        kind,
        label: t(app.create.labelKey, app.create.labelFallback),
        Icon: kindIcon(kind) || app.Icon || null,
        color: kind ? kindColorVar(kind) : 'var(--text-secondary)',
        locked: app.locked || null,
        lockHint: app.locked ? studioLockHint(app.locked, t) : undefined,
        trainingArea: app.trainingArea || null,
        onCreate: app.create.onCreate,
    };
};

/**
 * The menu as data: `[{ type: 'ai' }, { type: 'divider' }, { type: 'item' }…]`.
 * Exported so the test (and Studio Home) can read the same list the menu
 * renders.
 */
/**
 * The section the AI row lands in when the caller did NOT hand over an `onAi`.
 *
 * Track H4 gave the row a screen of its own, but only for callers that mount
 * it; every other caller still ends up in the automation builder's assistant,
 * so for them the row can only be offered to somebody who may open Routines.
 * On a plan without them the section is either LOCKED in `sections` or absent
 * from it entirely, and an enabled menu item that navigates into a 403 is
 * worse than no item. The gate therefore stays exactly as it was: it describes
 * the FALLBACK destination, not the picker.
 */
const AI_FALLBACK_SECTION = 'aiTasks';

function aiEntry(sections, t, hasOwnHandler) {
    const entry = { type: 'ai', id: 'ai', label: t('studio.new.ai', 'Describe it — AI picks the building blocks') };
    // A caller that handed over its own onAi owns the destination; nothing
    // here can judge it.
    if (hasOwnHandler) return entry;
    const target = (sections || []).find((app) => app && app.id === AI_FALLBACK_SECTION);
    if (target && !target.locked) return entry;
    return {
        ...entry,
        locked: target?.locked || 'ceiling',
        lockHint: studioLockHint(target?.locked || 'ceiling', t),
    };
}

/**
 * `lockFor(areaId)` folds the organisation's "finish the course first" rules
 * into the SAME lock the licence gates already use, so a row locked by
 * training looks and behaves exactly like one locked by plan: disabled, with
 * a hint that says what to do about it.
 *
 * Only the menu, never the section. A training rule governs creating, not
 * reading — see studioTrainingArea in studioApps.jsx.
 */
export function buildNewMenuModel(sections, t, { hasAiHandler = false, lockFor = null } = {}) {
    const applyTraining = (item) => {
        if (item.locked || !item.trainingArea || !lockFor) return item;
        const lock = lockFor(item.trainingArea);
        if (!lock) return item;
        return { ...item, locked: 'training', lockHint: trainingLockHint(lock, t), training: lock };
    };
    const model = [applyTraining(aiEntry(sections, t, hasAiHandler))];
    for (const { category, apps } of groupStudioApps(sections || [])) {
        const items = apps.filter((app) => app && app.create).map((app) => applyTraining(itemFor(app, t)));
        if (!items.length) continue;
        model.push({ type: 'divider', id: `divider-${category.id}` });
        model.push(...items);
    }
    return model;
}

const ITEM_CLASS = 'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[12px] leading-tight transition-colors duration-100 hover:bg-[var(--bg-tertiary)] focus-visible:bg-[var(--bg-tertiary)] focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent';

export function NewMenu({
    open,
    onClose,
    anchorRef,
    sections,
    onNavigate,
    user = null,
    onAi = null,
    align = 'right',
}) {
    const { t } = useTranslation();
    const [busyId, setBusyId] = useState(null);
    // Asked for only once the menu is opened — see the hook's docblock.
    const { lockFor } = useTrainingGates({ enabled: open });
    const model = useMemo(
        () => buildNewMenuModel(sections, t, { hasAiHandler: !!onAi, lockFor }),
        [sections, t, onAi, lockFor],
    );

    const run = async (item) => {
        if (item.locked || busyId) return;
        setBusyId(item.id);
        try {
            await item.onCreate({ onNavigate, t, user });
            onClose?.();
        } catch (err) {
            toast.error(t('studio.new.failed', 'Could not create it.') + (err?.message ? ` ${err.message}` : ''));
        } finally {
            setBusyId(null);
        }
    };
    const aiItem = model[0];
    const runAi = () => {
        // A locked row is a signpost, not a door — the same contract every
        // other item in this menu keeps.
        if (aiItem?.locked) return;
        onClose?.();
        if (onAi) onAi();
        else if (onNavigate) onNavigate('studio/automations');
    };

    return (
        <AnchoredMenu
            open={open}
            onClose={onClose}
            anchorRef={anchorRef}
            align={align}
            width={300}
            role="menu"
            aria-label={t('studio.new.button', 'New')}
            className="rounded-xl p-1.5"
            style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-popover, 0 20px 60px rgba(15,23,42,0.18))' }}
            data-testid="new-menu"
        >
            {model.map((entry) => {
                if (entry.type === 'divider') {
                    return <div key={entry.id} role="separator" className="h-px my-1.5 mx-1" style={{ background: 'var(--border-default)' }} />;
                }
                if (entry.type === 'ai') {
                    return (
                        <button
                            key={entry.id}
                            type="button"
                            role="menuitem"
                            onClick={runAi}
                            disabled={!!entry.locked}
                            aria-disabled={entry.locked ? 'true' : undefined}
                            title={entry.locked ? entry.lockHint : undefined}
                            data-locked={entry.locked ? 'true' : undefined}
                            className={`${ITEM_CLASS} font-semibold`}
                            style={{ background: kindTint('agent', 10), color: 'var(--type-ai)' }}
                            data-testid="new-menu-ai"
                        >
                            <Sparkles className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={2} aria-hidden="true" />
                            <span className="flex-1 min-w-0 truncate">{entry.label}</span>
                            {entry.locked && <Lock className="w-3 h-3 flex-shrink-0 text-[var(--text-tertiary)]" strokeWidth={1.75} aria-hidden="true" />}
                        </button>
                    );
                }
                const { Icon } = entry;
                const disabled = !!entry.locked || busyId === entry.id;
                return (
                    <button
                        key={entry.id}
                        type="button"
                        role="menuitem"
                        onClick={() => run(entry)}
                        disabled={disabled}
                        aria-disabled={entry.locked ? 'true' : undefined}
                        title={entry.locked ? entry.lockHint : undefined}
                        className={`${ITEM_CLASS} text-[var(--text-primary)]`}
                        data-testid={`new-menu-${entry.id}`}
                        data-kind={entry.kind || undefined}
                        data-locked={entry.locked ? 'true' : undefined}
                    >
                        {Icon && <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: entry.color }} strokeWidth={1.75} aria-hidden="true" />}
                        <span className="flex-1 min-w-0 truncate">{entry.label}</span>
                        {entry.locked && <Lock className="w-3 h-3 flex-shrink-0 text-[var(--text-tertiary)]" strokeWidth={1.75} aria-hidden="true" />}
                    </button>
                );
            })}
        </AnchoredMenu>
    );
}

/**
 * The split trigger + the menu. `onPrimary` makes the left segment do
 * something other than open the menu (Track H may wire it to the AI row);
 * by default both segments open the menu — there is no single default
 * "new thing" in a ten-kind Studio.
 */
export function NewMenuButton({
    sections,
    onNavigate,
    user = null,
    onAi = null,
    onPrimary = null,
    label = null,
    className = '',
}) {
    const { t } = useTranslation();
    const anchorRef = useRef(null);
    const [open, setOpen] = useState(false);
    const toggle = () => setOpen((o) => !o);
    const text = label || t('studio.new.button', 'New');
    return (
        <>
            <div
                ref={anchorRef}
                className={`inline-flex items-stretch h-8 rounded-[10px] overflow-hidden text-[12px] font-semibold select-none ${className}`}
                style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                data-testid="new-menu-trigger"
            >
                <button
                    type="button"
                    onClick={onPrimary || toggle}
                    className="flex items-center gap-1.5 px-3 h-full transition-opacity hover:opacity-90 focus:outline-none focus-visible:opacity-90"
                    aria-haspopup={onPrimary ? undefined : 'menu'}
                    aria-expanded={onPrimary ? undefined : open}
                    data-testid="new-menu-primary"
                >
                    <Plus className="w-3.5 h-3.5" strokeWidth={2.25} aria-hidden="true" />
                    {text}
                </button>
                <span aria-hidden="true" className="w-px self-stretch" style={{ background: 'color-mix(in srgb, var(--accent-primary-fg) 25%, transparent)' }} />
                <button
                    type="button"
                    onClick={toggle}
                    className="flex items-center px-2.5 h-full transition-opacity hover:opacity-90 focus:outline-none focus-visible:opacity-90"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-label={t('studio.new.open_menu', 'Open the New menu')}
                    data-testid="new-menu-chevron"
                >
                    <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.25} aria-hidden="true" />
                </button>
            </div>
            <NewMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                sections={sections}
                onNavigate={onNavigate}
                user={user}
                onAi={onAi}
            />
        </>
    );
}

export default NewMenu;
