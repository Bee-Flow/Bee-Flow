import { AlertTriangle, ArrowUpCircle, HelpCircle, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { Strip } from '../../../projects/solutionNotices';
import Modal from '../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * Bijwerken naar een nieuwere Blueprint: de banner, het plan, en de bevestiging.
 *
 * Er is niets nieuws aan de serverkant — dit rijdt op de BESTAANDE routes
 * `POST /:id/package/upgrade/plan` en `POST /:id/package/upgrade`. Wat hier
 * bijkomt is het enige wat een gebruiker van een upgrade te zien kreeg: niets.
 *
 * ── Een upgrade is ingrijpend, dus het plan komt vóór de knop ──────────────
 *
 * `planUpgrade` beantwoordt precies de vraag die iemand heeft voordat hij
 * bevestigt: wat gebeurt er met MIJN aanpassingen. De server geeft vier lijsten
 * terug; dit scherm zet ze om in benoemde rijen, en de vertaling daarvan is de
 * hele inhoud van dit bestand:
 *
 *   TOEGEVOEGD   `plan.add`      — dit brengt de update erbij.
 *   GEWIJZIGD    `plan.replace`  — sinds de installatie onaangeroerd, dus de
 *                                  nieuwe versie schrijft eroverheen.
 *   BLIJFT STAAN `plan.skip`     — en hier splitst het, zie hieronder.
 *   WEG          `plan.missing`  — ooit geïnstalleerd, nu verwijderd. Een
 *                                  update wekt dat niet opnieuw op.
 *
 * ── De splitsing in "blijft staan" is het punt ────────────────────────────
 *
 * `plan.skip` heeft twee volstrekt verschillende betekenissen en de server zet
 * ze in dezelfde lijst:
 *
 *   1. WE HEBBEN HET VERGELEKEN EN JIJ HEBT HET AANGEPAST. Alleen mogelijk voor
 *      de vier soorten die de upgrade kan vervangen (COMPARED_KINDS): daarvoor
 *      bestaat een `installHash` en een levende payload om ertegenaan te leggen.
 *   2. WE HEBBEN HET NOOIT VERGELEKEN. Een tabel en een kennisbank hebben geen
 *      payload die de upgrade kan hashen (`currentPayload` geeft er `null` voor),
 *      dus of de installateur er zelf iets aan veranderde is HIER NIET TE
 *      BEPALEN. Zo'n rij als "blijft staan" tonen zonder meer zou beweren dat
 *      we gekeken hebben.
 *
 * Dit scherm claimt geval 1 alleen als BEIDE signalen dat zeggen: de soort is er
 * een die vergeleken kán worden, én de `why` van de server noemt de bewerking.
 * Ontbreekt of verandert een van de twee, dan valt de rij terug op "niet te
 * bepalen" — de kant die te weinig belooft in plaats van te veel.
 *
 * ── Waarom de client het manifest NIET meestuurt ──────────────────────────
 *
 * Beide routes accepteren óf een `blueprintId` óf een heel `manifest`. Dit
 * scherm stuurt uitsluitend het id. Dan draait `resolveManifest` er `canRead`
 * overheen en beslist de SERVER of deze lezer bij die Blueprint mag; een
 * meegestuurd manifest zou langs die controle heen gaan en de bytes van de
 * client tot waarheid maken. De banner controleert de scope óók (zie
 * `updateAvailability`), maar dat is de tweede grendel, niet de eerste.
 */

/**
 * De soorten waarvan de upgrade een "heb jij dit aangepast" kan beantwoorden.
 * Spiegel van REPLACEABLE_KINDS in server/projects/packaging/upgrade.js. Een
 * soort die hier NIET in staat — ook een die er volgend jaar bijkomt — leest als
 * "niet te bepalen", nooit als "onaangeroerd".
 */
export const COMPARED_KINDS = new Set(['automation', 'app', 'webpage', 'agent']);

/** De entiteitenlijsten van een manifest, met de enkelvoudige soortnaam erbij. */
const ENTITY_LISTS = [
    ['automations', 'automation'], ['apps', 'app'], ['webpages', 'webpage'],
    ['datatables', 'datatable'], ['agents', 'agent'], ['knowledgeBases', 'knowledge_base'],
];

/**
 * Is deze Blueprint nieuwer dan wat er staat?
 *
 * Letterlijk de regel van `isNewer` in server/projects/packaging/upgrade.js:
 * gelijke versies zijn GEEN upgrade. Hier herhaald omdat de banner hem vóór de
 * eerste request moet kunnen stellen; `updateAvailability` bewaakt daarbij de
 * val die de serverversie openlaat — `installedVersion || 0` maakt van "we weten
 * niet wat er staat" een 0, en dan is elke v1 ineens nieuwer.
 */
export function isNewer({ installedVersion, blueprintVersion }) {
    return Number.isInteger(blueprintVersion) && blueprintVersion > (installedVersion || 0);
}

/**
 * Mag deze lezer überhaupt iets beloven over een nieuwere versie?
 *
 * DE SCOPE WORDT HIER GECONTROLEERD, VÓÓR DE BANNER IETS ZEGT. De Blueprint
 * wordt opgezocht in `blueprints` — de lijst van GET /package/blueprints, en dat
 * is `listBlueprintsFor`, dus al org-gescoopt door de server. Staat het id daar
 * niet in (verwijderd, of van een andere organisatie), dan is het antwoord
 * `unknown` en NOOIT `available`: een banner die een update belooft voor een
 * Blueprint waar je niet bij mag, verklapt dat hij bestaat.
 *
 * `blueprintId` reist alleen mee als de Blueprint IS gevonden. Zo kan geen
 * enkele aanroeper een plan opvragen voor een id dat hier niet door de scope
 * kwam.
 *
 * Vier toestanden:
 *   none       niet uit een Blueprint geïnstalleerd — er is geen vraag.
 *   unknown    wel, maar niet te beantwoorden. NIET "bijgewerkt".
 *   available  er is een nieuwere, en `latestVersion` noemt hem.
 *   current    vergeleken, en er is niets nieuws.
 */
export function updateAvailability({ installedFromBlueprintId, installedVersion, blueprints } = {}) {
    const id = typeof installedFromBlueprintId === 'string' && installedFromBlueprintId ? installedFromBlueprintId : null;
    if (!id) return { state: 'none', blueprintId: null, installedVersion: null, latestVersion: null };

    const unknown = { state: 'unknown', blueprintId: null, installedVersion: null, latestVersion: null };
    // `null` is "de galerij kon niet gelezen worden" en is dus niet hetzelfde
    // als een lege lijst — maar voor deze vraag is het antwoord in beide
    // gevallen: we weten het niet.
    if (!Array.isArray(blueprints)) return unknown;
    const found = blueprints.find(b => b && b.id === id);
    if (!found) return unknown;

    const latestVersion = Number.isInteger(found.version) && found.version > 0 ? found.version : null;
    // Zonder een gelezen geïnstalleerde versie is er niets om tegen te
    // vergelijken. Dit is de bewaker die de serverfunctie mist.
    const installed = Number.isFinite(installedVersion) ? Math.trunc(installedVersion) : null;
    if (latestVersion === null || installed === null) return unknown;

    return {
        state: isNewer({ installedVersion: installed, blueprintVersion: latestVersion }) ? 'available' : 'current',
        blueprintId: id,
        installedVersion: installed,
        latestVersion,
    };
}

// ── Het plan, in benoemde rijen ────────────────────────────────────────────

/** Ref → leesbare naam, uit het manifest dat het plan meestuurde. */
export function nameIndex(manifest) {
    const index = new Map();
    const entities = manifest?.solution?.entities;
    if (!entities || typeof entities !== 'object') return index;
    for (const [plural] of ENTITY_LISTS) {
        for (const entity of Array.isArray(entities[plural]) ? entities[plural] : []) {
            if (!entity || typeof entity.ref !== 'string' || !entity.ref) continue;
            const name = [entity.name, entity.title, entity.key]
                .find(v => typeof v === 'string' && v.trim());
            index.set(entity.ref, (name || entity.ref).trim());
        }
    }
    return index;
}

/** Eén planrij, met de naam erbij en zonder ook maar iets anders uit de rij. */
function rowOf(item, index) {
    const ref = typeof item?.ref === 'string' ? item.ref : '';
    return { ref, kind: typeof item?.kind === 'string' ? item.kind : '', name: index.get(ref) || ref };
}

/**
 * De vier serverlijsten als vijf benoemde groepen.
 *
 * `undetermined` is de groep die deze functie bestaansrecht geeft: hij bestaat
 * niet op de server, maar wel in de werkelijkheid — zie de kop.
 */
export function planRows(body) {
    const plan = body?.plan || {};
    const index = nameIndex(body?.manifest);
    const list = (v) => (Array.isArray(v) ? v : []);
    const kept = [];
    const undetermined = [];
    for (const item of list(plan.skip)) {
        const row = rowOf(item, index);
        // Twee signalen moeten het eens zijn voordat dit scherm beweert dat er
        // vergeleken IS. Ontbreekt er een, dan is het antwoord "niet bepaald".
        const comparable = COMPARED_KINDS.has(row.kind);
        const saysEdited = typeof item?.why === 'string' && /\bedited\b/i.test(item.why);
        (comparable && saysEdited ? kept : undetermined).push(row);
    }
    return {
        added: list(plan.add).map(i => rowOf(i, index)),
        changed: list(plan.replace).map(i => rowOf(i, index)),
        kept,
        undetermined,
        gone: list(plan.missing).map(i => rowOf(i, index)),
    };
}

/** Verandert dit plan iets? Anders is de bevestiging een lege handeling. */
export function planTouchesNothing(rows) {
    return (rows?.added?.length || 0) === 0 && (rows?.changed?.length || 0) === 0;
}

// ── De twee requests ───────────────────────────────────────────────────────

async function post(url, body) {
    const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    return { ok: res.ok, body: parsed };
}

/**
 * Vraag het plan op. UITSLUITEND met `blueprintId` — zie de kop voor waarom het
 * manifest hier niet in mag.
 */
export async function fetchUpgradePlan({ projectId, blueprintId }) {
    try {
        const { ok, body } = await post(`${API_BASE}/api/projects/${projectId}/package/upgrade/plan`, { blueprintId });
        if (!ok || !body || body.ok !== true) return { status: 'error', error: body?.error || null };
        return { status: 'ok', rows: planRows(body), toVersion: body.toVersion ?? null };
    } catch {
        return { status: 'error', error: null };
    }
}

/** Voer hem uit. Ook hier alleen het id: de server plant zelf opnieuw. */
export async function runUpgrade({ projectId, blueprintId }) {
    try {
        const { ok, body } = await post(`${API_BASE}/api/projects/${projectId}/package/upgrade`, { blueprintId });
        if (!ok || !body || body.ok !== true) return { status: 'error', error: body?.error || null };
        return { status: 'ok', report: readReport(body.report), toVersion: body.toVersion ?? null };
    } catch {
        return { status: 'error', error: null };
    }
}

/** Het rapport, uit een allow-list. Alleen tellingen en de zinnen van de server. */
export function readReport(report) {
    const added = report?.added && typeof report.added === 'object' ? report.added : {};
    const total = Object.values(added).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    const strings = (v) => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s) : []);
    return {
        replaced: Array.isArray(report?.replaced) ? report.replaced.length : 0,
        added: total,
        failed: (Array.isArray(report?.failed) ? report.failed : [])
            .filter(f => f && typeof f === 'object')
            .map(f => ({ ref: typeof f.ref === 'string' ? f.ref : '', why: typeof f.why === 'string' ? f.why : '' })),
        warnings: strings(report?.warnings),
    };
}

// ── De banner ──────────────────────────────────────────────────────────────

/**
 * "Er is een nieuwere versie" — en de eerlijke stilte eromheen.
 *
 * `current` en `none` tonen NIETS: dat is de rustige toestand en de versiechip
 * in de kop zegt al welke versie het is. `unknown` toont wél een regel, want
 * zonder die regel zou de afwezigheid van de banner tegelijk "bijgewerkt" en
 * "we konden het niet nagaan" betekenen — en dat tweede antwoord is precies wat
 * dit product niet afrondt. `unknown` biedt geen knop: er valt niets bij te
 * werken waarvan we niet weten of het er is.
 */
export function UpdateBanner({ availability, onOpen }) {
    const { t } = useTranslation();
    const state = availability?.state;
    if (state !== 'available' && state !== 'unknown') return null;

    if (state === 'unknown') {
        return (
            <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="solution-update-unknown">
                {t('solutions.update_unknown',
                    'Whether there is a newer version of this Solution could not be checked, so this is not "up to date".')}
            </Strip>
        );
    }

    return (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-sm"
             data-testid="solution-update-available"
             style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
            <ArrowUpCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
            <span className="flex-1 min-w-0">
                {t('solutions.update_available', 'Version {version} of the Blueprint this Solution came from is available. You have version {installed}.',
                    { version: availability.latestVersion, installed: availability.installedVersion })}
            </span>
            {/* Geen knop zonder handler: alleen de eigenaar mag bijwerken, en een
                knop die niets doet is erger dan geen knop. De regel zelf blijft
                wél staan — dat er een nieuwere versie is, is ook nieuws voor
                iemand die hem niet zelf kan toepassen. */}
            {onOpen && (
                <button
                    onClick={onOpen}
                    data-testid="solution-update-open"
                    className="flex-shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium border"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    {t('solutions.update_see_plan', 'See what would change')}
                </button>
            )}
        </div>
    );
}

// ── De bevestiging ─────────────────────────────────────────────────────────

/** Eén benoemde groep van het plan. Leeg = niets, geen lege kop. */
function PlanGroup({ rows, title, note, testId }) {
    if (!rows || rows.length === 0) return null;
    return (
        <div data-testid={testId}>
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</h3>
            {note && <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{note}</p>}
            <ul className="mt-1.5 space-y-1">
                {rows.map((row, i) => (
                    <li key={`${row.ref}-${i}`} className="px-3 py-1.5 rounded-lg text-sm"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                        {row.name}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Alle vijf de groepen, in de volgorde waarin iemand ze wil lezen. */
export function PlanBody({ rows }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            <PlanGroup
                rows={rows.changed} testId="upgrade-group-changed"
                title={nOf(t, 'solutions.upgrade_changed', rows.changed.length,
                    '{count} thing is replaced by the new version', '{count} things are replaced by the new version')}
                note={t('solutions.upgrade_changed_note', 'You have not touched these since you installed them.')}
            />
            <PlanGroup
                rows={rows.added} testId="upgrade-group-added"
                title={nOf(t, 'solutions.upgrade_added', rows.added.length,
                    '{count} thing is added', '{count} things are added')}
            />
            <PlanGroup
                rows={rows.kept} testId="upgrade-group-kept"
                title={nOf(t, 'solutions.upgrade_kept', rows.kept.length,
                    '{count} thing you changed stays as it is', '{count} things you changed stay as they are')}
                note={t('solutions.upgrade_kept_note', 'Your version is kept — the update does not write over it.')}
            />
            {/* De groep waar dit scherm om bestaat: hier is NIET vast te stellen
                of de installateur zelf iets veranderde, en dat staat er dus. */}
            <PlanGroup
                rows={rows.undetermined} testId="upgrade-group-undetermined"
                title={nOf(t, 'solutions.upgrade_undetermined', rows.undetermined.length,
                    '{count} thing stays as it is', '{count} things stay as they are')}
                note={t('solutions.upgrade_undetermined_note',
                    'These are left as they are without checking whether you changed them — a table or knowledge base is never rewritten because it holds live data, and anything the update could not read is left alone rather than guessed at. This is not a statement that you did not change them.')}
            />
            <PlanGroup
                rows={rows.gone} testId="upgrade-group-gone"
                title={nOf(t, 'solutions.upgrade_gone', rows.gone.length,
                    '{count} thing you deleted is not brought back', '{count} things you deleted are not brought back')}
                note={t('solutions.upgrade_gone_note', 'These were installed once and are gone now. Deleting them was a decision, so the update leaves them out.')}
            />
        </div>
    );
}

/** Wat er daarna gebeurd is. Tellingen, plus de zinnen die de server meegaf. */
function ReportBody({ report }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-3" data-testid="upgrade-report">
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {t('solutions.upgrade_done', 'Updated. {replaced} replaced, {added} added.',
                    { replaced: report.replaced, added: report.added })}
            </p>
            {report.failed.length > 0 && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="upgrade-report-failed">
                    {t('solutions.upgrade_failed_some', 'Some of it did not go through:')}
                    <span className="block text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                        {report.failed.map(f => f.why).filter(Boolean).join(' · ')}
                    </span>
                </Strip>
            )}
            {report.warnings.map((w, i) => (
                <p key={i} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{w}</p>
            ))}
        </div>
    );
}

/** Wat er in de dialoog staat: het plan, of de reden dat er geen plan is. */
function DialogBody({ plan, ready, empty, result }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            {plan.status === 'loading' && (
                <div className="flex items-center justify-center py-10" style={{ color: 'var(--text-tertiary)' }}>
                    <Loader2 className="w-5 h-5 animate-spin" />
                </div>
            )}

            {/* Geen plan = geen knop. Er is niets bekend om te bevestigen. */}
            {plan.status === 'error' && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="upgrade-plan-unreadable">
                    {t('solutions.upgrade_plan_unreadable',
                        'What this update would change could not be worked out, so nothing has been applied.')}
                </Strip>
            )}

            {ready && empty && (
                <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="upgrade-plan-empty">
                    {t('solutions.upgrade_nothing', 'This update would not change or add anything here.')}
                </Strip>
            )}

            {ready && <PlanBody rows={plan.rows} />}

            {result?.status === 'error' && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="upgrade-apply-failed">
                    {t('solutions.upgrade_apply_failed', 'The update did not go through. Nothing that was already replaced is undone — try again, and read the plan first.')}
                </Strip>
            )}
            {result?.status === 'ok' && <ReportBody report={result.report} />}
        </div>
    );
}

/**
 * De voet. Bevestigen kan ALLEEN als er een plan gelezen is dat ook echt iets
 * verandert; in elke andere toestand staat er alleen een uitweg.
 */
function DialogFooter({ done, canConfirm, applying, onClose, onConfirm }) {
    const { t } = useTranslation();
    return (
        <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 h-8 rounded-lg text-[13px] border"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                {done ? t('solutions.upgrade_close', 'Close') : t('solutions.upgrade_cancel', 'Cancel')}
            </button>
            {canConfirm && (
                <button onClick={onConfirm} disabled={applying} data-testid="upgrade-confirm"
                        className="px-3 h-8 rounded-lg text-[13px] font-medium disabled:opacity-50"
                        style={PRIMARY_ACTION_STYLE}>
                    {t('solutions.upgrade_confirm', 'Update it')}
                </button>
            )}
        </div>
    );
}

/**
 * Het plan, en pas daarna de knop.
 *
 * De bevestiging is ALLEEN bereikbaar vanuit een gelezen plan. Een mislukt plan
 * geeft geen "toch doorgaan": dan is er niets bekend over wat er zou gebeuren,
 * en dat is de ene toestand waarin deze handeling niet aangeboden hoort te
 * worden.
 */
export default function UpgradeDialog({ open, onClose, projectId, blueprintId, latestVersion = null, onDone }) {
    const { t } = useTranslation();
    const [plan, setPlan] = useState({ status: 'loading' });
    const [applying, setApplying] = useState(false);
    const [result, setResult] = useState(null);

    const load = useCallback(async () => {
        setPlan({ status: 'loading' });
        setResult(null);
        setPlan(await fetchUpgradePlan({ projectId, blueprintId }));
    }, [projectId, blueprintId]);

    // De dialoog blijft gemonteerd terwijl hij dicht is, dus het plan van de
    // vorige keer staat er nog. Openen MOET dat wissen — een oud plan naast een
    // nieuwe knop is precies de vergissing die dit scherm moet voorkomen. Zelfde
    // uitzondering, en om dezelfde reden, als de naam-draft in SolutionDetail.
    useEffect(() => {
        if (!open || !projectId || !blueprintId) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        load();
    }, [open, projectId, blueprintId, load]);

    const confirm = async () => {
        setApplying(true);
        const outcome = await runUpgrade({ projectId, blueprintId });
        setApplying(false);
        setResult(outcome);
        if (outcome.status === 'ok') onDone?.();
    };

    const ready = plan.status === 'ok' && !result;
    const empty = ready && planTouchesNothing(plan.rows);

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="lg"
            disableBackdropClose
            title={t('solutions.upgrade_title', 'Update this Solution')}
            description={latestVersion === null ? undefined
                : t('solutions.upgrade_intro', 'To version {version} of the Blueprint it came from.', { version: latestVersion })}
            footer={<DialogFooter done={result?.status === 'ok'} canConfirm={ready && !empty}
                                   applying={applying} onClose={onClose} onConfirm={confirm} />}
        >
            <DialogBody plan={plan} ready={ready} empty={empty} result={result} />
        </Modal>
    );
}
