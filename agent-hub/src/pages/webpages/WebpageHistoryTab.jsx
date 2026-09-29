import { ArrowLeft, Eye, RotateCcw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PRIMARY_SLOTS, SLOT_LANGUAGE } from './webpageCodeFiles';
import WebpageEditor from './WebpageEditor';
import { api } from './webpagesApi';
import useConfirm from '../../components/shared/useConfirm';
import useTranslation from '../../hooks/useTranslation';
import { formatRelativeTime } from '../../utils/dateFormatters';

/**
 * De Geschiedenis-tab: wat er met deze pagina gebeurd is, en hoe je terug kunt.
 *
 * ── WAAROM DIT EEN TAB IS EN GEEN MODAL MEER ────────────────────────────────
 *
 * Tot W4 was dit een overlay bovenop de tab waar je stond: de strip wees naar
 * "History" terwijl er in werkelijkheid iets ánders onder lag, en sluiten
 * betekende teruggezet worden op een onthouden vorige tab. Dat is een
 * constructie die alleen bestond omdat de lijst ooit een dialoog was. De
 * geschiedenis is een SECTIE van de pagina, net als Data en Used by, en die
 * hoort zich net zo te gedragen: hij vervangt de body, hij heeft geen
 * focus-val nodig, en Escape betekent er niets bijzonders.
 *
 * ── WAT DIT SCHERM MAG BEWEREN ──────────────────────────────────────────────
 *
 * ONBEKEND IS NIET NUL EN NIET JIJ. Dat is de regel die de server al aanhoudt
 * (routes/webpages.js + core/webpages/versionFacts.js) en die hier NIET mag
 * worden weggepoetst:
 *
 *   - `actor: null` of `actor.name: null` → "Unknown". Nooit "You", nooit een
 *     lege plek waar een naam hoort. Wie het maakte weten we niet, en dat is
 *     iets om te lezen, niet om te verzwijgen.
 *   - `lineDelta: null` → er staat gewoon niets. "±0" zou zeggen dat er niets
 *     veranderde, en dat is een uitspraak die niemand heeft gedaan.
 *   - `seq: null` → geen "v0". Rijen van vóór de kolom dragen geen nummer.
 *
 * ── HET TERUGZETTEN LOOPT VIA DE PAGINA ─────────────────────────────────────
 *
 * Deze tab dóét het terugzetten niet zelf. `onRestore(versionId)` gaat naar
 * WebpageEditorPage, die het enige pad kent dat de editorstand mag verzetten:
 * de POST, dan `acceptServerSnapshot(files)` (her-baselinen vóór de setters),
 * dan setHtml/setCss/setJs. Een tweede kopie van dat pad hier zou de
 * save-discipline achter de rug van de editor om laten vuren.
 */

/**
 * Waar een momentopname vandaan kwam. Dezelfde vier waarden als de
 * `source`-kolom (stores/webpage/versions.VERSION_SOURCES) — een vijfde label
 * verzinnen zou een tweede vocabulaire zijn.
 *
 * 'restore' heet hier bewust "Restore point" en niet "Restore": naast een knop
 * met dat woord zou een chip "Restore" lezen als iets dat je kunt indrukken.
 */
const SOURCE_LABELS = {
    manual: ['webpages.versions.source_manual', 'Manual'],
    ai: ['webpages.versions.source_ai', 'AI'],
    published: ['webpages.versions.source_published', 'Publish'],
    restore: ['webpages.versions.source_restore', 'Restore point'],
};

/** `+12`, `−7`, `±0` — of niets, als er niet gemeten is. */
export function formatLineDelta(lineDelta) {
    if (typeof lineDelta !== 'number' || !Number.isFinite(lineDelta)) return null;
    if (lineDelta === 0) return '±0';
    return lineDelta > 0 ? `+${lineDelta}` : `−${Math.abs(lineDelta)}`;
}

function Chip({ children, tone = 'neutral', testId }) {
    const accent = tone === 'accent';
    return (
        <span
            data-testid={testId}
            className="inline-flex items-center px-1.5 py-[1px] rounded text-[10px] font-medium shrink-0"
            style={accent
                ? { background: 'var(--accent-primary)', color: 'white' }
                : { background: 'var(--bg-secondary)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)' }}
        >
            {children}
        </span>
    );
}

export default function WebpageHistoryTab({ webpageId, onRestore, onLoaded }) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();

    const [versions, setVersions] = useState([]);
    const [hasMore, setHasMore] = useState(false);
    const [published, setPublished] = useState(null);
    // WAT een momentopname van deze pagina dekt. Zonder dit veld kan een lege
    // lijst alleen verklaard worden met "je hebt nog niet genoeg bewerkt", en op
    // het STANDAARD projecttype (react-mui) is dat onwaar: de app woont daar in
    // extra bestanden, en die zitten in geen enkele momentopname.
    const [coverage, setCoverage] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(null);

    // De alleen-lezen weergave van één versie. `null` = de lijst staat vooraan.
    const [viewing, setViewing] = useState(null);
    const [viewSlot, setViewSlot] = useState('html');
    const [viewError, setViewError] = useState(null);

    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // Een ref, zodat het laden niet opnieuw wordt opgebouwd als de ouder een
    // nieuwe callback doorgeeft — anders zou elke render van de ouder een
    // nieuwe fetch uitlokken.
    const onLoadedRef = useRef(onLoaded);
    useEffect(() => { onLoadedRef.current = onLoaded; }, [onLoaded]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await api(`/${webpageId}/versions`);
            if (!mountedRef.current) return;
            const rows = Array.isArray(data.versions) ? data.versions : [];
            setVersions(rows);
            setHasMore(!!data.hasMore);
            setPublished(data.published || null);
            setCoverage(data.coverage || null);
            setError(null);
            onLoadedRef.current?.(rows.length);
        } catch (err) {
            if (mountedRef.current) setError(err.message);
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, [webpageId]);

    useEffect(() => { load(); }, [load]);

    const loadMore = useCallback(async () => {
        if (loadingMore) return;
        setLoadingMore(true);
        try {
            const data = await api(`/${webpageId}/versions?offset=${versions.length}`);
            if (!mountedRef.current) return;
            const rows = Array.isArray(data.versions) ? data.versions : [];
            // De teller van de OUDER wordt NIET vanuit deze updater aangeroepen.
            // Een state-updater draait tijdens de render en hoort zuiver te zijn;
            // React mag hem opnieuw aanroepen, en `onLoaded` is in de echte app
            // een setState van WebpageEditorPage — dat is de gedocumenteerde
            // "Cannot update a component while rendering a different component"-val
            // (met een kale vi.fn() als ouder valt hij niet op).
            setVersions((prev) => [...prev, ...rows]);
            setHasMore(!!data.hasMore);
            onLoadedRef.current?.(versions.length + rows.length);
        } catch (err) {
            if (mountedRef.current) setError(err.message);
        } finally {
            if (mountedRef.current) setLoadingMore(false);
        }
    }, [webpageId, versions.length, loadingMore]);

    const handleView = useCallback(async (version) => {
        setViewError(null);
        setViewSlot('html');
        // Meteen tonen wat we al weten, zodat het scherm niet leeg blijft
        // terwijl de bytes onderweg zijn.
        setViewing({ ...version, files: null });
        try {
            const data = await api(`/${webpageId}/versions/${version.id}`);
            if (!mountedRef.current) return;
            const v = data.version || {};
            // `readable: false` betekent: de rij bestaat, maar zijn bytes zijn uit
            // de opslag verdwenen. Als LEEG bestand tonen zou de kijker niet laten
            // zien of de versie leeg WAS of dat er niets meer is — en Terugzetten
            // op diezelfde rij zou die leegte over de levende pagina schrijven.
            if (v.readable === false) {
                setViewError(t('webpages.versions.unreadable',
                    'This snapshot cannot be read any more, so it cannot be shown or restored.'));
                setViewing({ ...version, ...v, files: null });
                return;
            }
            setViewing({ ...version, ...v, files: { html: v.html || '', css: v.css || '', js: v.js || '' } });
        } catch (err) {
            if (mountedRef.current) setViewError(err.message);
        }
    }, [webpageId, t]);

    const handleRestore = useCallback(async (version) => {
        if (!onRestore) return;
        const label = version.seq
            ? t('webpages.versions.confirm_restore_title_numbered', 'Restore v{seq}?', { seq: version.seq })
            : t('webpages.versions.confirm_restore_title', 'Restore this version?');
        // De belofte moet kloppen. Een momentopname draagt alleen de drie
        // primaire bestanden plus de paginadatabank; extra bestanden blijven op de
        // NIEUWE stand staan. "Je kunt dit terugdraaien" zonder die zin erbij
        // maakt van een half teruggezette pagina een hele.
        const description = coverage && coverage.extraFiles === false && coverage.coversProject === false
            ? t('webpages.versions.confirm_restore_partial',
                'Your current files are saved as a new version first. Only index.html, style.css, script.js and '
                + 'the page database are restored — every other file in this project stays as it is now.')
            : t('webpages.versions.confirm_restore',
                'Your current files are saved as a new version first, so you can undo this.');
        const ok = await confirm({
            title: label,
            description,
            confirmLabel: t('webpages.versions.restore', 'Restore'),
        });
        if (!ok) return;
        try {
            await onRestore(version.id);
            if (!mountedRef.current) return;
            setViewing(null);
            // Terugzetten voegt zelf een rij toe (de stand van vóór de actie),
            // dus de lijst die hier staat is meteen achterhaald.
            await load();
        } catch (err) {
            if (mountedRef.current) setError(err.message);
        }
    }, [confirm, coverage, load, onRestore, t]);

    const publishedLabel = useMemo(() => {
        if (!published) return null;
        return published.seq
            ? t('webpages.versions.published_chip', 'Published: v{seq}', { seq: published.seq })
            : t('webpages.versions.published_chip_unnumbered', 'Published: an earlier version');
    }, [published, t]);

    const actorLabel = useCallback((actor) => {
        // De volgorde is de regel: eerst "ben jij het", dan pas de naam. Een
        // account zonder weergavenaam is nog steeds jij.
        if (actor?.isYou) return t('webpages.versions.actor_you', 'You');
        if (actor?.name) return actor.name;
        return t('webpages.versions.actor_unknown', 'Unknown');
    }, [t]);

    /* ── De alleen-lezen weergave van één versie ───────────────── */
    if (viewing) {
        const files = viewing.files;
        return (
            <div className="h-full flex flex-col" data-testid="webpage-version-view" style={{ background: 'var(--bg-primary)' }}>
                <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <button
                        onClick={() => setViewing(null)}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('webpages.versions.back_to_list', 'Back to history')}
                    </button>
                    <span className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {viewing.seq ? `v${viewing.seq} · ` : ''}{viewing.summary || t('webpages.versions.untitled', 'Snapshot')}
                    </span>
                    <Chip testId="version-view-readonly">{t('webpages.versions.read_only', 'Read-only')}</Chip>
                    <div className="ml-auto flex items-center gap-1">
                        {PRIMARY_SLOTS.map(({ slot, name }) => (
                            <button
                                key={slot}
                                onClick={() => setViewSlot(slot)}
                                aria-pressed={viewSlot === slot}
                                className="px-2 py-1 rounded text-[11px]"
                                style={viewSlot === slot
                                    ? { background: 'var(--bg-secondary)', color: 'var(--text-primary)' }
                                    : { color: 'var(--text-tertiary)' }}
                            >
                                {name}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex-1 min-h-0">
                    {viewError ? (
                        <p className="p-4 text-xs" role="alert" style={{ color: 'var(--text-secondary)' }}>{viewError}</p>
                    ) : !files ? (
                        <p className="p-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('webpages.versions.loading', 'Loading…')}</p>
                    ) : (
                        <WebpageEditor
                            value={files[viewSlot] || ''}
                            language={SLOT_LANGUAGE[viewSlot] || 'plaintext'}
                            readOnly
                        />
                    )}
                </div>
            </div>
        );
    }

    /* ── De lijst ──────────────────────────────────────────────── */
    return (
        <div className="h-full overflow-auto custom-scrollbar px-6 py-5" data-testid="webpage-history" style={{ background: 'var(--bg-primary)' }}>
            <div className="max-w-[720px] flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('webpages.versions.title', 'Version history')}
                    </h3>
                    {publishedLabel && (
                        <Chip tone="accent" testId="published-chip">{publishedLabel}</Chip>
                    )}
                </div>

                {error && (
                    <p className="text-xs" role="alert" style={{ color: 'var(--text-secondary)' }}>{error}</p>
                )}

                {coverage && coverage.coversProject === false && (
                    <p className="text-[11px]" data-testid="history-coverage" style={{ color: 'var(--text-tertiary)' }}>
                        {t('webpages.versions.coverage_partial',
                            'Only index.html, style.css, script.js and the page database are snapshotted. Other files '
                            + 'in this project are not part of a version and are not restored.')}
                    </p>
                )}

                {loading && versions.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('webpages.versions.loading', 'Loading…')}</p>
                ) : versions.length === 0 ? (
                    <p className="text-xs" data-testid="history-empty" style={{ color: 'var(--text-tertiary)' }}>
                        {coverage && coverage.coversProject === false
                            ? t('webpages.versions.empty_not_covered',
                                'Version history only covers index.html, style.css, script.js and the page database. '
                                + 'This project keeps its code in other files, so nothing is snapshotted here.')
                            : t('webpages.versions.empty', 'No versions yet. Auto-snapshots are created every 5 minutes when you edit.')}
                    </p>
                ) : (
                    <div className="flex flex-col gap-2">
                        {versions.map((v) => {
                            // Een bron die deze lijst niet kent krijgt zijn EIGEN
                            // waarde te zien, niet het label van een andere. Stil
                            // terugvallen op "Manual" is geen ontbrekend label maar
                            // een ONWAAR label — op precies het scherm waarvan de kop
                            // zegt dat onbekend nooit als bewering mag verschijnen.
                            const known = SOURCE_LABELS[v.source];
                            const sourceLabel = known ? t(known[0], known[1]) : (v.source || '');
                            const delta = formatLineDelta(v.lineDelta);
                            return (
                                <div
                                    key={v.id}
                                    data-testid="version-row"
                                    className="flex items-center gap-3 p-2.5 rounded-lg border"
                                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            {/* Geen "v0" voor een rij zonder nummer: dan staat er niets. */}
                                            {v.seq ? (
                                                <span data-testid="version-seq" className="text-[11px] font-mono shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                                                    {`v${v.seq}`}
                                                </span>
                                            ) : null}
                                            <span className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                                {v.summary || t('webpages.versions.untitled', 'Snapshot')}
                                            </span>
                                            {sourceLabel ? <Chip testId="version-source">{sourceLabel}</Chip> : null}
                                            {v.isPublished && (
                                                <Chip tone="accent" testId="version-live">
                                                    {t('webpages.versions.is_published', 'Published')}
                                                </Chip>
                                            )}
                                        </div>
                                        <div className="text-[10px] flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-tertiary)' }}>
                                            <span data-testid="version-actor">{actorLabel(v.actor)}</span>
                                            <span aria-hidden="true">·</span>
                                            <span>{formatRelativeTime(v.createdAt)}</span>
                                            <span aria-hidden="true">·</span>
                                            <span>{`${((v.contentLength || 0) / 1024).toFixed(1)}KB`}</span>
                                            {delta && (
                                                <>
                                                    <span aria-hidden="true">·</span>
                                                    <span
                                                        data-testid="version-line-delta"
                                                        title={t('webpages.versions.line_delta_title', 'Net line change in this edit')}
                                                    >
                                                        {delta}
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleView(v)}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border"
                                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                    >
                                        <Eye className="w-3 h-3" aria-hidden="true" />
                                        {t('webpages.versions.view', 'View')}
                                    </button>
                                    {onRestore && (
                                        <button
                                            onClick={() => handleRestore(v)}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium"
                                            style={{ background: 'var(--accent-primary)', color: 'white' }}
                                        >
                                            <RotateCcw className="w-3 h-3" aria-hidden="true" />
                                            {t('webpages.versions.restore', 'Restore')}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                        {hasMore && (
                            <button
                                onClick={loadMore}
                                disabled={loadingMore}
                                className="w-full py-1.5 rounded-lg text-[11px] font-medium border disabled:opacity-50"
                                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                            >
                                {loadingMore ? t('webpages.versions.loading', 'Loading…') : t('webpages.versions.load_more', 'Load more')}
                            </button>
                        )}
                    </div>
                )}
            </div>
            {confirmDialog}
        </div>
    );
}
