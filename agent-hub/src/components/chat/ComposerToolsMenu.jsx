/**
 * ComposerToolsMenu — the composer's "+" button and the one panel behind it.
 *
 * The chat composer used to carry up to eight loose icons (attach, media, web
 * search, memory, knowledge bases, voice, skills, apps) in a row under the
 * textarea. Every one of them was a bare glyph whose meaning you had to hover
 * to learn, and together they made the box look busy rather than capable.
 *
 * They all live here now, as named rows in a single quiet panel, grouped by
 * what they actually do:
 *
 *   Add     what goes INTO this message    (files, generated media)
 *   Reach   what the assistant may draw ON (knowledge bases, apps, skills)
 *   Mode    how this turn behaves          (web search, memory, voice)
 *
 * The composer keeps only what is used on nearly every message: "+", the
 * response-depth gauge, and Send.
 *
 * Rows of kind `panel` open as a FLYOUT beside the menu — hover the row and the
 * picker appears to its right, menu still open, the way the left nav's sections
 * work. They still do not implement that picker: each hands off to the
 * component that already owns one (SkillsPopover, AppsPicker, the KB picker,
 * the media menu), passed in as `children` so it positions inside the flyout.
 * One implementation of each picker, one place that decides where it sits.
 *
 * Props:
 *   items — array of row descriptors, rendered in order:
 *     {
 *       id       string   unique, also drives the test id
 *       label    string   the row's name; the only text a row ever shows
 *       icon     Component | string   lucide icon, or an emoji
 *       group    'add' | 'reach' | 'mode'   dividers are drawn between groups
 *       kind     'action' | 'toggle' | 'panel'
 *       on       bool     toggle state (kind: 'toggle')
 *       open     bool     flyout state (kind: 'panel'), owned by the caller
 *       onOpenChange fn   (kind: 'panel') open/close the caller's picker
 *       badge    number   count chip, e.g. attached KBs or active skills
 *       beta     bool     renders the beta chip
 *       dot      bool     this state is worth advertising while collapsed
 *       disabled bool     row is inert; `hint` says why
 *       hint     string   title text — never rendered as a second line
 *       onSelect fn       'action' and 'toggle' rows only
 *     }
 *     Falsy entries are skipped, so callers can inline their gating.
 *
 *   children — the handed-off pickers, mounted inside the flyout slot. Each is
 *     expected to be `<div class="relative">` wrapping its own absolutely
 *     positioned panel, which is what every picker in this codebase already is.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, ChevronRight } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';

const GROUP_ORDER = ['add', 'reach', 'mode'];

const MENU_WIDTH = 236;
const FLYOUT_GAP = 8;
// Long enough that sweeping the pointer down the list doesn't fire four
// pickers' worth of fetches on the way past.
const HOVER_DELAY_MS = 140;

/** Small sliding switch — the only affordance that says "this stays on". */
function Switch({ on }) {
    return (
        <span
            aria-hidden="true"
            style={{
                position: 'relative', display: 'inline-block',
                width: '24px', height: '14px', borderRadius: '9999px',
                background: on ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                border: '1px solid var(--border-subtle)',
                transition: 'background 0.15s ease',
                flexShrink: 0,
            }}
        >
            <span style={{
                position: 'absolute', top: '1px', left: on ? '11px' : '1px',
                width: '10px', height: '10px', borderRadius: '9999px',
                background: on ? 'var(--accent-primary-fg, #fff)' : 'var(--text-tertiary)',
                transition: 'left 0.15s ease, background 0.15s ease',
            }} />
        </span>
    );
}

function Row({ item, onPick, onHover, t }) {
    const Icon = item.icon;
    const isPanel = item.kind === 'panel';
    const active = item.kind === 'toggle' ? !!item.on : (isPanel ? !!item.open : false);
    const tinted = active || !!item.badge;
    return (
        <button
            type="button"
            role={item.kind === 'toggle' ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.kind === 'toggle' ? !!item.on : undefined}
            aria-haspopup={isPanel ? 'dialog' : undefined}
            aria-expanded={isPanel ? !!item.open : undefined}
            disabled={!!item.disabled}
            title={item.hint || item.label}
            data-testid={`composer-tool-${item.id}`}
            onClick={() => onPick(item)}
            onMouseEnter={() => onHover(item)}
            onFocus={() => onHover(item)}
            className="composer-tool-row"
            style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                width: '100%', padding: '7px 9px', borderRadius: '9px',
                border: 'none', textAlign: 'left',
                background: isPanel && item.open ? 'var(--bg-tertiary)' : 'transparent',
                cursor: item.disabled ? 'not-allowed' : 'pointer',
                opacity: item.disabled ? 0.45 : 1,
                color: 'var(--text-primary)',
                font: 'inherit', fontSize: '13px', lineHeight: '18px',
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: '16px', height: '16px', flexShrink: 0, fontSize: '14px',
                    color: tinted ? 'var(--accent-primary)' : 'var(--text-tertiary)',
                }}
            >
                {typeof Icon === 'string' ? Icon : Icon ? <Icon className="w-4 h-4" /> : null}
            </span>

            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.label}
            </span>

            {item.beta && (
                <span style={{
                    fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                    padding: '1px 4px', borderRadius: '4px', flexShrink: 0,
                    background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)',
                }}>{t('chat.composer.beta_badge', 'beta')}</span>
            )}

            {item.badge > 0 && (
                <span style={{
                    fontSize: '10px', fontWeight: 700, lineHeight: '15px',
                    minWidth: '15px', height: '15px', padding: '0 4px', borderRadius: '9999px',
                    textAlign: 'center', flexShrink: 0,
                    background: 'var(--accent-primary)', color: 'var(--accent-primary-fg, #fff)',
                }}>{item.badge}</span>
            )}

            {item.kind === 'toggle' && <Switch on={!!item.on} />}
            {isPanel && (
                <ChevronRight
                    aria-hidden="true"
                    className="w-3.5 h-3.5"
                    style={{ color: item.open ? 'var(--text-primary)' : 'var(--text-tertiary)', flexShrink: 0 }}
                />
            )}
        </button>
    );
}

export default function ComposerToolsMenu({ items = [], className = '', children = null }) {
    const { t } = useTranslation();
    const rows = items.filter(Boolean);
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const flyoutRef = useRef(null);
    const hoverTimer = useRef(null);
    // Correction applied when the flyout would run off an edge of the viewport.
    // Mirrored in a ref so the next measurement can subtract the offset already
    // applied — switching pickers measures the new one, not the old placement.
    const [flyoutNudge, setFlyoutNudge] = useState({ x: 0, y: 0 });
    const nudgeRef = useRef({ x: 0, y: 0 });
    nudgeRef.current = flyoutNudge;

    const openPanelId = rows.find(r => r.kind === 'panel' && r.open)?.id || null;

    // The open rows, in a ref, so the close-everything paths don't have to be
    // rebuilt (and re-bound) on every render of a fresh `items` array.
    const rowsRef = useRef(rows);
    rowsRef.current = rows;

    const closePanels = useCallback((except = null) => {
        rowsRef.current.forEach((r) => {
            if (r.kind === 'panel' && r.open && r !== except) r.onOpenChange?.(false);
        });
    }, []);

    useEffect(() => () => clearTimeout(hoverTimer.current), []);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (rootRef.current && !rootRef.current.contains(e.target)) {
                setOpen(false);
                closePanels();
            }
        };
        const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); closePanels(); } };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, closePanels]);

    // Shutting the menu takes its flyout with it — a picker left floating over
    // the conversation with nothing to anchor it reads as a bug.
    useEffect(() => {
        if (!open) closePanels();
    }, [open, closePanels]);

    // The pickers are ~320px wide and ~400px tall, opening to the right of a
    // menu that is itself inset from the composer's left edge — and the
    // composer is not always at the bottom of the window (the empty-chat
    // welcome screen centres it). Either axis can run off, so measure the
    // panel once per flyout and pull it back inside.
    useLayoutEffect(() => {
        if (!openPanelId) { setFlyoutNudge({ x: 0, y: 0 }); return; }
        // Every picker here is `<div class="relative">` wrapping its own
        // absolutely positioned panel — that inner div is the one with a size.
        const panel = flyoutRef.current?.querySelector(':scope > div > div');
        if (!panel) return;
        const m = 8;
        const r = panel.getBoundingClientRect();
        // Undo the offset already on the wrapper to get the natural placement.
        const applied = nudgeRef.current;
        const left = r.left - applied.x;
        const right = r.right - applied.x;
        const top = r.top - applied.y;
        const bottom = r.bottom - applied.y;

        let x = 0;
        if (right > window.innerWidth - m) x = (window.innerWidth - m) - right;
        if (left + x < m) x = m - left;

        let y = 0;
        if (bottom > window.innerHeight - m) y = (window.innerHeight - m) - bottom;
        // A panel taller than the space above the composer gets pinned to the
        // top edge rather than pushed off it; overflowing downward over the
        // composer is the lesser evil, and every picker scrolls internally.
        if (top + y < m) y = m - top;

        setFlyoutNudge({ x: Math.round(x), y: Math.round(y) });
    }, [openPanelId]);

    // Hovering a picker row reveals it beside the menu; hovering anything else
    // puts it away again. Debounced so a pass down the list opens nothing.
    const hover = useCallback((item) => {
        clearTimeout(hoverTimer.current);
        if (item.disabled) return;
        hoverTimer.current = setTimeout(() => {
            if (item.kind !== 'panel') { closePanels(); return; }
            closePanels(item);
            if (!item.open) item.onOpenChange?.(true);
        }, HOVER_DELAY_MS);
    }, [closePanels]);

    // Toggles and pickers stay inside the menu so you can flip two in a row;
    // only an action that acts on the message closes behind itself.
    const pick = useCallback((item) => {
        clearTimeout(hoverTimer.current);
        if (item.disabled) return;
        if (item.kind === 'panel') {
            closePanels(item);
            item.onOpenChange?.(!item.open);
            return;
        }
        if (item.kind !== 'toggle') setOpen(false);
        item.onSelect?.();
    }, [closePanels]);

    const flyout = children && (
        <div
            ref={flyoutRef}
            data-testid="composer-tools-flyout"
            style={{
                position: 'absolute',
                // Bottom edge level with the menu's, one gap to its right…
                left: `${MENU_WIDTH + FLYOUT_GAP}px`,
                bottom: '100%',
                width: 0, height: 0,
                // …then nudged back inside the viewport if it does not fit.
                transform: `translate(${flyoutNudge.x}px, ${flyoutNudge.y}px)`,
            }}
        >
            {children}
        </div>
    );

    // No rows means no button — but the handed-off pickers still need their
    // positioning root, so they are never dropped along with it.
    if (rows.length === 0) return <div className={`relative ${className}`}>{flyout}</div>;

    // Collapsed, the button still has to admit that something is switched on —
    // otherwise hiding the row hides the state with it.
    const showDot = rows.some(r => r.dot);

    const groups = GROUP_ORDER
        .map(g => rows.filter(r => (r.group || 'mode') === g))
        .filter(g => g.length > 0);

    return (
        <div className={`relative ${className}`} ref={rootRef}>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('chat.composer.tools_menu', 'Message tools')}
                title={t('chat.composer.tools_menu', 'Message tools')}
                data-testid="composer-tools-button"
                style={{
                    position: 'relative',
                    // Block-level, not inline-flex: the root is this component's
                    // positioning context for the menu and the flyout, and an
                    // inline button would add line-box leading to its height,
                    // dropping both of them onto the composer row.
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: '34px', height: '34px', borderRadius: '9999px',
                    border: '1px solid var(--border-subtle)', padding: 0, cursor: 'pointer',
                    background: open ? 'var(--bg-tertiary)' : 'transparent',
                    color: open ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    transition: 'background 0.15s ease, color 0.15s ease',
                }}
            >
                <Plus
                    className="w-[18px] h-[18px]"
                    style={{ transform: open ? 'rotate(45deg)' : 'none', transition: 'transform 0.18s cubic-bezier(0.22, 1, 0.36, 1)' }}
                />
                {showDot && !open && (
                    <span
                        aria-hidden="true"
                        data-testid="composer-tools-dot"
                        style={{
                            position: 'absolute', top: '2px', right: '2px',
                            width: '6px', height: '6px', borderRadius: '9999px',
                            background: 'var(--accent-primary)',
                            boxShadow: '0 0 0 2px var(--bg-primary)',
                        }}
                    />
                )}
            </button>

            {open && (
                <div
                    role="menu"
                    aria-label={t('chat.composer.tools_menu', 'Message tools')}
                    data-testid="composer-tools-panel"
                    onMouseLeave={() => clearTimeout(hoverTimer.current)}
                    style={{
                        position: 'absolute', bottom: '100%', left: 0, marginBottom: `${FLYOUT_GAP}px`,
                        width: `${MENU_WIDTH}px`, padding: '6px', borderRadius: '16px', zIndex: 50,
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border-subtle)',
                        boxShadow: 'var(--shadow-popover, 0 12px 36px rgba(15,23,42,0.18))',
                        animation: 'modelTierPanelIn 140ms cubic-bezier(0.22, 1, 0.36, 1) both',
                        transformOrigin: 'bottom left',
                    }}
                >
                    {groups.map((group, gi) => (
                        <React.Fragment key={group[0].id}>
                            {gi > 0 && (
                                <div style={{ height: '1px', margin: '5px 9px', background: 'var(--border-subtle)' }} />
                            )}
                            {group.map(item => <Row key={item.id} item={item} onPick={pick} onHover={hover} t={t} />)}
                        </React.Fragment>
                    ))}
                </div>
            )}

            {flyout}
        </div>
    );
}
