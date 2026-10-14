// @typecheck
/**
 * The SQL for the three artifact columns (action_items / decisions /
 * questions) of a regeneration: the database clock and the windowed merge
 * updateTranscription writes them with.
 */

/**
 * ── HET VENSTER VAN EEN REGENERATIE (M4) ────────────────────────────
 *
 * "Opnieuw" leest de notitie, praat daarna minuten met een model en schrijft
 * dán pas. De merge in core/meetingNotes/actionItems.js beschermt wat een
 * mens heeft neergezet — maar alleen rijen die in die MOMENTOPNAME zaten.
 * Wie ondertussen in het transcript-tabblad een regel als besluit vastlegt
 * (de "Opnieuw"-banner staat boven dat tabblad), schrijft in precies dat
 * venster: voor de merge is die rij onzichtbaar en de landende update wist
 * hem. Geen melding, geen undo — en het antwoord toont daarna keurig de
 * werkelijkheid waarin de rij zojuist verdween. Hetzelfde geldt voor een
 * bestaand punt dat iemand in dat venster AFVINKT of overtypt: de merge
 * draaide tegen een momentopname van vóór dat vinkje.
 *
 * Het antwoord daarop hoort NIET in de route: die weet niets van wat er ná
 * zijn read is gebeurd. Het hoort in het SQL van de schrijfactie, want daar
 * is de kolom van dit moment te zien. De regel is: vervang alleen wat er vóór
 * het vertrekpunt van de run al stond; wat erna is ontstaan OF veranderd
 * blijft staan.
 *
 * ── ÉÉN KLOK ────────────────────────────────────────────────────────
 * Zowel het vertrekpunt (`readAt`, meegegeven door getTranscription) als de
 * `createdAt`/`touchedAt` van elke artefactregel komt uit `NOW()` van DEZE
 * database.
 * Node's klok komt er niet aan te pas en de client evenmin: twee klokken die
 * milliseconden uiteenlopen beslissen juist aan de randen van dit venster de
 * verkeerde kant op. Vandaar één vast, lexicografisch vergelijkbaar formaat
 * in plaats van een cast die op een rare waarde kan omvallen.
 *
 * IN MICROSECONDEN, NIET IN MILLISECONDEN. `NOW()` van Postgres loopt in
 * microseconden, en dit formaat gooide er drie cijfers van weg (het was
 * identiek aan JS' toISOString). Twee transacties in dezelfde milliseconde
 * kregen dan dezelfde stempel, en `>` maakt van gelijk "vóór de run": een
 * vinkje dat in dezelfde milliseconde landde als de read van "Opnieuw", werd
 * stil overschreven. Met de volle klok betekent gelijk vrijwel alleen nog:
 * dezelfde transactie (NOW() is het begin daarvan).
 * Stempels van vóór deze regel dragen nog drie cijfers ("…12.345Z"). Tegen
 * een nieuwe vergelijkt dat alleen anders dan de tijd als beide in dezelfde
 * milliseconde vallen, en een oude stempel en een nieuwe read liggen minstens
 * een deploy uit elkaar.
 *
 * GEEN OPTIMISTIC LOCK. Een versiecontrole zou de hele schrijfactie weigeren
 * omdat er érgens iets veranderd is; dat maakt van een geslaagde run van
 * minuten een foutmelding. Een tijdstempel per rij zegt precies genoeg.
 */
const DB_CLOCK_ISO = `to_char(NOW() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// De stempel voor een rij die al in de kolom stond maar er nog geen draagt:
// geschreven vóór deze regel bestond, door de kale UPDATE van /reprocess, of
// door de INSERT van een auto-import. Zelfde klok, zelfde formaat.
//
// HIER STOND `updated_at`, EN DAT VERBREEDDE. `updated_at` is het moment van
// de vorige schrijfactie op de NOTITIE, en dat ligt ná het vertrekpunt van een
// lopende run zodra er tijdens die run ook maar iets anders op de rij is
// geschreven (een titel PATCHen, een spreker hernoemen, de audio-backfilljob).
// Een ongestempelde AI-rij kreeg dan een stempel BINNEN het venster en
// overleefde als "tijdens de run ontstaan" — precies de rij die "Opnieuw"
// hoort te vervangen, en de gebruiker zag oude AI-punten terugkomen.
//
// `created_at` is het aanmaakmoment van de NOTITIE. Dat ligt per definitie
// vóór elke read van die rij, dus vóór elk mogelijk vertrekpunt, en het
// beweegt nooit meer. Een rij zonder stempel kan niet nieuwer dan het
// vertrekpunt bewezen worden en telt daarmee gegarandeerd als oud — de kant
// waar de gewone merge-regel geldt, die een mens z'n rijen al beschermt.
const ROW_UNSTAMPED_ISO = `to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Een JSON-scalar in een array-kolom telt als leeg — zelfde regel als parseJsonArray. */
function jsonbArrayOf(expr) {
    return `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`;
}

/**
 * De inhoud van één artefactrij ZONDER de twee stempels.
 *
 * Waarmee de vraag "is deze rij daadwerkelijk veranderd" wordt beantwoord: de
 * stempels zelf tellen niet mee, anders zou elke herschrijving zichzelf als
 * wijziging melden. Een rij die geen object is gaat ongemoeid door — die kan
 * de `- 'key'`-operator niet aan, en "onbekend" hoort hier als "veranderd" te
 * eindigen (versmallend: de rij telt dan als tijdens de run aangeraakt).
 */
function artifactRowBody(expr) {
    return `(CASE WHEN jsonb_typeof(${expr}) = 'object'
                  THEN (${expr}) - 'createdAt' - 'touchedAt' ELSE ${expr} END)`;
}

/**
 * De SET-expressie voor één artefactkolom (action_items / decisions / questions).
 *
 * ── TWEE STEMPELS, ÉÉN VRAAG ────────────────────────────────────────
 *   createdAt  wanneer deze rij is ONTSTAAN (blijft staan bij herschrijven).
 *   touchedAt  wanneer deze rij voor het laatst van INHOUD veranderde.
 * Beide van de databaseklok, allebei onbereikbaar voor de client: wat er
 * binnenkomt wordt hier overschreven.
 *
 * Drie delen, in één statement zodat er tussen lezen en schrijven geen venster
 * meer zit:
 *   1. Staat er een rij met DEZELFDE id in de kolom die ná het vertrekpunt van
 *      de run is aangeraakt, dan wint DIE rij en wordt wat de schrijver stuurt
 *      genegeerd.
 *   2. Anders: wat de schrijver stuurt, met de stempels hierboven.
 *   3. Alleen als er een vertrekpunt is: alles wat op dit moment in de kolom
 *      staat, ná dat vertrekpunt is aangeraakt, en niet al in (1)/(2) voorkomt.
 *
 * ── WAAROM DEEL 1 ER IS ─────────────────────────────────────────────
 * Deel 3 alleen redt rijen die tijdens de run zijn ONTSTAAN. Een bestaand
 * AI-punt dat iemand tijdens diezelfde run AFVINKT houdt zijn oude `createdAt`
 * en staat gewoon in de verse lijst — beide voorwaarden van deel 3 falen, dus
 * de minuten oude momentopname van de merge overschreef het vinkje weer. Dat
 * is dezelfde bevinding, alleen onder een andere volgorde: de merge beschermt
 * menselijke invoer die vóór de read gebeurde, dit deel beschermt die van
 * tijdens de run.
 *
 * De hele opgeslagen rij wint, niet een paar velden ervan: welk veld een mens
 * heeft aangeraakt is hier niet te zien, en een verse tijdstempel of assignee
 * kwijtraken op één rij weegt niet op tegen een vinkje of een correctie stil
 * ongedaan maken. De volgende regeneratie ververst hem alsnog.
 */
function artifactColumnSql(column, valuePh, sincePh) {
    const stored = jsonbArrayOf(column);
    const now = `to_jsonb(${DB_CLOCK_ISO})`;
    const unstamped = `to_jsonb(${ROW_UNSTAMPED_ISO})`;
    // "Deze rij is ná het vertrekpunt van de run aangeraakt." Zonder
    // vertrekpunt is er geen venster en is het antwoord altijd nee. Een rij
    // zonder stempel geeft NULL en dus ook nee — onbekend versmalt.
    const touchedDuringTheRun = (expr) => (sincePh ? `(${expr})->>'touchedAt' > ${sincePh}::text` : 'false');
    const keptFromTheRun = sincePh ? `
                UNION ALL
                SELECT kept AS item, 1000000 + k.n AS ord
                  FROM jsonb_array_elements(${stored}) WITH ORDINALITY AS k(kept, n)
                 WHERE ${touchedDuringTheRun('kept')}
                   AND NOT EXISTS (
                       SELECT 1 FROM jsonb_array_elements(${valuePh}::jsonb) AS f(fresh)
                        WHERE fresh->>'id' = kept->>'id')` : '';
    return `(SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb) FROM (
                SELECT CASE
                         WHEN prev IS NOT NULL AND ${touchedDuringTheRun('prev')} THEN prev
                         ELSE e || jsonb_build_object(
                             'createdAt', COALESCE(prev->'createdAt',
                                 CASE WHEN prev IS NULL THEN ${now} ELSE ${unstamped} END),
                             'touchedAt',
                                 CASE WHEN prev IS NULL THEN ${now}
                                      WHEN ${artifactRowBody('e')} IS DISTINCT FROM ${artifactRowBody('prev')} THEN ${now}
                                      ELSE COALESCE(prev->'touchedAt', ${unstamped}) END)
                       END AS item,
                       w.n AS ord
                  FROM jsonb_array_elements(${valuePh}::jsonb) WITH ORDINALITY AS w(e, n)
                  LEFT JOIN LATERAL (
                       SELECT p FROM jsonb_array_elements(${stored}) AS o(p)
                        WHERE p->>'id' = e->>'id' LIMIT 1
                  ) AS pv(prev) ON TRUE${keptFromTheRun}
            ) AS windowed)`;
}

module.exports = { DB_CLOCK_ISO, ROW_UNSTAMPED_ISO, jsonbArrayOf, artifactRowBody, artifactColumnSql };
