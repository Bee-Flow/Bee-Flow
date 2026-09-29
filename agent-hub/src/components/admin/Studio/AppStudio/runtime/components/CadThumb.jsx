import { Box, FileText, Loader2, Maximize2, Minimize2, X } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { authFetch } from '../../../../../../utils/helpers';
import { useDataContext } from '../DataContext';
import { entryHref, entryName } from './AppInputFile';
import Modal from '../../../../../shared/Modal';

/**
 * A row's DRAWING — 3D model or PDF — small enough to sit in a table cell and
 * openable full screen.
 *
 * A filename in a grid tells you which file is attached and nothing about what
 * it IS, so checking whether the right drawing landed on the right line meant
 * opening them one at a time in another tab. Both kinds get the same gesture
 * here: a tile you press, and an overlay you leave with Escape.
 *
 * A CAD filename in a grid tells you which file is attached and nothing about
 * what it IS — so checking whether the right model landed on the right line
 * meant opening them one by one. A picture answers that at a glance, and the
 * server already renders one (core/cad/cadRender.js en dxfRender.js) for exactly this reason.
 *
 * FETCHED THROUGH authFetch, NOT AS AN <img src>. A raw src on the API would
 * bypass the demo-mode transport and would be a cross-origin request inside the
 * Nextcloud embedding — the same reason AppFilePreview builds a blob. One fetch
 * per row, ~19 kB each, and the server caches the render after the first ask.
 */

// Only what this can actually show; anything else keeps the plain cell rather
// than promising a preview it cannot deliver.
// .dxf belongs here for the same reason .step does: the server draws it. It
// was missing while /preview, AppFilePreview and the gallery had all already
// learned about it, so a table full of mailed cut files showed a column of
// dashes — the one view where you most want to see WHICH plate a row is.
const CAD_EXT = /\.(step|stp|p21|iges|igs|dxf)$/i;
const PDF_EXT = /\.pdf$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;

/**
 * What KIND of preview a file gets: "cad" is drawn by the server and comes back
 * as a sheet; a PDF or an image already IS its own preview.
 *
 * Matched on name as well as MIME, because a mailed .step or .pdf routinely
 * arrives as application/octet-stream — and that is exactly the file someone is
 * looking at when they wonder why there is no preview.
 */
function previewKindOf(entry, name) {
    const mime = (entry && entry.mime) || '';
    if (CAD_EXT.test(name) || /^model\/(step|iges)$/i.test(mime) || /^image\/vnd\.dxf$/i.test(mime)) return 'cad';
    if (PDF_EXT.test(name) || mime === 'application/pdf') return 'pdf';
    if (IMG_EXT.test(name) || /^image\/(png|jpeg|gif|webp)$/i.test(mime)) return 'image';
    return null;
}

function descriptorOf(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    let v = value.trim();
    // A `file` column is JSON TEXT on the read path — the same unwrap the AI
    // step's normalizeFileDescriptors does, for the same reason. It also
    // unwraps REPEATEDLY, and so must this: rows written while a connector
    // pre-stringified its descriptors are double-encoded, so the text starts
    // with a quote and the first parse yields another string. Bailing on those
    // showed an em dash where the drawing plainly was — the server half had
    // already learned this lesson; the client had not.
    if (!v.startsWith('{') && !v.startsWith('"')) return null;
    for (let i = 0; i < 3 && typeof v === 'string'; i += 1) {
        try { v = JSON.parse(v); } catch { return null; }
    }
    return v && typeof v === 'object' ? v : null;
}

export default function CadThumb({ value, size = 44 }) {
    const { appId } = useDataContext();
    const entry = descriptorOf(value);
    const name = entry ? entryName(entry) : '';
    const kind = entry ? previewKindOf(entry, name || '') : null;
    const drawable = !!kind;

    const [url, setUrl] = useState(null);
    const [state, setState] = useState('idle');
    const [open, setOpen] = useState(false);
    // 'fit' shows the whole sheet, 'full' shows it at its own pixels and lets
    // you scroll. Fitting is the right first sight — you came to see WHICH
    // part it is — but counting holes on a 5 mm strip needs the real pixels.
    const [zoom, setZoom] = useState('fit');
    const urlRef = useRef(null);

    // `entry` is parsed afresh every render, so the fetch is keyed on the file
    // id and reads the current descriptor through an Effect Event.
    const fileId = entry ? entry.fileId : null;
    const fetchPicture = useEffectEvent(async (isAlive) => {
        setState('loading');
        try {
            const href = entryHref(entry, appId);
            // A .step has no picture of its own, so the server draws one.
            const res = await authFetch(kind === 'cad' ? `${href}/preview` : href);
            if (!res.ok) throw new Error(String(res.status));
            const blob = await res.blob();
            if (!isAlive()) return;
            const u = URL.createObjectURL(blob);
            urlRef.current = u;
            setUrl(u);
            setState('ready');
        } catch {
            // A part the kernel cannot draw is normal, not an error worth
            // shouting about — the cell just stays a quiet placeholder.
            if (isAlive()) setState('failed');
        }
    });
    useEffect(() => {
        if (!drawable || !appId || !fileId) return undefined;
        let alive = true;
        fetchPicture(() => alive);
        return () => {
            alive = false;
            if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
        };
    }, [drawable, appId, fileId]);

    // Escape closes the enlarged view — a lightbox you can only leave with the
    // mouse is a trap on a keyboard.
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') setOpen(false);
            // Space toggles zoom: the hand is already on the keyboard after
            // Escape taught you it responds to one.
            if (e.key === ' ') { e.preventDefault(); setZoom((z) => (z === 'fit' ? 'full' : 'fit')); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    if (!drawable) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
    if (state === 'loading' || state === 'idle') {
        return <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--text-muted)' }} aria-hidden="true" />;
    }
    if (state === 'failed' || !url) {
        return <Box className="h-4 w-4" style={{ color: 'var(--text-muted)' }} aria-label="No 3D preview" />;
    }

    return (
        <>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setZoom('fit'); setOpen(true); }}
                title={`${name} — klik om te vergroten`}
                aria-label={`Bekijk 3D-model van ${name}`}
                className="block overflow-hidden border p-0"
                style={{ width: size, height: size, borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-primary)' }}
            >
                {kind === 'pdf'
                    ? <FileText className="mx-auto h-5 w-5" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    : <img src={url} alt="" className="h-full w-full" style={{ objectFit: 'cover' }} />}
            </button>

            <Modal
                open={open}
                onClose={() => setOpen(false)}
                size="auto"
                variant="bare"
                label={`3D-model van ${name}`}
                className="overflow-hidden"
            >
                <div
                    className="mx-auto flex flex-1 min-h-0 flex-col overflow-hidden"
                    style={{ background: 'var(--bg-card)', borderRadius: 'var(--app-radius)', width: 'min(96vw, 1600px)', height: 'min(92vh, 1400px)' }}
                >
                        <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-2">
                            <span className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{name}</span>
                            <div className="flex shrink-0 items-center gap-1">
                                {kind === 'pdf' ? null : <button
                                    type="button"
                                    onClick={() => setZoom((z) => (z === 'fit' ? 'full' : 'fit'))}
                                    aria-label={zoom === 'fit' ? 'Op ware grootte tonen' : 'Passend maken'}
                                    title={zoom === 'fit' ? 'Op ware grootte (spatie)' : 'Passend maken (spatie)'}
                                    className="p-1"
                                    style={{ color: 'var(--text-secondary)' }}
                                >
                                    {zoom === 'fit'
                                        ? <Maximize2 className="h-4 w-4" aria-hidden="true" />
                                        : <Minimize2 className="h-4 w-4" aria-hidden="true" />}
                                </button>}
                                <button
                                    type="button"
                                    onClick={() => setOpen(false)}
                                    aria-label="Sluiten"
                                    className="p-1"
                                    style={{ color: 'var(--text-secondary)' }}
                                >
                                    <X className="h-4 w-4" aria-hidden="true" />
                                </button>
                            </div>
                        </div>
                        {/* Clicking the sheet itself toggles the zoom — the
                            thing you are looking at is the thing you press. */}
                        {kind === 'pdf' ? (
                            // A PDF brings its own zoom and page controls; a
                            // second set layered on top would only fight them.
                            <iframe title={name} src={url} className="min-h-0 w-full flex-1 border-0" />
                        ) : (
                            <div className={`min-h-0 flex-1 ${zoom === 'fit' ? 'overflow-hidden' : 'overflow-auto'}`}>
                                <img
                                    src={url}
                                    alt={name}
                                    onClick={() => setZoom((z) => (z === 'fit' ? 'full' : 'fit'))}
                                    className={zoom === 'fit' ? 'h-full w-full cursor-zoom-in' : 'max-w-none cursor-zoom-out'}
                                    style={zoom === 'fit' ? { objectFit: 'contain' } : undefined}
                                />
                            </div>
                        )}
                </div>
            </Modal>
        </>
    );
}
