/**
 * De zod-woordenschat waaruit de verzoekschema's van deze router zijn gebouwd.
 *
 * Elke body hieronder is `.strict()`. Op een router die vergaderingen OPNEEMT
 * is dat geen vormkwestie: twee van de stille terugvallen die hij bevatte
 * zetten een opname AAN die iemand net had uitgezet, en één publiceerde een
 * notitie aan de hele organisatie terwijl er één groep gekozen was.
 *
 * Drie vallen zitten hier één keer dicht zodat geen enkele route ze heropent:
 *
 *   • `worded()` — zonder `required_error` antwoordt zod op een ontbrekend
 *     veld met het kale woord "Required", en dat mag een beller nooit lezen.
 *   • enums — `invalid_type_error` dekt alleen een verkeerd TYPE, nooit een
 *     verkeerde WAARDE. Elke enum hier draagt daarom een `errorMap`; zie de
 *     kop van core/http/validate.js.
 *   • `flag()` — het "ja" op de query string. Een URL draagt geen booleans,
 *     dus beide spellingen die een client echt verstuurt tellen, en al het
 *     andere is een 400 in plaats van stilzwijgend "nee".
 */

'use strict';

const { z } = require('zod');

/** Een string waarvan élke weigering — ook "je liet hem weg" — een zin is. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** Een body die óók geen body accepteert: Express 5 laat `req.body` dan undefined. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape).strict(),
);

/** Een enum waarvan de weigering één zin is, voor een verkeerde waarde net zo goed. */
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

/** Een "ja" op de query string. `?confirm=1` en `?confirm=true` allebei. */
const flag = (message) => choice(['true', '1', 'false', '0'], message)
    .transform((v) => v === 'true' || v === '1')
    .optional();

/** Een geheel getal op de query string. */
const whole = (name) => z.coerce.number({ invalid_type_error: `${name} is een getal.` })
    .int(`${name} is een heel getal.`)
    .optional();

/** Een lijst van id's — wat er ín staat is aan de store om te toetsen. */
const idList = (message) => z.array(worded(message).trim().min(1, message), {
    required_error: message, invalid_type_error: message,
});

/**
 * Een échte boolean, nooit een string.
 *
 * Twee routes schreven `record: !!record` rechtstreeks in de opnamevoorkeur
 * van een vergadering. `"false"` is waar, dus wie de opname UIT zette met een
 * tekst in plaats van een boolean zette hem AAN — en `{}` of een typefout
 * zette hem uit. Op deze router is dat het verschil tussen een vergadering
 * die wel of niet wordt opgenomen.
 */
const bool = (message) => z.boolean({ required_error: message, invalid_type_error: message });

/** Niets. Gezegd in plaats van weggelaten: een genegeerde sleutel is een belofte. */
const NO_QUERY = z.object({}).strict();
const NOTHING = bodyOf({});

module.exports = { worded, bodyOf, choice, flag, whole, idList, bool, NO_QUERY, NOTHING };
