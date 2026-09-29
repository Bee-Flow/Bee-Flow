import { AlertCircle, ChevronRight, LayoutGrid, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { studioAppsApi } from '../../components/admin/Studio/AppStudio/studioAppsApi';
import { nOf } from '../../components/admin/Studio/KnowledgeStudio/plural';
import AppIcon from '../../components/icons/AppIcon';
import { useEntitlements } from '../../components/licensing/EntitlementsContext';
import { useLicenseContext } from '../../components/licensing/LicenseContext';
import EmptyState from '../../components/shared/EmptyState';
import { kindTileStyle } from '../../components/shared/kindColors';
import useTranslation from '../../hooks/useTranslation';
import scopedStorage from '../../utils/scopedStorage';

/**
 * AppsHomePage — the consumer directory at /app/apps.
 *
 * A gallery of every PUBLISHED app the signed-in user can open: the apps shared
 * with them (studioAppsApi.listAccessible, which the server already filters to
 * published + audience-matched) plus their own published apps
 * (studioAppsApi.listMine, filtered to published here). Tiles link to the
 * standalone run view at /app/apps/:id (AppRunPage). This is the end-user
 * surface — no editor chrome, no create/rename/delete.
 *
 * The card visual mirrors AppList's shared-card style (soft accent tile + name
 * + description) so an app looks the same wherever it is listed.
 *
 * A directory of twenty tools needs a way in, so the tiles sit under a row of
 * category pills (All / Sales / Service / …) and a search box in the header.
 * The vocabulary of the pills is CLOSED — see APP_CATEGORIES below — and the
 * row only appears once at least one app in view carries one of those
 * categories.
 *
 * Above that grid sits "Recently used" — the handful of apps THIS reader has
 * actually opened. See the appRecents block below for where that signal comes
 * from and, just as importantly, where it deliberately does not.
 */

// Matches AppList / APP_COLOR_PRESETS[0] (teal).
const DEFAULT_ACCENT = '#0F766E';

// The header mark: the APP kind's 26px tile at a 14% tint, straight from
// shared/kindColors — this page never spells the colour itself, so a theme
// change recolours it with every other app tile in the product.
const APP_TILE = kindTileStyle('app', { size: 26, pct: 14 });

// The app's own accent at 16% — the tint the card tiles carry across Studio.
// color-mix rather than an `${hex}29` suffix so the recipe reads as a
// percentage and survives a non-hex accent unchanged.
function accentTile(accentColor) {
    const accent = /^#[0-9a-fA-F]{6}$/.test(accentColor || '') ? accentColor : DEFAULT_ACCENT;
    return { background: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent };
}

// ── "Recently used" (per device, per user) ──────────────────────────
// Which apps THIS person reaches for. The directory can hold twenty tools and
// a person uses three of them, so the honest shortcut is "the ones you opened",
// not "the ones most recently saved by whoever built them".
//
// That signal does not exist on the server, and giving it one is a decision
// nobody has taken yet: a `studio_app_opens` table would record, per named
// person, which internal tools they open and when — an attendance log by
// accident. In a privacy product that question gets asked out loud before it
// gets built, so this half of the feature stays on the device, in per-user
// scoped storage, exactly as `utils/formRecents.js` argues for forms.
//
// The one thing this deliberately does NOT copy from formRecents: that helper
// falls back to publication date so the sidebar always has five forms to show.
// A block with the words "Recently used" over it may not do that — an app you
// have never opened appearing under that heading is simply a false statement.
// No history means no section.
const RECENTS_KEY = 'appRecents';
// A few more than the section shows, so dropping off the list is not the same
// as being forgotten — reopening an older app should restore its place.
const REMEMBERED = 12;
// The design's row of three wide cards. More than that and "recent" stops
// being a shortcut and becomes a second copy of the directory.
export const RECENTS_SHOWN = 3;

/** `{ [appId]: epochMs }`, never throwing on absent or corrupt storage. */
export function readAppRecents() {
    try {
        const parsed = JSON.parse(scopedStorage.getItem(RECENTS_KEY) || 'null');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // Drop anything that is not a usable timestamp rather than letting it
        // sort unpredictably later.
        return Object.fromEntries(
            Object.entries(parsed).filter(([, at]) => Number.isFinite(at) && at > 0),
        );
    } catch {
        return {};
    }
}

/** Stamp an app as opened by this user, now. */
export function rememberAppOpened(id, now = Date.now()) {
    if (!id) return;
    const next = { ...readAppRecents(), [id]: now };
    const trimmed = Object.fromEntries(
        Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, REMEMBERED),
    );
    try {
        scopedStorage.setItem(RECENTS_KEY, JSON.stringify(trimmed));
    } catch {
        // A full quota is not worth failing a navigation over.
    }
}

/**
 * The apps to show under "Recently used": only the ones this reader has
 * actually opened, most recent first, capped at `limit`. An app that is no
 * longer in `apps` (unpublished, unshared, deleted) drops out on its own,
 * because the list is filtered rather than looked up.
 */
export function recentApps(apps, limit = RECENTS_SHOWN, recents = readAppRecents()) {
    const list = Array.isArray(apps) ? apps : [];
    return list
        .filter((a) => a?.id && recents[a.id])
        .sort((a, b) => recents[b.id] - recents[a.id])
        .slice(0, Math.max(0, limit));
}

// ── Category filter (closed vocabulary) ─────────────────────────────
// A CLOSED vocabulary, on purpose. Free-text categories give you twelve
// chips and a spelling mistake ("Finance", "finance", "Financiën"); a fixed
// list keeps the row short and makes the same department read the same word
// in every organisation. The value lives on the app row (server side) — this
// list is the only thing that may become a chip.
//
// Anything else an app carries (an empty value, a legacy free-text string, a
// category retired from the list) is treated as UNCATEGORISED: the app stays
// reachable under "All" and never mints a chip of its own. That is what makes
// the list closed rather than merely suggested.
const APP_CATEGORIES = ['sales', 'service', 'finance', 'hr', 'internal'];

// Labels resolve through t() at the call site (never stored English), so the
// pill row follows the reader's language while the stored value stays a
// stable key.
const CATEGORY_LABELS = {
    sales: (t) => t('apps.category.sales', 'Sales'),
    service: (t) => t('apps.category.service', 'Service'),
    finance: (t) => t('apps.category.finance', 'Finance'),
    hr: (t) => t('apps.category.hr', 'HR'),
    internal: (t) => t('apps.category.internal', 'Internal'),
};

/** The app's category when it is one of the closed list, else null. */
function appCategory(app) {
    const raw = app?.category;
    if (typeof raw !== 'string') return null;
    const key = raw.trim().toLowerCase();
    return APP_CATEGORIES.includes(key) ? key : null;
}

/**
 * The closed-list categories at least one app in view carries, in the LIST's
 * own order — so the row never reshuffles itself between two loads.
 */
function categoriesInView(apps) {
    return APP_CATEGORIES.filter((c) => apps.some((a) => appCategory(a) === c));
}

/** The apps under a chip; 'all' (and any stale selection) shows everything. */
function visibleUnder(apps, category) {
    return category === 'all' ? apps : apps.filter((a) => appCategory(a) === category);
}

// ── Search ──────────────────────────────────────────────────────────
// Twenty tools is past the point where scanning the grid works, and the
// browser's own ctrl-F only finds what is already painted. The filter runs
// over the list the page ALREADY holds — the directory is org-sized, not
// install-sized, so there is nothing to ask the server for.
//
// Name and description both, because half the apps in a real directory are
// named after the department that ordered them ("Bakker-tool") and the
// description is the only place the word "invoice" appears.
function matchesQuery(app, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return true;
    const haystack = `${app?.name || ''} ${app?.description || ''}`.toLowerCase();
    return haystack.includes(q);
}

// ── "new" ───────────────────────────────────────────────────────────
// A badge that says an app was published recently. Two weeks, not one: a
// reader back from a week away should still be told what appeared while they
// were gone, and a badge that expires faster than a holiday tells the people
// who most need it the least.
//
// publishedAt is the only date that can carry this. updatedAt moves every
// time the builder saves a typo fix, and a tool everyone has used for a year
// wearing a "new" badge because of a comma is worse than no badge at all.
const NEW_FOR_MS = 14 * 24 * 60 * 60 * 1000;

function isNewlyPublished(app, now = Date.now()) {
    const at = Date.parse(app?.publishedAt || '');
    if (!Number.isFinite(at)) return false;
    // A future stamp (clock skew, a seeded fixture) is not "new" — it is
    // wrong, and a badge is not the place to argue about it.
    return at <= now && now - at < NEW_FOR_MS;
}

/**
 * Directory order: by NAME.
 *
 * It used to be `updatedAt` — "last touched by whoever built it", which for a
 * reader is noise: an app moves to the front because someone fixed a label in
 * it. The design asks for "most used", but this product has no honest usage
 * number yet (the only run log counts action runs and misses whole categories
 * of app), and a line that names a sort the data cannot support is worse than
 * a plain one. Name it is — the same order the sidebar's Studio flyout
 * already uses, so two surfaces stop answering the question two ways, and the
 * one order a reader can predict well enough to aim at.
 */
function byName(a, b) {
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {
        numeric: true, sensitivity: 'base',
    });
}

const PILL_CLASSES = 'rounded-full border px-3 py-1 text-xs font-medium transition-colors';

function CategoryFilter({ categories, value, onChange, t }) {
    // No categorised app in the directory means nothing to filter by — a row
    // with a lone "All" pill is chrome that does nothing.
    if (categories.length === 0) return null;
    return (
        <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t('apps.filter_by_category', 'Filter apps by category')}
        >
            {['all', ...categories].map((key) => {
                const active = key === value;
                const label = key === 'all'
                    ? t('apps.category.all', 'All')
                    : CATEGORY_LABELS[key](t);
                return (
                    <button
                        key={key}
                        type="button"
                        onClick={() => onChange(key)}
                        aria-pressed={active}
                        className={PILL_CLASSES}
                        style={active
                            ? { borderColor: 'var(--accent-primary)', background: 'var(--accent-primary)', color: '#fff' }
                            : { borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

const CARD_CLASSES = 'group relative rounded-xl border p-3.5 transition-all hover:shadow-md text-left block no-underline';
const CARD_STYLE = { borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' };
// Four across on a wide screen (the design's grid), and a single column on a
// phone — the reason /app/apps is on the mobile allow-list at all.
const GRID_CLASSES = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3';
// Exactly two lines of description, reserved whether or not there IS one.
// Without the reserved box a card with a description stands taller than one
// without, every row in the grid ends at a different height, and the footer
// rules below stop lining up across the row.
const DESC_CLASSES = 'h-[34px] overflow-hidden text-[11.5px] leading-[17px] mt-2';

const isPublished = (a) => !!(a?.isPublished ?? a?.is_published);

/**
 * A load failure that carried no message of its own.
 *
 * Kept as a MARKER rather than as ready-made English because `load()` must not
 * depend on `t`: with no TranslationProvider above it (embeds, isolated tests)
 * `useTranslation()` hands back a freshly built `t` on every render, so naming
 * `t` in load()'s dependency list would rebuild `load`, re-fire the effect that
 * calls it, and refetch the directory forever. The banner resolves the marker
 * at render time instead, where a new `t` costs nothing.
 */
const GENERIC_LOAD_ERROR = Symbol('apps.load_failed');

function AppCard({ app, now }) {
    const { t } = useTranslation();
    const category = appCategory(app);
    return (
        <a href={`/app/apps/${app.id}`} className={CARD_CLASSES} style={CARD_STYLE}>
            <div className="flex items-start gap-2.5">
                <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
                    style={accentTile(app.accentColor)}
                >
                    <AppIcon name={app.icon || 'LayoutGrid'} className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0 pt-0.5 flex items-start gap-2">
                    <div className="text-sm font-semibold truncate flex-1 min-w-0" style={{ color: 'var(--text-primary)' }}>
                        {app.name || t('apps.untitled', 'Untitled app')}
                    </div>
                    {isNewlyPublished(app, now) && (
                        <span
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium leading-none mt-0.5"
                            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                        >
                            {t('apps.new_badge', 'new')}
                        </span>
                    )}
                </div>
            </div>
            <div className={DESC_CLASSES} style={{ color: 'var(--text-secondary)' }}>
                {app.description || ''}
            </div>
            {/* The footer is PERMANENT, not a hover reveal: "Open" is the one
                thing every card promises, and a promise that appears only
                under a mouse is invisible on a phone and to a keyboard. */}
            <div
                className="mt-2 pt-2 border-t flex items-center gap-2 text-[11px]"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-tertiary)' }}
            >
                <span className="truncate min-w-0">{category ? CATEGORY_LABELS[category](t) : ''}</span>
                <span className="ml-auto inline-flex items-center gap-0.5 shrink-0 font-medium">
                    {t('apps.open', 'Open')}
                    <ChevronRight className="w-3 h-3" aria-hidden="true" />
                </span>
            </div>
        </a>
    );
}

function ErrorBanner({ message, onRetry }) {
    const { t } = useTranslation();
    // A message the failure carried is shown as-is; it is the server's own
    // words and there is no key to look it up under. Only GENERIC_LOAD_ERROR,
    // the marker for "it broke and said nothing", is ours to translate.
    const text = typeof message === 'string' && message
        ? message
        : t('apps.load_failed', 'Could not load your apps.');
    return (
        <div
            className="shrink-0 px-4 py-2 text-xs flex items-center gap-2"
            // Tokens, not the two hard-coded reds this strip used to carry: a
            // 14% tint of the status colour with the darker -ink for the
            // words, the pairing index.css defines for every status chip.
            style={{
                background: 'color-mix(in srgb, var(--error) 14%, transparent)',
                color: 'var(--error-ink)',
            }}
            role="alert"
        >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {text}
            <button type="button" onClick={onRetry} className="ml-auto underline font-medium">
                {t('apps.retry', 'Retry')}
            </button>
        </div>
    );
}

function SkeletonGrid() {
    const { t } = useTranslation();
    return (
        <div className={GRID_CLASSES} role="status" aria-label={t('apps.loading', 'Loading apps')}>
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`${CARD_CLASSES} animate-pulse`} style={CARD_STYLE}>
                    <div className="flex items-start gap-2.5">
                        <div className="h-8 w-8 rounded-lg" style={{ background: 'var(--bg-secondary)' }} />
                        <div className="flex-1 pt-0.5">
                            <div className="h-3.5 w-2/3 rounded mb-2" style={{ background: 'var(--bg-secondary)' }} />
                            <div className="h-2.5 w-full rounded" style={{ background: 'var(--bg-secondary)' }} />
                        </div>
                    </div>
                </div>
            ))}
            <span className="sr-only">{t('apps.loading_short', 'Loading…')}</span>
        </div>
    );
}

/**
 * The little uppercase rule over a section. It only ever renders when there
 * are TWO sections to tell apart — a lone grid with "All apps" written over it
 * is a label for nothing.
 */
function SectionLabel({ children }) {
    return (
        <h2
            className="text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: 'var(--text-tertiary)' }}
        >
            {children}
        </h2>
    );
}

/**
 * The 48px header: the app-kind mark, the title, how many apps are in the
 * directory, the search box, and — for a reader who may build — the way to
 * the Studio side. `count` is null while there is nothing to count, which is
 * also what hides the search box: a box that can only ever filter zero apps
 * is a control that lies about having something to do.
 */
function Toolbar({ count, query, onQuery, canBuild }) {
    const { t } = useTranslation();
    // Pinned at 48px — the height every screen's header keeps.
    return (
        <div
            data-testid="apps-toolbar"
            className="shrink-0 h-12 px-4 border-b flex items-center gap-3"
            style={{ borderColor: 'var(--border-subtle)' }}
        >
            <div className="flex items-center gap-2 min-w-0">
                {/* The tile is the APP kind's colour, from the one module
                    that owns it — the same mark the Studio rail, the New
                    menu and every reference pill use for an app. */}
                <span style={APP_TILE.tile}>
                    <LayoutGrid style={APP_TILE.glyph} aria-hidden="true" />
                </span>
                <h1 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {t('apps.title', 'Apps')}
                </h1>
                {count !== null && (
                    <span
                        className="hidden sm:inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px]"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                        {nOf(t, 'apps.published_count', count, '{count} published', '{count} published')}
                    </span>
                )}
            </div>

            <div className="ml-auto flex items-center gap-2 min-w-0">
                {count !== null && (
                    <div className="relative min-w-0 flex-1 sm:flex-none sm:w-[230px]">
                        <Search
                            className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            style={{ color: 'var(--text-tertiary)' }}
                            aria-hidden="true"
                        />
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => onQuery(e.target.value)}
                            placeholder={t('apps.search_placeholder', 'Search apps…')}
                            aria-label={t('apps.search_placeholder', 'Search apps…')}
                            className="w-full rounded-lg border pl-7 pr-2 py-1 text-xs outline-none"
                            style={{
                                borderColor: 'var(--border-subtle)',
                                background: 'var(--bg-card)',
                                color: 'var(--text-primary)',
                            }}
                        />
                    </div>
                )}
                {canBuild && (
                    <a
                        href="/app/studio/apps"
                        className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium no-underline whitespace-nowrap"
                        style={{
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--bg-card)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        {t('apps.build_in_studio', 'Build in Studio')}
                    </a>
                )}
            </div>
        </div>
    );
}

/**
 * Everything below the filter row: the recents shortcut, the directory grid,
 * and the footnote under both. Split out of the page so the page reads as
 * "fetch, filter, hand over" and this reads as the layout it is.
 */
function Directory({ recentlyUsed, apps, now, noMatches }) {
    const { t } = useTranslation();
    const hasRecents = recentlyUsed.length > 0;
    return (
        <>
            {hasRecents && (
                <section data-testid="apps-recent" className="mb-5">
                    <div className="mb-2">
                        <SectionLabel>{t('apps.recently_used', 'Recently used')}</SectionLabel>
                    </div>
                    <div className={GRID_CLASSES}>
                        {recentlyUsed.map((app) => (
                            <AppCard key={app.id} app={app} now={now} />
                        ))}
                    </div>
                </section>
            )}
            {/* Every app stays in this grid, recent ones included:
                the shortcut above is a shortcut, not a filter that
                moves an app out of the place you look for it. */}
            <section data-testid="apps-all">
                {(hasRecents || apps.length > 1) && (
                    <div className="mb-2 flex items-baseline gap-3">
                        {hasRecents && (
                            <SectionLabel>{t('apps.all_apps', 'All apps')}</SectionLabel>
                        )}
                        {apps.length > 1 && (
                            <span
                                className="ml-auto text-[10px]"
                                style={{ color: 'var(--text-tertiary)' }}
                            >
                                {t('apps.sorted_by_name', 'Sorted by name')}
                            </span>
                        )}
                    </div>
                )}
                {noMatches ? (
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t('apps.no_matches', 'No apps match your search.')}
                    </p>
                ) : (
                    <div className={GRID_CLASSES}>
                        {apps.map((app) => <AppCard key={app.id} app={app} now={now} />)}
                    </div>
                )}
            </section>
            {/* The footnote. Two sentences a first-time reader
                needs and a returning one never reads again, so it
                sits at the BOTTOM in a dashed box: present, and
                never in the way of the grid. */}
            <p
                className="mt-6 rounded-[9px] border border-dashed px-[14px] py-[11px] text-[11.5px] leading-[17px]"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-tertiary)' }}
            >
                {t(
                    'apps.footnote',
                    'An app is a small tool someone in your organization built in App Studio — a form to fill in, a lookup, a job you would otherwise do by hand. You only see the apps that have been released to your group.',
                )}
            </p>
        </>
    );
}

export default function AppsHomePage() {
    const { t } = useTranslation();
    const [apps, setApps] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [category, setCategory] = useState('all');
    const [query, setQuery] = useState('');

    // The way to the build side, for readers who have it. Same gate as the
    // sidebar's Studio > Apps row (studioApps.jsx: licence × capability) so
    // the button and the nav entry cannot disagree about who may build; both
    // context hooks answer `false` with no provider above them, which is the
    // safe way to be wrong.
    const { hasFeature } = useLicenseContext();
    const { can } = useEntitlements();
    const canBuild = !!(hasFeature?.('app_studio') && can?.('app_studio'));

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [accessible, mine] = await Promise.all([
                studioAppsApi.listAccessible(),
                studioAppsApi.listMine(),
            ]);
            // listAccessible is already published-only server-side; filter
            // defensively. listMine holds drafts too, so keep only published.
            const shared = (accessible?.apps || []).filter(isPublished);
            const ownedPublished = (mine?.apps || []).filter(isPublished);
            // Dedupe by id (an owned app can also appear in accessible).
            const byId = new Map();
            for (const a of [...shared, ...ownedPublished]) {
                if (a?.id && !byId.has(a.id)) byId.set(a.id, a);
            }
            setApps([...byId.values()].sort(byName));
        } catch (err) {
            setError(err?.message || GENERIC_LOAD_ERROR);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Read ONCE per mount. Opening an app leaves this page, so there is nothing
    // to keep in sync while it is on screen — and a stable snapshot means the
    // section cannot reshuffle under the reader's cursor mid-click.
    const [recents] = useState(readAppRecents);
    // One clock reading per load, for the same reason: every "new" badge on
    // the screen should have been decided at the same instant.
    const [now] = useState(() => Date.now());

    // The chips come from the WHOLE directory, not from the search result:
    // a row that reshuffles itself while you type is a row you cannot aim at.
    const presentCategories = useMemo(() => categoriesInView(apps), [apps]);
    // A selection whose category vanished (a reload, an app unpublished) falls
    // back to "All" instead of leaving the reader staring at an empty grid.
    const activeCategory = presentCategories.includes(category) ? category : 'all';
    const visibleApps = useMemo(
        () => visibleUnder(apps, activeCategory).filter((a) => matchesQuery(a, query)),
        [apps, activeCategory, query],
    );
    // Recents are drawn from what the chip and the search box let through:
    // under "Service", a recently used Sales app would contradict the chip the
    // reader just pressed.
    const recentlyUsed = useMemo(
        () => recentApps(visibleApps, RECENTS_SHOWN, recents),
        [visibleApps, recents],
    );
    const isEmpty = !loading && !error && apps.length === 0;
    // A failure is not an answer. With the fetch broken and nothing in hand,
    // the page may not put the directory chrome on anyway: the counted pill,
    // the search box, "Only what you are allowed to use appears here" and the
    // footnote about who sees what are all statements about this reader's
    // ACCESS, and they would be made at the one moment the server said
    // nothing at all. The banner is then the whole page — "we could not ask"
    // has to stay distinguishable from "we asked, and it is empty".
    //
    // A retry that fails while apps are already on screen keeps them: that
    // list was really answered once, and showing it under the banner is
    // stale, not invented.
    const hasDirectory = !loading && apps.length > 0;
    // Nothing left after a search is not the same as an empty directory: the
    // reader typed something, and the answer is about what they typed.
    const noMatches = hasDirectory && visibleApps.length === 0;

    return (
        <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
            <Toolbar
                count={hasDirectory ? apps.length : null}
                query={query}
                onQuery={setQuery}
                canBuild={canBuild}
            />

            {error && <ErrorBanner message={error} onRetry={load} />}

            {hasDirectory && (
                <div className="shrink-0 px-4 pt-3 flex items-center flex-wrap gap-x-3 gap-y-2">
                    <CategoryFilter
                        categories={presentCategories}
                        value={activeCategory}
                        onChange={setCategory}
                        t={t}
                    />
                    {/* Why the directory is short: it is not the org's app
                        list, it is yours. Said here rather than only in the
                        footnote, because "where are the other twelve?" is
                        asked while looking at the grid. */}
                    <span className="ml-auto text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {t('apps.access_hint', 'Only what you are allowed to use appears here')}
                    </span>
                </div>
            )}

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                {loading ? (
                    <SkeletonGrid />
                ) : isEmpty ? (
                    <EmptyState
                        icon={<LayoutGrid className="w-12 h-12" />}
                        title={t('apps.empty_title', 'No apps yet')}
                        description={t(
                            'apps.empty_description',
                            'No apps have been shared with you yet. When someone in your organization publishes an internal tool to you, it will appear here.',
                        )}
                    />
                ) : hasDirectory ? (
                    <Directory recentlyUsed={recentlyUsed} apps={visibleApps} now={now} noMatches={noMatches} />
                ) : null}
            </div>
        </div>
    );
}
