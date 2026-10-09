import { File, FileImage, FileSpreadsheet, FileText, PencilRuler, Presentation } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { authFetch } from '../../../../../../utils/helpers';
import { useDataContext } from '../DataContext';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill } from '../styleResolver';
import { EmptyText, ErrorText, Skeleton } from '../uiBits';
import { firstDescriptor } from './AppFilePreview';
import { entryHref, entryIsImage } from './AppInputFile';

/**
 * App Studio runtime — 'file_gallery'. Spec: server/appStudio/componentSpecs.js.
 *
 * Attachments as cards instead of as a list of blue filenames. Every app with a
 * `file` column was building this by hand out of a `list`, which meant no type
 * icon, no size, and no way to tell a drawing from a signature image without
 * opening both.
 *
 * THUMBNAILS, BUT ONLY WHERE THEY ARE CHEAP. The rule that matters is not
 * "never fetch" — it is "never redeem". A PENDING mailbox attachment is a
 * pointer at the provider, and redeeming one costs a provider round-trip, so a
 * grid of twelve cards would fire twelve of them on mount for thumbnails
 * nobody asked for. Those still get a type icon and nothing else.
 *
 * A STORED image is a different thing entirely: its bytes are already in this
 * app's own attachment store, one authFetch away, behind the same read access
 * as the preview. Withholding a picture from those was the reason a
 * werkvoorbereider looking at seven photos of a meter cupboard saw seven
 * identical grey file icons and had to open each one to find out which was
 * which. So stored images get a real thumbnail, capped, and file_preview
 * (wired via onRowClick) still shows the one somebody chose to look at.
 */

// Enough cards to recognise a set of photos at a glance; past this the page is
// the problem, not the thumbnails.
const MAX_THUMBS = 12;

const ICON_BY_KIND = [
    // CAD before the image rule: image/vnd.dxf and image/vnd.dwg are drawings,
    // not pictures, and a photo icon on a cutting file is a small lie.
    [/^(model\/|image\/vnd\.(dxf|dwg))/i, PencilRuler],
    [/^image\//i, FileImage],
    [/pdf/i, FileText],
    [/(sheet|excel|csv)/i, FileSpreadsheet],
    [/(presentation|powerpoint)/i, Presentation],
    [/(word|document|text|rtf)/i, FileText],
];

export function iconForMime(mime) {
    const s = String(mime || '');
    for (const [re, Icon] of ICON_BY_KIND) if (re.test(s)) return Icon;
    return File;
}

/** Human file size; a missing or nonsense value renders nothing at all. */
export function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const units = ['B', 'kB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Blob URLs for the stored images among these rows.
 *
 * Keyed by fileId, so a re-render that hands back an equal-but-new descriptor
 * object does not refetch. Every URL created here is revoked on unmount —
 * a gallery that leaked them would hold whole photographs in memory for as
 * long as the tab lived.
 */
function useThumbnails(rows, fileKey, appId, live) {
    const [urls, setUrls] = useState({});
    const madeRef = useRef(new Map());

    // A stable identity for "which files am I showing" — the effect must not
    // re-run because the rows array is new on every render.
    const ids = rows
        .map((row) => {
            const d = firstDescriptor(row?.[fileKey]);
            // `entryIsImage` is false for a pending mailbox pointer (no mime
            // yet), which is exactly the case we must not redeem.
            return d && typeof d === 'object' && d.fileId && entryIsImage(d) ? d.fileId : null;
        })
        .filter(Boolean)
        .slice(0, MAX_THUMBS);
    const idKey = ids.join(',');

    useEffect(() => {
        if (!live || !idKey) return undefined;
        let alive = true;
        (async () => {
            for (const fileId of idKey.split(',')) {
                if (!alive) return;
                if (madeRef.current.has(fileId)) continue;
                try {
                    const res = await authFetch(entryHref({ fileId }, appId));
                    if (!res.ok) continue;          // a thumbnail is never worth an error state
                    const url = URL.createObjectURL(await res.blob());
                    if (!alive) { URL.revokeObjectURL(url); return; }
                    madeRef.current.set(fileId, url);
                    setUrls((prev) => ({ ...prev, [fileId]: url }));
                } catch { /* icon is a fine fallback */ }
            }
        })();
        return () => { alive = false; };
    }, [idKey, appId, live]);

    useEffect(() => () => {
        for (const url of madeRef.current.values()) URL.revokeObjectURL(url);
        madeRef.current.clear();
    }, []);

    return urls;
}

export default function AppFileGallery({ node }) {
    const { t } = useTranslation();
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const { appId } = useDataContext();
    const {
        fileKey = 'file',
        titleKey = 'filename',
        subtitleKey = null,
        sizeKey = null,
        groupKey = null,
        columns = 3,
        rowLimit = 24,
        emptyText = t('studio_apps_runtime.file_gallery.empty', 'No files yet.'),
    } = node.props || {};
    const { value, isLoading, error, errorCode } = resolveBinding(node.props?.source, { actionState, dataState, scope });

    // Computed BEFORE the loading/error returns below: useThumbnails is a hook,
    // and a hook behind a conditional return is a hook that runs on some
    // renders and not others.
    const rows = (Array.isArray(value) ? value : []).slice(0, rowLimit);
    // Editing must never fetch — the canvas re-renders on every keystroke.
    const thumbs = useThumbnails(rows, fileKey, appId, mode === 'run' && !!appId);

    // isFill takes the NODE — passing the height string meant this was always
    // false, so the height knob the inspector offers did nothing at all.
    const fill = isFill(node);
    // min-h-0 is what lets a flex child actually scroll rather than growing
    // past its pane; app-fill is the class the fill contract is checked on.
    const wrapper = `w-full min-w-0${fill ? ' app-fill h-full min-h-0 overflow-auto' : ''}`;

    if (error) return <ErrorText error={error} errorCode={errorCode} />;
    if (isLoading) {
        return (
            <div className={wrapper}>
                <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                    {Array.from({ length: Math.min(columns * 2, 6) }, (_, i) => (
                        <Skeleton key={i} className="h-16 w-full" />
                    ))}
                </div>
            </div>
        );
    }

    if (rows.length === 0) return <EmptyText art="no-files" title={t('studio_apps_runtime.file_gallery.no_files', 'No files here')} text={emptyText} />;

    const clickable = mode === 'run' && !!node.onRowClick;

    const gridStyle = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };

    /**
     * One card. Extracted so the grouped and ungrouped branches below draw the
     * SAME card — two copies of this JSX is two cards that drift apart.
     */
    const renderCard = (row, i) => {
        const descriptor = firstDescriptor(row?.[fileKey]);
        const mime = (descriptor && typeof descriptor === 'object' ? descriptor.mimeType || descriptor.type : null)
            || (subtitleKey ? row?.[subtitleKey] : null)
            || row?.mime_type;
        const Icon = iconForMime(mime);
        const name = row?.[titleKey]
            || (descriptor && typeof descriptor === 'object' ? descriptor.name : null)
            || t('studio_apps_runtime.file_gallery.file', 'File');
        const size = formatBytes(sizeKey ? row?.[sizeKey] : row?.size);
        // No subtitleKey means NO subtitle — which is what the spec has always
        // said its default of null means. The mime type used to stand in, and it
        // was never worth the line: the icon already says what kind of file this
        // is, and half a mailbox's attachments arrive as
        // "application/octet-stream" — a string that says nothing, truncates the
        // filename next to it, and repeats identically down the whole column.
        const meta = [subtitleKey ? row?.[subtitleKey] : null, size].filter(Boolean).join(' · ');

        const thumb = descriptor && typeof descriptor === 'object' ? thumbs[descriptor.fileId] : null;

        const card = (
            <>
                {thumb ? (
                    // Big enough to tell a closed cupboard door from a row of
                    // breakers, which is the whole job of this card; the full
                    // picture is one click away.
                    <img
                        src={thumb}
                        alt=""
                        aria-hidden="true"
                        loading="lazy"
                        className="shrink-0 rounded object-cover"
                        style={{ width: 56, height: 56, background: 'var(--bg-secondary)' }}
                    />
                ) : (
                    <span className="app-file-card-icon shrink-0" aria-hidden="true">
                        <Icon className="w-5 h-5" />
                    </span>
                )}
                <span className="min-w-0 text-left">
                    <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {name}
                    </span>
                    {meta ? (
                        <span className="block text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
                            {meta}
                        </span>
                    ) : null}
                </span>
            </>
        );

        return clickable ? (
            <button
                key={row?.id || i}
                type="button"
                onClick={() => runAction(node.onRowClick, { formValues: row, item: row })}
                className="app-file-card flex items-center gap-2.5 rounded-lg border p-2.5 text-left min-w-0"
                title={name}
            >
                {card}
            </button>
        ) : (
            <div
                key={row?.id || i}
                className="app-file-card flex items-center gap-2.5 rounded-lg border p-2.5 min-w-0"
                title={name}
            >
                {card}
            </div>
        );
    };

    // ── Grouped, or not ────────────────────────────────────────────────────
    // Without a groupKey this is byte-for-byte the single grid it always was.
    if (!groupKey) {
        return (
            <div className={wrapper} data-app-file-gallery="true">
                <div className="grid gap-2" style={gridStyle}>{rows.map(renderCard)}</div>
            </div>
        );
    }

    // An unpacked order archive is one folder per article beside a folder of
    // labels. As 243 loose cards that is a pile you scroll past; under their
    // folder names it is a list of parts. Groups keep the order in which they
    // first appear, so the sort the author chose still decides.
    const loose = [];
    const groups = new Map();
    rows.forEach((row, i) => {
        const raw = row?.[groupKey];
        const name = typeof raw === 'string' ? raw.trim() : (raw == null ? '' : String(raw));
        if (!name) { loose.push([row, i]); return; }
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push([row, i]);
    });

    return (
        <div className={wrapper} data-app-file-gallery="true">
            {loose.length ? (
                <div className="grid gap-2" style={gridStyle}>{loose.map(([row, i]) => renderCard(row, i))}</div>
            ) : null}
            {[...groups].map(([name, entries]) => (
                <section key={name} className="mt-3 first:mt-0" data-app-file-group={name}>
                    <h4
                        className="mb-1.5 flex items-baseline gap-1.5 text-xs font-semibold"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        <span className="truncate" title={name}>{name}</span>
                        <span className="tabular-nums font-normal" style={{ color: 'var(--text-tertiary)' }}>
                            {entries.length}
                        </span>
                    </h4>
                    <div className="grid gap-2" style={gridStyle}>{entries.map(([row, i]) => renderCard(row, i))}</div>
                </section>
            ))}
        </div>
    );
}
