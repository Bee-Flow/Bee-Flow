/**
 * Wanneer een vergadering is: parsen, duur, tijdvak en het datumblok.
 *
 * ── WAAROM DIT LOS VAN upcomingMeta.js STAAT ──────────────────────────
 * Dit bestand heeft met opzet GEEN imports. De hele-dag-regel hieronder is
 * alleen te toetsen in een tijdzone met een NEGATIEVE offset — in UTC geven de
 * goede en de foute implementatie hetzelfde antwoord, dus een assertie die in
 * de container (TZ=UTC) draait houdt de fix niet tegen. `upcomingWhen.test.js`
 * draait deze module daarom óók in een kindproces onder
 * TZ=America/New_York, en dat kan alleen als het bestand zonder bundler te
 * importeren is.
 *
 * `upcomingMeta.js` her-exporteert alles hier, zodat aanroepers niets merken.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Eén agendamoment. Geeft `{ date, dateOnly }` of NULL als er niets bruikbaars
 * staat — `null` betekent hier "onbekend", nooit "nu".
 *
 * Een hele-dag-afspraak komt bij beide providers binnen als een kale DATUM
 * ("2026-07-18"; gmeetCalendar valt terug op `start.date`). `new Date()` leest
 * die als UTC-middernacht, waardoor hij in een negatieve tijdzone een dag te
 * vroeg op het scherm komt. Daarom parsen we hem als LOKALE middernacht en
 * markeren we hem als `dateOnly`: er staat een dag in, geen tijdstip.
 */
export function parseWhen(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: value, dateOnly: false };
    const s = String(value).trim();
    if (!s) return null;
    if (DATE_ONLY_RE.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        return Number.isNaN(date.getTime()) ? null : { date, dateOnly: true };
    }
    const date = new Date(s);
    return Number.isNaN(date.getTime()) ? null : { date, dateOnly: false };
}

/**
 * De duur in hele minuten, of NULL als we hem niet kennen. Onbekend blijft
 * onbekend bij: een ontbrekende of onleesbare kant, een hele-dag-afspraak (een
 * datum is geen lengte) en een einde dat niet ná het begin ligt.
 */
export function meetingDurationMinutes(start, end) {
    const s = parseWhen(start);
    const e = parseWhen(end);
    if (!s || !e) return null;
    if (s.dateOnly || e.dateOnly) return null;
    const minutes = Math.round((e.date.getTime() - s.date.getTime()) / 60000);
    return minutes > 0 ? minutes : null;
}

/** `do 12 sep` in stukken voor het datumblok, of NULL zonder begintijd. */
export function dateBlockParts(start) {
    const when = parseWhen(start);
    if (!when) return null;
    return {
        weekday: when.date.toLocaleDateString(undefined, { weekday: 'short' }),
        day: when.date.toLocaleDateString(undefined, { day: 'numeric' }),
        month: when.date.toLocaleDateString(undefined, { month: 'short' }),
    };
}

const hhmm = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** `14:00–15:00`, `14:00`, of '' — een hele dag heeft geen tijdvak. */
export function timeRange(start, end) {
    const s = parseWhen(start);
    if (!s || s.dateOnly) return '';
    const e = parseWhen(end);
    return e && !e.dateOnly ? `${hhmm(s.date)}–${hhmm(e.date)}` : hhmm(s.date);
}
