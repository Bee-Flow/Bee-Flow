import { peekSections, type PeekEntry } from '../listPeek';
import { walkPath } from '../resolveBinding';
import { roleTextColor } from '../styleResolver';
import { ROLE_COLORS } from '../styleResolver.constants';
import { displayValue } from '../uiBits';
import type { TranslateParams } from '../../../../../../hooks/useTranslation';
import type { PeekPanelOpts } from './AppList.types';

/** Panel width; also the space the row needs on its right to open there. */
export const PEEK_WIDTH = 320;

/** "3 min", "2 h", "5 d" — short enough for a narrow sidebar. */
export function relativeTime(value: unknown, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    if (value == null || value === '') return null;
    const then = new Date(value as string | number | Date).getTime();
    if (Number.isNaN(then)) return displayValue(value);
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return t('studio_apps_runtime.list.now', 'now');
    if (mins < 60) return t('studio_apps_runtime.list.minutes', '{n} min', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('studio_apps_runtime.list.hours', '{n} h', { n: hours });
    return t('studio_apps_runtime.list.days', '{n} d', { n: Math.round(hours / 24) });
}

export function badgeStyle(tone: string | null | undefined) {
    if (!tone || tone === 'neutral') {
        return { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' };
    }
    const color = ROLE_COLORS[tone] || ROLE_COLORS.primary;
    // The wash keeps the role's hue; the TEXT has to be readable on it, which
    // the raw hex is not in the light themes.
    return { background: `color-mix(in srgb, ${color} 16%, transparent)`, color: roleTextColor(tone) };
}

/**
 * The floating panel: the row's related records, in group order, capped.
 *
 * Deliberately not interactive — pointer-events are off in the stylesheet, so
 * a panel hanging over the pane next to the list can never swallow a click
 * meant for what is underneath it.
 */
export function renderPeekPanel(entry: PeekEntry, at: { index: number; top: number; left: number; maxHeight: number }, opts: PeekPanelOpts) {
    const { sections, more } = peekSections(entry, opts.peekLimit);
    if (!sections.length) return null;
    const moreText = more
        ? (typeof opts.peekMoreText === 'string' && opts.peekMoreText
            ? opts.peekMoreText.split('{count}').join(String(more))
            : opts.t('studio_apps_runtime.list.peek_more', '+ {n} more', { n: more }))
        : null;
    return (
        <div
            className="app-list-peek"
            role="tooltip"
            data-app-list-peek-panel="true"
            style={{ position: 'fixed', top: at.top, left: at.left, width: PEEK_WIDTH, maxHeight: at.maxHeight }}
        >
            {opts.peekTitle ? <div className="app-list-peek__title">{opts.peekTitle}</div> : null}
            {sections.map((section) => (
                <div key={section.value} className="app-list-peek__section">
                    {opts.showGroups ? (
                        <div className="app-list-peek__group">
                            <span className="truncate">{section.label || '—'}</span>
                            <span className="tabular-nums">{section.count}</span>
                        </div>
                    ) : null}
                    {section.rows.map((row, ri) => {
                        const text = opts.peekTextKey ? walkPath(row, opts.peekTextKey) : null;
                        return (
                            <div key={ri} className="app-list-peek__row">
                                {opts.peekTitleKey ? (
                                    <span className="app-list-peek__row-title truncate">
                                        {displayValue(walkPath(row, opts.peekTitleKey))}
                                    </span>
                                ) : null}
                                {text != null && text !== '' ? (
                                    <span className="app-list-peek__row-text truncate">{displayValue(text)}</span>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ))}
            {moreText ? <div className="app-list-peek__more">{moreText}</div> : null}
        </div>
    );
}
