import { ArrowLeft, Check, ChevronDown } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import AnchoredMenu from './AnchoredMenu';
import { kindIcon, kindOf, kindTileStyle } from './kindColors';
import SegmentedControl, { resolveSegmentedBadge } from './SegmentedControl';
import useTranslation from '../../hooks/useTranslation';

/**
 * StudioSectionHeader — THE 48px header of every Studio object (Bee Flow
 * Builder redesign, Sep 2026; Studio Home artboard 1b "Gedeelde patronen",
 * plan 0.2). Knowledge bases, tables, apps, skills, agents, meeting notes,
 * webpages and solutions all open with this one row, so a user who learns
 * where "back", the name, the tabs and the publish capsule sit in one
 * section finds them in the same place in every other.
 *
 * The row, left to right (artboard 1b line 98, measurements literal):
 *
 *   back arrow 32×32 r8 · kind tile 28px (18% tint, shape per kind) ·
 *   name 14/600 (inline rename) · status chip 11px r999 border-default ·
 *   flex:1 · segment tabs with counts · flex:1 · capsule · primary · extras
 *
 * It is a COMPOSITE of the shared primitives and owns no state of its own
 * beyond the rename draft and the narrow-width tab menu:
 *   - the tile comes from `kindColors.kindTileStyle(kind, {size: 28, pct: 18})`
 *     (0.1) — never a colour of its own;
 *   - the tabs are `SegmentedControl` (`role=radiogroup`) with its `badge`
 *     slot: `{ count, tone }` renders NOTHING when the count is absent, so a
 *     badge-less strip keeps its exact textContent;
 *   - `capsule` is the caller's `VisibilityCapsule variant="capsule"
 *     anchored` (0.3) and `primary` its `StatusActionPill` or filled button.
 *
 * Fit stages. The row NEVER wraps (`h-12 flex-nowrap min-w-0`); instead it
 * reads its OWN width through a named `@container/objhead` — the recipe of
 * automation/Builder/BuilderHeader.jsx:125-136 (`@container/bar`), which the
 * App Studio EditorHeader shares under `edhead` — and folds in two stages:
 *
 *   < 1440px   labels fold to icons: a tab that carries an `icon` keeps only
 *              the icon, the name gets less room (max-w 22rem → 12rem).
 *              Callers fold their own words with `OBJHEAD_FOLD.label`.
 *   < 1180px   the segment strip folds into ONE menu button (the current
 *              tab's name + a chevron, a portalled `AnchoredMenu`), and
 *              action words fold with `OBJHEAD_FOLD.action`. A header beside
 *              a wide rail passes `tabsFold="compact"`: the strip holds to 900px.
 *
 * jsdom lays nothing out, so StudioSectionHeader.responsiveFold.test.jsx
 * pins the container name and both stages as SOURCE. Tailwind only emits a
 * variant it can read as one literal, which is why the fold classes are
 * spelled out below rather than built from the container name — and why a
 * `StatusActionPill containerName="objhead"` folds correctly inside this
 * header: the literals it needs live in this file.
 *
 * Primary actions. The artboard fills the primary action with ink
 * (`background: var(--text-primary)`); that fill was REJECTED for
 * interactive elements (user feedback 2026-09-03, recorded at
 * BuilderHeader.jsx:318-325 and in StatusActionPill's docblock). A filled
 * button a caller passes as `primary` MUST use the theme's accent recipe —
 * `style={PRIMARY_ACTION_STYLE}`, i.e. `background: var(--accent-primary);
 * color: var(--accent-primary-fg)` — or be a `StatusActionPill`, which
 * already does. Nothing in this header paints ink on a button.
 *
 * Props
 *   kind        one of kindColors' KIND_KEYS or an alias ('kb', 'table', …);
 *               the tile's colour, shape and default glyph follow it
 *   icon        overrides the glyph: a lucide component or a ready element
 *   title       the object's name (14px / 600). Empty → "Untitled"
 *   onRename    (next: string) => void — when given the name is a button
 *               that turns into an input; Enter/blur commit, Escape cancels,
 *               an unchanged or empty draft never calls back
 *   renameRequest  a counter; every change opens that same inline edit — for
 *               a "Rename…" item in the caller's ⋯ menu
 *   statusChip  a string ("Saved · v3") painted as the 11px chip, or a ready
 *               element (a SaveStatus pill) rendered as-is in the same slot
 *   tabs        [{ id, label, count?, tone?, icon?, disabled? }] — `count` and
 *               `tone` ('neutral' | 'error' | 'warning') feed the badge slot;
 *               "Used by" is always the last tab (artboard 1b)
 *   activeTab   id of the current tab
 *   onTab       (id) => void
 *   tabsFold    'compact' folds the tab strip into its menu below 900px
 *               instead of 1180px; omitted → the 1180 fold
 *   titleMin    true never shrinks the name (it still truncates at its
 *               max width), so a crowded row cannot squeeze it to nothing
 *   capsule     node — the visibility capsule slot (left of the primary)
 *   primary     node — the ONE primary action / status pill
 *   extras      node — anything after the primary (overflow menus, help)
 *   onBack      () => void — the back arrow; omitted → no arrow
 *   backLabel   accessible name of the arrow: say WHERE back goes
 *               ("Back to Knowledge") — a bare "Back" names no destination
 *   className   extra classes on the outer row
 *   testId      data-testid on the outer row ('studio-section-header')
 */

/** The container the fold classes address — `StatusActionPill containerName={OBJHEAD}`. */
export const OBJHEAD = 'objhead';

/**
 * Literal fold classes for callers composing `primary` / `extras` content:
 * wrap a word in `OBJHEAD_FOLD.label` to drop it at the icon stage, in
 * `OBJHEAD_FOLD.action` to keep it until the menu stage. Same two widths as
 * StatusActionPill.FOLD_CLASSES for `bar` and `edhead`.
 */
export const OBJHEAD_FOLD = Object.freeze({
    label: '@max-[1440px]/objhead:hidden',
    action: '@max-[1180px]/objhead:hidden',
    compact: '@max-[900px]/objhead:hidden',
});

/** The strip / menu pair of each tab fold (literals: Tailwind must read them whole). */
const TAB_FOLD = Object.freeze({
    default: Object.freeze({ strip: 'flex-shrink-0 @max-[1180px]/objhead:hidden', menu: 'hidden @max-[1180px]/objhead:block' }),
    compact: Object.freeze({ strip: 'flex-shrink-0 @max-[900px]/objhead:hidden', menu: 'hidden @max-[900px]/objhead:block' }),
});

/** The theme's filled-button recipe a caller-supplied `primary` must wear. */
export const PRIMARY_ACTION_STYLE = Object.freeze({
    background: 'var(--accent-primary)',
    color: 'var(--accent-primary-fg)',
});

const BADGE_TONE_COLOR = Object.freeze({
    neutral: 'var(--text-tertiary)',
    error: 'var(--error)',
    warning: 'var(--warning)',
});

function renderGlyph(icon, style) {
    if (!icon) return null;
    if (React.isValidElement(icon)) return icon;
    const Icon = icon;
    return <Icon style={style} aria-hidden="true" />;
}

/** The 28px kind tile: colour and shape from kindColors, glyph 15px. */
function KindTile({ kind, icon }) {
    const key = kindOf(kind);
    const { tile, glyph } = kindTileStyle(key, { size: 28, pct: 18 });
    const Glyph = icon ?? kindIcon(key);
    if (!Glyph) return null;
    return (
        <div style={tile} data-testid="studio-section-kind" data-kind={key ?? ''} aria-hidden="true">
            {renderGlyph(Glyph, glyph)}
        </div>
    );
}

/** The name: a plain 14/600 span, or a rename-on-click button + input. */
function Title({ title, onRename, renameRequest = 0, t }) {
    const display = (title || '').trim();
    const shown = display || t('studio.header.untitled', 'Untitled');
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(display);
    const inputRef = useRef(null);

    // A caller's "Rename…" menu item opens the SAME inline edit rather than
    // growing a second rename UI: it bumps `renameRequest`, and the title
    // enters editing on the change (never on mount).
    const lastRequest = useRef(renameRequest);
    useEffect(() => {
        if (renameRequest !== lastRequest.current) {
            lastRequest.current = renameRequest;
            // eslint-disable-next-line react-hooks/set-state-in-effect
            if (onRename) setEditing(true);
        }
    }, [renameRequest, onRename]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (!editing) setDraft(display);
    }, [display, editing]);

    useEffect(() => {
        if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
    }, [editing]);

    const commit = () => {
        const next = (draft || '').trim();
        setEditing(false);
        if (!next || next === display) { setDraft(display); return; }
        onRename?.(next);
    };
    const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); setDraft(display); setEditing(false); }
    };

    const textClass = 'text-[14px] font-semibold text-[var(--text-primary)] truncate';

    if (!onRename) {
        return <h1 className={`${textClass} m-0`} data-testid="studio-section-title">{shown}</h1>;
    }
    if (editing) {
        return (
            <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={onKey}
                aria-label={t('studio.header.rename', 'Rename')}
                data-testid="studio-section-title-input"
                className="flex-1 min-w-0 text-[14px] font-semibold bg-transparent border-b border-[var(--accent-primary)] outline-none text-[var(--text-primary)]"
            />
        );
    }
    return (
        <button
            type="button"
            onClick={() => setEditing(true)}
            title={t('studio.header.rename_hint', 'Click to rename')}
            data-testid="studio-section-title"
            className={`${textClass} hover:bg-[var(--bg-tertiary)] rounded px-1 -mx-1 transition text-left`}
        >
            {shown}
        </button>
    );
}

/** "Saved · v3": 11px, tertiary ink, hairline border, full radius. */
function StatusChip({ chip }) {
    if (chip === null || chip === undefined || chip === false || chip === '') return null;
    if (React.isValidElement(chip)) return chip;
    return (
        <span
            data-testid="studio-section-status"
            className="text-[11px] whitespace-nowrap flex-shrink-0"
            style={{
                color: 'var(--text-tertiary)',
                padding: '3px 8px',
                borderRadius: 999,
                border: '1px solid var(--border-default)',
            }}
        >
            {chip}
        </span>
    );
}

/** tabs[] → SegmentedControl options; the label folds to its icon at the first stage. */
function toOptions(tabs) {
    return tabs.map((tab) => ({
        value: tab.id,
        icon: tab.icon ? renderGlyph(tab.icon, { width: 14, height: 14, display: 'inline-flex' }) : undefined,
        label: tab.icon ? <span className={OBJHEAD_FOLD.label}>{tab.label}</span> : tab.label,
        badge: { count: tab.count, tone: tab.tone },
        disabled: tab.disabled,
    }));
}

/**
 * The narrow-width fallback: the same tabs as one menu — the pattern of
 * BuilderHeader's ViewMenu, portalled through AnchoredMenu so the panel
 * cannot be clipped by the scrolling chrome a 48px bar sits in (BFSF-328).
 */
function TabMenu({ tabs, activeTab, onTab, t }) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef(null);
    const current = tabs.find((tab) => tab.id === activeTab) || tabs[0];
    const currentBadge = current ? resolveSegmentedBadge({ count: current.count, tone: current.tone }) : null;
    return (
        <div className="flex-shrink-0">
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('studio.header.tabs', 'Sections')}
                data-testid="studio-section-tab-menu"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[13px] font-medium bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
            >
                <span>{current?.label}</span>
                {currentBadge && (
                    <span className="tabular-nums" style={{ color: BADGE_TONE_COLOR[currentBadge.tone] }}>{currentBadge.count}</span>
                )}
                <ChevronDown size={13} className="opacity-60" aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="left"
                width={200}
                role="menu"
                aria-label={t('studio.header.tabs', 'Sections')}
                className="py-1"
            >
                {tabs.map((tab) => {
                    const active = tab.id === activeTab;
                    const badge = resolveSegmentedBadge({ count: tab.count, tone: tab.tone });
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            disabled={!!tab.disabled}
                            onClick={() => { onTab?.(tab.id); setOpen(false); }}
                            className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition disabled:opacity-50 ${
                                active
                                    ? 'text-[var(--text-primary)] bg-[var(--bg-secondary)]'
                                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
                            }`}
                        >
                            <Check size={13} aria-hidden="true" className={active ? 'opacity-100' : 'opacity-0'} />
                            <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                            {badge && (
                                <span className="tabular-nums" style={{ color: BADGE_TONE_COLOR[badge.tone] }}>{badge.count}</span>
                            )}
                        </button>
                    );
                })}
            </AnchoredMenu>
        </div>
    );
}

/** The back arrow: 32×32, radius 8, secondary ink; its name says where it goes. */
function BackButton({ onBack, label }) {
    return (
        <button
            type="button"
            onClick={onBack}
            title={label}
            aria-label={label}
            data-testid="studio-section-back"
            className="grid place-items-center w-8 h-8 rounded-lg flex-shrink-0 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition"
        >
            <ArrowLeft size={16} aria-hidden="true" />
        </button>
    );
}

/**
 * The centred tab strip between two flex:1 spacers (artboard 1b lines
 * 103-105), with its narrow-width menu twin. The strip and the menu are BOTH
 * in the DOM; the container query decides which one paints.
 */
function TabsSlot({ tabs, activeTab, onTab, fold, t }) {
    const cls = TAB_FOLD[fold] || TAB_FOLD.default;
    return (
        <>
            <div className={cls.strip}>
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('studio.header.tabs', 'Sections')}
                    value={activeTab}
                    onChange={(id) => onTab?.(id)}
                    options={toOptions(tabs)}
                />
            </div>
            {/* Narrow: the same tabs as one menu. */}
            <div className={cls.menu}>
                <TabMenu tabs={tabs} activeTab={activeTab} onTab={onTab} t={t} />
            </div>
            <div className="flex-1 min-w-0" aria-hidden="true" />
        </>
    );
}

/** capsule · primary · extras, in that order, never shrinking. */
function ActionCluster({ capsule, primary, extras }) {
    if (!capsule && !primary && !extras) return null;
    return (
        <div className="flex items-center gap-2 flex-shrink-0" data-testid="studio-section-actions">
            {capsule}
            {primary}
            {extras}
        </div>
    );
}

// Slot props deliberately carry no defaults: every child below treats
// `undefined` as "not given", and each default would count against the
// lint complexity budget without changing behaviour.
export default function StudioSectionHeader({
    kind,
    icon,
    title,
    onRename,
    renameRequest = 0,
    statusChip,
    tabs,
    activeTab,
    onTab,
    tabsFold,
    titleMin,
    capsule,
    primary,
    extras,
    onBack,
    backLabel,
    className = '',
    testId = 'studio-section-header',
}) {
    const { t } = useTranslation();
    const tabList = Array.isArray(tabs) ? tabs.filter(Boolean) : [];

    return (
        // One 48px row that never wraps (artboard 1b). Fit stages read the
        // ROW's own width (a named @container, the BuilderHeader recipe):
        //   <1440px  tab labels fold to icons, the name gets less room
        //   <1180px  the segment strip folds into one menu (compact: <900px)
        <div
            className={`@container/objhead flex items-center gap-x-2.5 px-3 h-12 flex-nowrap min-w-0 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] ${className}`.trim()}
            data-testid={testId}
        >
            {onBack && <BackButton onBack={onBack} label={backLabel || t('studio.header.back', 'Back')} />}
            <KindTile kind={kind} icon={icon} />
            <div className={`${titleMin ? 'shrink-0' : 'min-w-0'} max-w-[22rem] @max-[1440px]/objhead:max-w-[12rem] flex items-center gap-2`}>
                <Title title={title} onRename={onRename} renameRequest={renameRequest} t={t} />
            </div>
            <StatusChip chip={statusChip} />
            <div className="flex-1 min-w-0" aria-hidden="true" />
            {tabList.length > 0 && <TabsSlot tabs={tabList} activeTab={activeTab} onTab={onTab} fold={tabsFold} t={t} />}
            <ActionCluster capsule={capsule} primary={primary} extras={extras} />
        </div>
    );
}
