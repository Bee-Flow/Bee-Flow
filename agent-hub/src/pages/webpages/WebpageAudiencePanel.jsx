import {
    Building2, Check, Copy, Globe, Loader2, Lock, RefreshCw,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Chip } from './WebpageDataCards';
import AudienceRows from '../../components/shared/AudienceRows';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * "Wie ziet de pagina, en het adres" — de vierde kolom van Data & koppelingen.
 *
 * Drie rijen komen van het gedeelde `AudienceRows` (Persoonlijk / Hele
 * organisatie / Groepen) en schrijven, net als overal elders, naar
 * `PATCH /api/webpages/:id/publish`. De VIERDE rij is van een andere soort en
 * moet dat op het scherm ook zijn.
 *
 * ── WAAROM "OPENBAAR" GEEN VIERDE KEUZERONDJE IS ────────────────────
 *
 * De eerste drie sluiten elkaar uit: een pagina is persoonlijk óf van de
 * organisatie óf van groepen. "Openbaar" ligt daar overheen — een pagina kan
 * persoonlijk zijn én een openbaar adres hebben — dus het is een schakelaar
 * naast de drie, niet een vierde optie ertussen. Zou het een vierde rondje
 * zijn, dan zou aanklikken van "Persoonlijk" stilzwijgend een openbare link
 * intrekken, en dat is precies het soort verrassing dat een deelscherm hoort
 * te voorkomen.
 *
 * ── EN WAAROM ER EEN TUSSENSTAP IN ZIT ──────────────────────────────
 *
 * Openbaar zetten is het moment waarop iemand kiest WELKE KOLOMMEN van de
 * gebonden tabellen naar buiten mogen. Die vraag wordt gesteld, niet geraden:
 * op een pagina die nog nooit openbaar was staat er niets aangevinkt, en wat
 * niet is aangevinkt gaat niet naar buiten (de server zet elke tabel die in
 * het antwoord ontbreekt op nul kolommen — `applyColumnChoice`). Vandaar dat
 * de schakelaar bij tabelbindingen eerst een kolomkeuze opent en pas daarna
 * publiceert.
 *
 * ── VIER DINGEN DIE DIT SCHERM UITSPREEKT ───────────────────────────
 *
 *   1. een publieke pagina is een MOMENTOPNAME, geen levende pagina;
 *   2. tabelblokken zijn daar ALLEEN-LEZEN — `readwrite` bestaat alleen voor
 *      Persoonlijk, Organisatie en Groepen;
 *   3. het Agent-blok draait er NIET (`ai.ask` is bewust uit de anonieme
 *      bridge gehouden). Dit is de "Openbaar"-rij die WebpageActionsPanel
 *      aankondigde toen hij zei dat die zin hier herhaald hoort te worden.
 *   4. maar de KALE AI-CHAT draait er wél als hij aanstaat. Met
 *      `bridge_grants.ai.publicEnabled` zet de server een echte beeflowAI-brug
 *      in het publieke document, en chat een anonieme bezoeker op het
 *      LLM-budget van de auteur (met `publicGroundOnPage` gegrond op de kennis
 *      van de pagina). De eerste drie zijn CONSTANTEN, deze is een SCHAKELAAR
 *      — en er is nergens anders in de editor een scherm dat hem toont, dus
 *      zwijgen laat regel 2 en 3 lezen als "publiek draait er geen AI".
 *      Zetten kan alleen de AI-chat van de pagina zelf: er is geen REST-route
 *      voor, dus deze rij TOONT hem en biedt geen knop die niet bestaat.
 *
 * Het ADRES staat in een eigen kaart eronder: `/w/<slug>`, met "Alle opties"
 * (wachtwoord, e-mailadressen, vervaldatum) eronder ingeklapt en de footer
 * "Onderdeel van oplossing" uit `project_id`. Het adres blijft bestaan als
 * openbaar uit gaat — daarom staat er "the address stays" bij en niet "the
 * link is gone".
 *
 * ── EN WAAROM "OFF" NIET HETZELFDE IS ALS "DICHT" ───────────────────
 *
 * Openbaar uitzetten raakt alleen het adres: de server trekt de canonieke
 * share in en laat elke LOSSE /share/<token> van dezelfde pagina staan. Die
 * blijft de bevroren snapshot serveren, tabelrijen incluis. Het scherm zegt
 * dat dan hardop (`otherLinksNotice`) — anders leest de eigenaar "Off" en
 * "Not serving" over een pagina die anoniem bereikbaar is, en dat is de
 * gevaarlijke richting die deze kolom juist moet uitsluiten.
 */

const AUDIENCE_URL = (id) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/audience`;
const PUBLIC_URL = (id) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/audience/public`;

async function readJson(res) {
    try { return await res.json(); } catch { return null; }
}

/**
 * De kolomkeuze waarmee het formulier OPENT.
 *
 * Al openbaar → de huidige stand, want dat is een feit en geen aanname.
 * Nog niet openbaar → leeg, voor elke tabel. Vooraf aanvinken zou van de vraag
 * "welke kolommen mogen naar buiten" een "akkoord" maken dat niemand las.
 * Puur en geëxporteerd, want dit is de enige plek waar die regel woont.
 */
export function initialColumnChoice(columnGate, isPublic) {
    const out = {};
    for (const t of (columnGate?.tables || [])) {
        out[t.datatableId] = isPublic && Array.isArray(t.publicColumns) ? [...t.publicColumns] : [];
    }
    return out;
}

/** Hoeveel kolommen er in totaal naar buiten zouden gaan met deze keuze. */
export function countChosenColumns(choice) {
    return Object.values(choice || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

/**
 * Hoeveel kolommen er VANDAAG naar buiten gaan, volgens de server.
 *
 * Bewust kolommen en geen tabellen: "1 van 1 gebonden tabellen" is geen zin, en
 * bovendien is het aantal KOLOMMEN het getal waar het om gaat — dat is wat er
 * op de openbare pagina staat.
 */
export function countPublicColumns(columnGate) {
    return (columnGate?.tables || []).reduce(
        (n, t) => n + (Array.isArray(t.publicColumns) ? t.publicColumns.length : 0), 0);
}

/**
 * Welke zin er onder het adres hoort over de ANDERE externe links.
 *
 * "Openbaar uit" zegt alleen iets over het ADRES. De server trekt bij
 * `{on:false}` uitsluitend de CANONIEKE share in; een losse /share/<token> van
 * dezelfde pagina blijft daarna gewoon de bevroren snapshot serveren, mét de
 * gerenderde tabelrijen. Zwijgt dit scherm daarover, dan leest de eigenaar
 * "Off" en "Not serving" over een pagina die anoniem bereikbaar is — precies de
 * richting die de vierde rij moet uitsluiten.
 *
 * Vier standen:
 *   'while_on'  openbaar AAN met meer dan één link: één ervan IS het adres,
 *               de rest staat ernaast;
 *   'while_off' openbaar UIT en er staat er nog minstens één open: geen enkele
 *               daarvan is het adres, en ze serveren door;
 *   'unknown'   openbaar UIT maar de sharelijst was onleesbaar. Dan wordt er
 *               niets beweerd — 0 uit een mislukte lezing is geen "leeg", en
 *               juist hier zou dat de waarschuwing laten verdwijnen;
 *   'none'      er valt niets te melden.
 *
 * Bij een ONBEKENDE openbaar-stand (`public.known === false`) zwijgt deze zin:
 * de rij hierboven zegt dan al dat de stand niet te lezen was, en "Openbaar is
 * uit, maar…" zou daar een bewering aan toevoegen die niemand kan waarmaken.
 */
export function otherLinksNotice(model) {
    const known = model?.public?.known !== false;
    const on = !!model?.public?.on;
    const count = Number(model?.shareCount) || 0;
    if (on) return count > 1 ? 'while_on' : 'none';
    if (!known) return 'none';
    if (model?.shareCountKnown === false) return 'unknown';
    return count > 0 ? 'while_off' : 'none';
}

/**
 * De publieke AI-brug, driewaardig — de derde eigenschap van het publieke
 * oppervlak en de enige die een SCHAKELAAR is.
 *
 * `aiKnown !== true` betekent NIET GELEZEN, niet "uit": zou dat als uit tellen,
 * dan beweert het scherm "publiek draait er geen AI" op een veld dat niemand
 * bekeek — dezelfde gevaarlijke richting die `public.known` hierboven uitsluit.
 * Daarom hangt `runs` aan `known` en `grounds` aan `runs`: elke bewering hier
 * staat op de lezing eronder.
 */
export function publicAiState(model) {
    const known = model?.public?.aiKnown === true;
    const runs = known && model?.public?.aiRuns === true;
    return { known, runs, grounds: runs && model?.public?.aiGroundsOnPage === true };
}

/**
 * De regels die de publieke AI uitspreken. Apart gehouden omdat het er drie
 * zijn — de stand, de grondslag en waar de schakelaar wél zit — en omdat de
 * vierde rij anders een muur van ternaries wordt.
 */
function PublicAiNotes({ t, ai }) {
    const warn = { color: 'var(--warning)' };
    return (
        <>
            <li data-testid="public-ai" style={ai.known && !ai.runs ? undefined : warn}>
                {!ai.known
                    ? t('webpages.audience.public_ai_unknown',
                        'Whether outside readers can use the AI on this page could not be read, so nothing is claimed about it here.')
                    : ai.runs
                        ? t('webpages.audience.public_ai_on',
                            'Anyone with the address can chat with the AI on this page, and every answer is charged to your AI budget.')
                        : t('webpages.audience.public_ai_off',
                            'Outside readers cannot use the AI on this page, so a public reader can never spend your AI budget.')}
            </li>
            {ai.grounds && (
                <li data-testid="public-ai-grounded" style={warn}>
                    {t('webpages.audience.public_ai_grounded',
                        'Those answers are grounded on this page\'s knowledge, so its sources can reach outside readers without passing the column choice above.')}
                </li>
            )}
            {ai.runs && (
                <li data-testid="public-ai-change">
                    {t('webpages.audience.public_ai_change',
                        'This switch is not on this screen: ask this page\'s AI chat to turn public AI off.')}
                </li>
            )}
        </>
    );
}

// ── de vierde rij ────────────────────────────────────────────────────

function PublicRow({ t, model, busy, onOpen, onTurnOff, disabled }) {
    const on = !!model?.public?.on;
    // Driewaardig, net als `agent.known` in de kolom hiernaast: kon de share
    // niet gelezen worden, dan is "Off" een bewering over blootstelling die we
    // niet kunnen waarmaken. Dan zegt de rij dat, en er valt niets te
    // schakelen — aan- of uitzetten op een onbekende stand is erger dan
    // wachten.
    const known = model?.public?.known !== false;
    const ai = publicAiState(model);
    return (
        <Card tone={known ? 'default' : 'warning'}>
            <div className="flex items-center gap-2 flex-wrap">
                <Globe size={14} style={{ color: 'var(--kind-web)' }} />
                <span className="text-sm font-medium">{t('webpages.visibility.public', 'Public')}</span>
                {!known
                    ? <Chip label={t('webpages.audience.public_unknown', 'Could not be checked')} tone="muted" dashed />
                    : on
                        ? <Chip label={t('webpages.audience.public_on', 'Anyone with the address')} tone="public" />
                        : <Chip label={t('common.off', 'Off')} tone="muted" dashed />}
                <span className="flex-1" />
                {known && on && (
                    <button
                        type="button"
                        data-testid="public-columns"
                        disabled={disabled || busy}
                        onClick={onOpen}
                        className="text-xs underline disabled:opacity-50"
                    >
                        {t('webpages.audience.change_columns', 'Change what goes out')}
                    </button>
                )}
                {known && (
                    <button
                        type="button"
                        data-testid="public-toggle"
                        disabled={disabled || busy}
                        onClick={on ? onTurnOff : onOpen}
                        className="text-xs underline disabled:opacity-50 inline-flex items-center gap-1"
                    >
                        {busy && <Loader2 size={12} className="animate-spin" />}
                        {on
                            ? t('webpages.audience.turn_off', 'Turn off')
                            : t('webpages.audience.turn_on', 'Make public')}
                    </button>
                )}
            </div>
            {!known && (
                <p className="text-sm">
                    {t('webpages.audience.public_unknown_body',
                        'Whether this page is public right now could not be read, so nothing is claimed here and nothing can be changed until it can.')}
                </p>
            )}
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.audience.public_body',
                    'A public page is a snapshot without scripts, not the live page. It updates when you save, and when a table it shows changes.')}
            </p>
            <ul className="text-[11px] list-disc pl-4" style={{ color: 'var(--text-secondary)' }}>
                <li>{t('webpages.audience.public_tables_read_only',
                    'Table blocks are read-only here. Writing back to a table is only possible for Personal, Entire organisation and Groups.')}</li>
                {/* De staart van deze zin ("blijft leeg") is precies ONWAAR
                    zodra de publieke AI aanstaat: het Agent-blok draait er
                    inderdaad niet, maar de kale chat antwoordt wel. Daarom
                    staat de ternary om de SLEUTEL heen en niet om een halve
                    zin. */}
                <li>{ai.runs
                    ? t('webpages.audience.public_agent_never_ai_on',
                        'An agent block never runs on a public share. The plain AI chat below is a different thing, and it does answer outside readers.')
                    : t('webpages.audience.public_agent_never',
                        'An agent block never runs on a public share, so a chat block on this page stays blank for outside readers.')}</li>
                {/* De derde eigenschap: de enige die geld kost, en de enige die
                    een anonieme bezoeker een levend kanaal geeft. */}
                <PublicAiNotes t={t} ai={ai} />
            </ul>
        </Card>
    );
}

// ── de kolompoort ────────────────────────────────────────────────────

function ColumnGateForm({ t, columnGate, choice, setChoice, onConfirm, onCancel, busy }) {
    const tables = columnGate?.tables || [];
    const toggle = (tableId, key) => {
        setChoice(prev => {
            const cur = Array.isArray(prev[tableId]) ? prev[tableId] : [];
            const next = cur.includes(key) ? cur.filter(c => c !== key) : [...cur, key];
            return { ...prev, [tableId]: next };
        });
    };
    const chosen = countChosenColumns(choice);
    return (
        <Card tone="warning">
            <div className="text-sm font-medium">
                {t('webpages.audience.gate_title', 'What may leave this page?')}
            </div>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.audience.gate_body',
                    'Tick the columns that may appear on the public page. Anything you leave unticked stays inside — there is no "everything" here on purpose.')}
            </p>
            {tables.map(tb => (
                <div key={tb.datatableId} className="flex flex-col gap-1" data-testid={`gate-table-${tb.datatableId}`}>
                    <div className="text-[11px] font-medium">{tb.label || tb.datatableId}</div>
                    <div className="flex flex-wrap gap-2">
                        {(tb.columns || []).length === 0 && (
                            <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                {t('webpages.audience.gate_no_columns', 'This binding reads no columns, so nothing can go out.')}
                            </span>
                        )}
                        {(tb.columns || []).map(key => {
                            const ticked = (choice[tb.datatableId] || []).includes(key);
                            return (
                                <label key={key} className="inline-flex items-center gap-1 text-[11px] cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={ticked}
                                        onChange={() => toggle(tb.datatableId, key)}
                                        aria-label={key}
                                    />
                                    {key}
                                </label>
                            );
                        })}
                    </div>
                </div>
            ))}
            <div className="flex items-center gap-3 pt-1">
                <button
                    type="button"
                    data-testid="gate-confirm"
                    disabled={busy}
                    onClick={onConfirm}
                    className="text-xs underline disabled:opacity-50 inline-flex items-center gap-1"
                >
                    {busy && <Loader2 size={12} className="animate-spin" />}
                    {t('webpages.audience.gate_confirm', 'Make public')}
                </button>
                <button type="button" onClick={onCancel} disabled={busy} className="text-xs underline disabled:opacity-50">
                    {t('common.cancel', 'Cancel')}
                </button>
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {chosen === 0
                        ? t('webpages.audience.gate_none_chosen', 'Nothing from your tables goes out.')
                        : chosen === 1
                            ? t('webpages.audience.gate_n_chosen', 'One column goes out.')
                            : t('webpages.audience.gate_n_chosen_plural', '{n} columns go out.').replace('{n}', String(chosen))}
                </span>
            </div>
        </Card>
    );
}

// ── het adres ────────────────────────────────────────────────────────

function AddressCard({ t, model, options, setOptions, onSaveOptions, busy }) {
    const [copied, setCopied] = useState(false);
    const [open, setOpen] = useState(false);
    const address = model?.address;
    const isPublic = !!model?.public?.on;
    // Wat er over de ANDERE externe links gezegd moet worden — de regel staat
    // apart en puur, want hij hangt van drie velden af en is het enige dat
    // "Not serving" ervan weerhoudt te lezen als "niemand kan er nog bij".
    const notice = otherLinksNotice(model);

    const copy = async () => {
        const value = address?.url || address?.path || '';
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* een browser zonder klembord: de tekst staat er gewoon */ }
    };

    return (
        <Card>
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{t('webpages.address.title', 'Address')}</span>
                {isPublic
                    ? <Chip label={t('webpages.address.live', 'Live')} tone="public" />
                    : <Chip label={t('webpages.address.not_serving', 'Not serving')} tone="muted" dashed />}
            </div>

            {address ? (
                <div className="flex items-center gap-2 flex-wrap">
                    <code
                        data-testid="address-value"
                        className="text-[11px] px-1.5 py-0.5 rounded border"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                    >
                        {address.url || address.path}
                    </code>
                    <button type="button" onClick={copy} className="text-xs underline inline-flex items-center gap-1">
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? t('webpages.address.copied', 'Copied') : t('common.copy', 'Copy')}
                    </button>
                </div>
            ) : (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('webpages.address.none_yet', 'This page gets its address the first time you make it public.')}
                </p>
            )}

            {address && (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('webpages.address.made_of',
                        'The readable part comes from the page name as it was the first time you made this page public, and the rest is random so the address cannot be guessed. Renaming the page does not move it.')}
                </p>
            )}

            {address && !isPublic && (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('webpages.address.kept_while_off',
                        'The address stays reserved while Public is off — it shows nothing until you turn Public back on, and then it is the same link again.')}
                </p>
            )}

            <button
                type="button"
                data-testid="address-options-toggle"
                onClick={() => setOpen(o => !o)}
                className="self-start text-xs underline"
                aria-expanded={open}
            >
                {t('webpages.all_options', 'All options')}
            </button>

            {open && (
                <div className="flex flex-col gap-2 pt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                    <fieldset className="flex flex-col gap-1">
                        <legend className="text-[11px] font-medium">
                            {t('webpages.address.who_may_open', 'Who may open the address')}
                        </legend>
                        {[
                            ['unlisted', t('webpages.address.mode_unlisted', 'Anyone with the address')],
                            ['password', t('webpages.address.mode_password', 'Anyone with the address and the password')],
                            ['email', t('webpages.address.mode_email', 'Only these email addresses')],
                        ].map(([value, label]) => (
                            <label key={value} className="inline-flex items-center gap-2 text-[11px] cursor-pointer">
                                <input
                                    type="radio"
                                    name="bf-access-mode"
                                    value={value}
                                    checked={options.accessMode === value}
                                    onChange={() => setOptions(o => ({ ...o, accessMode: value }))}
                                />
                                {label}
                            </label>
                        ))}
                    </fieldset>

                    {options.accessMode === 'password' && (
                        <label className="flex flex-col gap-1 text-[11px]">
                            {t('webpages.address.password', 'Password (at least 6 characters)')}
                            <input
                                type="password"
                                value={options.password}
                                onChange={(e) => setOptions(o => ({ ...o, password: e.target.value }))}
                                className="rounded border px-2 py-1"
                                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}
                            />
                        </label>
                    )}

                    {options.accessMode === 'email' && (
                        <label className="flex flex-col gap-1 text-[11px]">
                            {t('webpages.address.emails', 'Email addresses, one per line')}
                            <textarea
                                rows={3}
                                value={options.emails}
                                onChange={(e) => setOptions(o => ({ ...o, emails: e.target.value }))}
                                className="rounded border px-2 py-1"
                                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}
                            />
                        </label>
                    )}

                    <label className="flex flex-col gap-1 text-[11px]">
                        {t('webpages.address.expires', 'Stops working on')}
                        <input
                            type="date"
                            value={options.expiresAt}
                            onChange={(e) => setOptions(o => ({ ...o, expiresAt: e.target.value }))}
                            className="rounded border px-2 py-1 self-start"
                            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}
                        />
                    </label>

                    <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {t('webpages.address.replace_warning',
                            'Changing the password or the email list replaces the underlying link, so links people already have stop working. The address itself stays the same.')}
                    </p>

                    {isPublic && (
                        <button
                            type="button"
                            data-testid="address-options-save"
                            disabled={busy}
                            onClick={onSaveOptions}
                            className="self-start text-xs underline disabled:opacity-50 inline-flex items-center gap-1"
                        >
                            {busy && <Loader2 size={12} className="animate-spin" />}
                            {t('webpages.address.save_options', 'Apply')}
                        </button>
                    )}
                </div>
            )}

            {/* Zolang Openbaar AAN staat: alleen bij méér dan één, want dan is
                één van die links het adres en de rest staat ernaast. De zin is
                daarom altijd meervoud en heeft geen enkelvoudsvorm nodig. */}
            {notice === 'while_on' && (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('webpages.address.other_links',
                        'There are {n} external links on this page in total. Only this one is the address; the others are separate share links.')
                        .replace('{n}', String(model.shareCount))}
                </p>
            )}

            {/* Staat Openbaar UIT, dan geldt die drempel niet meer: geen van de
                overgebleven links is nog het adres, en ze serveren allemaal
                door. Eén link is dan juist het geval dat gemeld MOET worden. */}
            {notice === 'while_off' && (
                <p
                    data-testid="other-links-while-off"
                    className="text-[11px]"
                    style={{ color: 'var(--warning)' }}
                >
                    {model.shareCount === 1
                        ? t('webpages.address.serving_while_off',
                            'Public is off, but one external link still serves a snapshot of this page. It is not the address, so turning Public off did not stop it.')
                        : t('webpages.address.serving_while_off_plural',
                            'Public is off, but {n} external links still serve a snapshot of this page. They are not the address, so turning Public off did not stop them.')
                            .replace('{n}', String(model.shareCount))}
                </p>
            )}

            {notice === 'unknown' && (
                <p
                    data-testid="other-links-unknown"
                    className="text-[11px]"
                    style={{ color: 'var(--warning)' }}
                >
                    {t('webpages.address.other_links_unknown',
                        'Whether other external links still serve this page could not be checked, so nothing is claimed here.')}
                </p>
            )}

            {model?.solution && (
                <p className="text-[11px] pt-1 border-t" style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-subtle)' }}>
                    <Building2 size={11} className="inline mr-1" aria-hidden="true" />
                    {t('webpages.address.part_of_solution', 'Part of solution {name}').replace('{name}', model.solution.name)}
                </p>
            )}
        </Card>
    );
}

// ── het paneel ───────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {string} props.webpageId
 * @param {object} [props.page]           de webpage-rij (isPublished, sharedGroups)
 * @param {Array}  [props.orgGroups]      groepen voor de groepskiezer
 * @param {boolean}[props.readOnly]       niet-eigenaar: /audience is eigenaar-only
 * @param {function}[props.onSetPersonal] de drie interne rijen schrijven via
 * @param {function}[props.onSetEntireOrg]  PATCH /:id/publish, net als de capsule
 * @param {function}[props.onToggleGroup]
 */
export default function WebpageAudiencePanel({
    webpageId,
    page = null,
    orgGroups = [],
    readOnly = false,
    onSetPersonal = null,
    onSetEntireOrg = null,
    onToggleGroup = null,
}) {
    const { t } = useTranslation();
    const [state, setState] = useState({ loading: true, error: null, data: null });
    const [gateOpen, setGateOpen] = useState(false);
    const [choice, setChoice] = useState({});
    const [busy, setBusy] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [options, setOptions] = useState({ accessMode: 'unlisted', password: '', emails: '', expiresAt: '' });

    /**
     * Neem het servermodel over als lokale staat.
     *
     * Hier hoort `choice` bij, en dat is niet cosmetisch: `publishBody` stuurt
     * `choice` altijd mee, en de server leest een ontbrekende tabel als NUL
     * kolommen. Zou `choice` leeg blijven staan omdat de gebruiker de
     * kolomkeuze niet had geopend, dan zou "Apply" onder Alle opties de hele
     * poort dichtgooien zonder dat iemand daarom vroeg. Dus: na elke lezing en
     * na elke schrijfactie staat hier de WERKELIJKE stand.
     */
    const adopt = useCallback((body) => {
        setState({ loading: false, error: null, data: body });
        setChoice(initialColumnChoice(body?.columnGate, !!body?.public?.on));
        setOptions({
            accessMode: body?.public?.accessMode || 'unlisted',
            password: '',
            emails: (body?.public?.allowedEmails || []).join('\n'),
            expiresAt: body?.public?.expiresAt ? String(body.public.expiresAt).slice(0, 10) : '',
        });
    }, []);

    const load = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const res = await authFetch(AUDIENCE_URL(webpageId));
            const body = await readJson(res);
            if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
            adopt(body);
        } catch (e) {
            setState({ loading: false, error: e.message || 'failed', data: null });
        }
    }, [webpageId, adopt]);

    useEffect(() => { if (webpageId && !readOnly) load(); }, [webpageId, readOnly, load]);

    const model = state.data;
    const boundTables = useMemo(() => (model?.columnGate?.tables || []), [model]);
    const publicColumnCount = useMemo(() => countPublicColumns(model?.columnGate), [model]);

    /** De body van PUT /audience/public — één plek, zodat aan en bij-stellen niet uiteenlopen. */
    const publishBody = (on) => ({
        on,
        publicColumns: choice,
        accessMode: options.accessMode,
        ...(options.password ? { password: options.password } : {}),
        allowedEmails: options.emails.split('\n').map(s => s.trim()).filter(Boolean),
        expiresAt: options.expiresAt || null,
    });

    const send = async (body) => {
        setBusy(true);
        setSaveError(null);
        try {
            const res = await authFetch(PUBLIC_URL(webpageId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const out = await readJson(res);
            if (!res.ok) throw new Error((out && out.error) || `HTTP ${res.status}`);
            adopt(out);
            setGateOpen(false);
        } catch (e) {
            setSaveError(e.message || 'failed');
        } finally {
            setBusy(false);
        }
    };

    const openGate = () => {
        const start = initialColumnChoice(model?.columnGate, !!model?.public?.on);
        setChoice(start);
        // Geen gebonden tabellen = niets te vragen. De keuze wordt dan een lege
        // map, en dat is precies wat de server als "niets naar buiten" leest.
        if (boundTables.length === 0) {
            send({ ...publishBody(true), publicColumns: {} });
            return;
        }
        setGateOpen(true);
    };

    if (readOnly) {
        return (
            <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.audience.owner_only', 'Only the page owner can change who can see this page.')}
            </div>
        );
    }

    return (
        <div className="p-3 flex flex-col gap-3">
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.audience.subtitle', 'Who can see this page, and where it lives.')}
            </p>

            <AudienceRows
                t={t}
                agent={page}
                confirmWidening
                isPublished={!!page?.isPublished}
                sharedGroups={Array.isArray(page?.sharedGroups) ? page.sharedGroups : []}
                orgGroups={orgGroups}
                onSetPersonal={onSetPersonal}
                onSetEntireOrg={onSetEntireOrg}
                onToggleGroup={onToggleGroup}
                disabled={!onSetPersonal}
                hint={t('webpages.audience.inside_hint',
                    'Inside Bee Flow, readers see the version you published — not what you are editing right now.')}
            />

            {state.loading && (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <Loader2 size={14} className="animate-spin" />
                    {t('webpages.audience.loading', 'Reading who can see this page…')}
                </div>
            )}

            {!state.loading && state.error && (
                <Card tone="warning">
                    <p className="text-sm">{t('webpages.audience.load_failed', 'Could not load who can see this page.')}</p>
                    <button type="button" className="self-start text-xs underline inline-flex items-center gap-1" onClick={load}>
                        <RefreshCw size={12} /> {t('webpages.retry', 'Try again')}
                    </button>
                </Card>
            )}

            {!state.loading && !state.error && model && (
                <>
                    <PublicRow
                        t={t}
                        model={model}
                        busy={busy && !gateOpen}
                        disabled={gateOpen}
                        onOpen={openGate}
                        onTurnOff={() => send({ on: false })}
                    />

                    {gateOpen && (
                        <ColumnGateForm
                            t={t}
                            columnGate={model.columnGate}
                            choice={choice}
                            setChoice={setChoice}
                            busy={busy}
                            onConfirm={() => send(publishBody(true))}
                            onCancel={() => setGateOpen(false)}
                        />
                    )}

                    {saveError && (
                        <Card tone="warning">
                            <p className="text-sm" data-testid="audience-save-error">{saveError}</p>
                        </Card>
                    )}

                    <AddressCard
                        t={t}
                        model={model}
                        options={options}
                        setOptions={setOptions}
                        busy={busy}
                        onSaveOptions={() => send(publishBody(true))}
                    />

                    {/* Wat er vandaag daadwerkelijk naar buiten gaat — de poort in
                        één zin, ook als hij dicht staat. */}
                    <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        <Lock size={11} className="inline mr-1" aria-hidden="true" />
                        {!model.columnGate?.anyBound
                            ? t('webpages.audience.gate_no_tables', 'No tables are bound to this page, so no rows go out.')
                            : publicColumnCount === 0
                                ? t('webpages.audience.gate_summary_none', 'No column from a bound table appears on the public page.')
                                : publicColumnCount === 1
                                    ? t('webpages.audience.gate_summary', 'One column from a bound table appears on the public page.')
                                    : t('webpages.audience.gate_summary_plural', '{n} columns from bound tables appear on the public page.')
                                        .replace('{n}', String(publicColumnCount))}
                    </p>
                </>
            )}
        </div>
    );
}
