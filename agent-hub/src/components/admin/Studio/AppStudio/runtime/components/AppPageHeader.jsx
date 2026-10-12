import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import AppIcon from '../../../../../icons/AppIcon';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { spaceSteps } from '../styleResolver';

/**
 * App Studio runtime — 'page_header' (container). Spec: server/appStudio/componentSpecs.js.
 * Title/subtitle/icon on the left; the node's CHILDREN render right-aligned as
 * the action area (typically buttons). The optional divider closes the header.
 *
 * `titleFrom`/`subtitleFrom` bind the header to what is on screen. Without them
 * the title was a literal authored at design time, so the subject of the open
 * e-mail could only appear as a labelled field inside a record_detail — which is
 * exactly why the conversation view read like a form rather than a conversation.
 *
 * Look pass — `props.look` (spec: componentSpecs.js): 'plain' (default) is the
 * untouched original path; 'banner'/'hero' paint a primary band (soft wash /
 * gradient — token-derived, no literal colors, so text stays on the platform
 * text tokens and readable in both host themes); 'split' pushes the subtitle to
 * the right, muted, over the hairline. banner/hero drop the divider: the band
 * itself closes the header, and a rule under a filled band would read as a
 * second border.
 *
 * THE ACTION ROW MAY SHRINK, AND THEREFORE MAY WRAP.
 * It used to carry `flex-wrap shrink-0` together, which cannot both be true:
 * `shrink-0` sizes the row to max-content and refuses to yield a pixel, and a
 * box that is never asked to be narrower than its content never wraps. So the
 * whole width deficit landed on the `min-w-0 flex-1` text column, and a header
 * with five buttons rendered its title as "Projectr…" and its subtitle as
 * "Verwerken m…" — the two things the header exists to say, sacrificed for
 * buttons that are self-describing.
 *
 * Now the row wraps to its own line instead, and the title column keeps a
 * readable floor (`basis-64`). Below that floor the title still truncates, so
 * both it and the subtitle carry `title=` — clipped text a pointer can recover
 * is a different thing from clipped text that is simply gone.
 */

/** A bound value that is worth showing: a non-empty scalar. */
function boundText(binding, deps) {
    if (!binding) return null;
    const { value } = resolveBinding(binding, deps);
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
}

// Two lines, not one. A subtitle may be up to 300 characters (spec) and a
// single truncated line of a 300-character sentence stops mid-word and tells
// the reader nothing — the screenshot that started this read "Lees als
// projectregels werkt op het gekozen …".
const SUBTITLE_CLAMP = 'text-sm mt-0.5 line-clamp-2';

// The width a title gets before the action row is asked to wrap instead.
const TITLE_FLOOR = 'min-w-0 flex-1 basis-64';

// No `shrink-0`: see the header note. `ml-auto` keeps the row right-aligned
// both beside the title and on a line of its own.
const ACTION_ROW = 'flex items-center justify-end flex-wrap ml-auto';

const BAND_STYLES = {
    banner: {
        background: 'var(--app-primary-soft)',
        borderRadius: 'var(--app-radius, 8px)',
        padding: spaceSteps(5),
    },
    hero: {
        background: 'linear-gradient(160deg, color-mix(in srgb, var(--app-primary) 18%, transparent), color-mix(in srgb, var(--app-primary) 4%, transparent))',
        borderRadius: 'var(--app-radius, 8px)',
        padding: `${spaceSteps(10)} ${spaceSteps(6)}`,
    },
};

function IconBadge({ icon, size = 'h-9 w-9' }) {
    if (!icon) return null;
    return (
        <span
            className={`inline-flex ${size} items-center justify-center rounded-md shrink-0`}
            style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)' }}
            aria-hidden="true"
        >
            <AppIcon name={icon} className="w-4.5 h-4.5" />
        </span>
    );
}

/** look 'hero' — a tall, centered, primary-gradient opening with breathing room. */
function HeroHeader({ icon, title, subtitle, gap, kids }) {
    return (
        <header
            className="w-full min-w-0 app-pageheader--hero"
            data-app-pageheader="true"
            data-app-pageheader-look="hero"
            style={BAND_STYLES.hero}
        >
            <div className="flex flex-col items-center text-center" style={{ gap: spaceSteps(gap) }}>
                <IconBadge icon={icon} size="h-11 w-11" />
                <div className="min-w-0">
                    <h1 className="text-3xl font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{title}</h1>
                    {subtitle ? (
                        <p className="text-base mt-1.5 break-words" style={{ color: 'var(--text-secondary)' }}>{subtitle}</p>
                    ) : null}
                </div>
                {kids.length ? (
                    <div
                        className="flex items-center justify-center flex-wrap"
                        style={{ gap: spaceSteps(2) }}
                        data-app-pageheader-actions="true"
                    >
                        {kids}
                    </div>
                ) : null}
            </div>
        </header>
    );
}

/** look 'split' — title left, subtitle right-aligned and muted, hairline below. */
function SplitHeader({ icon, title, subtitle, gap, kids, showDivider }) {
    return (
        <header
            className="w-full min-w-0 app-pageheader--split"
            data-app-pageheader="true"
            data-app-pageheader-look="split"
        >
            <div className="flex flex-wrap items-start" style={{ gap: spaceSteps(gap) }}>
                <IconBadge icon={icon} />
                <h1 className="text-xl font-semibold truncate min-w-0 basis-48 grow" title={title} style={{ color: 'var(--text-primary)' }}>{title}</h1>
                {subtitle ? (
                    <p className="text-sm mt-0.5 text-right line-clamp-2 min-w-0" title={subtitle} style={{ color: 'var(--text-muted)', maxWidth: '45%' }}>{subtitle}</p>
                ) : null}
                {kids.length ? (
                    <div
                        className={ACTION_ROW}
                        style={{ gap: spaceSteps(2) }}
                        data-app-pageheader-actions="true"
                    >
                        {kids}
                    </div>
                ) : null}
            </div>
            {showDivider ? (
                <hr className="mt-3 border-0 h-px w-full" style={{ background: 'var(--border-default)' }} aria-hidden="true" />
            ) : null}
        </header>
    );
}

export default function AppPageHeader({ node, children }) {
    const { t } = useTranslation();
    const {
        title = t('studio_apps_runtime.page_header.title', 'Page title'), subtitle = null, titleFrom = null, subtitleFrom = null,
        icon = null, showDivider = true,
    } = node.props || {};
    const { actionState, dataState, scope } = useRuntime();
    const deps = { actionState, dataState, scope };
    // The binding WINS when it resolves; the literal stays the fallback for the
    // editor canvas and for the moment before data arrives.
    const shownTitle = boundText(titleFrom, deps) ?? title;
    const shownSubtitle = boundText(subtitleFrom, deps) ?? subtitle;
    const gap = Number.isFinite(node.style?.gap) ? node.style.gap : 3;
    const kids = React.Children.toArray(children);
    const look = node.props?.look;

    if (look === 'hero') {
        return <HeroHeader icon={icon} title={shownTitle} subtitle={shownSubtitle} gap={gap} kids={kids} />;
    }
    if (look === 'split') {
        return <SplitHeader icon={icon} title={shownTitle} subtitle={shownSubtitle} gap={gap} kids={kids} showDivider={showDivider} />;
    }

    const banner = look === 'banner';
    return (
        <header
            className={`w-full min-w-0${banner ? ' app-pageheader--banner' : ''}`}
            data-app-pageheader="true"
            data-app-pageheader-look={banner ? 'banner' : undefined}
            style={banner ? BAND_STYLES.banner : undefined}
        >
            <div className="flex flex-wrap items-start" style={{ gap: spaceSteps(gap) }}>
                {icon ? (
                    <span
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md shrink-0"
                        style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)' }}
                        aria-hidden="true"
                    >
                        <AppIcon name={icon} className="w-4.5 h-4.5" />
                    </span>
                ) : null}
                <div className={TITLE_FLOOR}>
                    <h1 className="text-xl font-semibold truncate" title={shownTitle} style={{ color: 'var(--text-primary)' }}>{shownTitle}</h1>
                    {shownSubtitle ? (
                        <p className={SUBTITLE_CLAMP} title={shownSubtitle} style={{ color: 'var(--text-secondary)' }}>{shownSubtitle}</p>
                    ) : null}
                </div>
                {kids.length ? (
                    <div
                        className={ACTION_ROW}
                        style={{ gap: spaceSteps(2) }}
                        data-app-pageheader-actions="true"
                    >
                        {kids}
                    </div>
                ) : null}
            </div>
            {showDivider && !banner ? (
                <hr className="mt-3 border-0 h-px w-full" style={{ background: 'var(--border-default)' }} aria-hidden="true" />
            ) : null}
        </header>
    );
}
