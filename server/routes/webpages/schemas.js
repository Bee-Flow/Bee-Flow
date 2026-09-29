/**
 * De zod-woordenschat waaruit de verzoekschema's van deze router zijn gebouwd.
 *
 * Elke body hieronder is `.strict()`, en op deze router is dat het hele punt:
 * een sleutel die niemand las viel van het lijstje af, onder een 200 die
 * eruitzag als "opgeslagen". Op drie plekken deed hij meer dan dat — hij
 * WISTE iets (de chatgeschiedenis), of maakte een gepubliceerde pagina weer
 * privé zonder het te zeggen.
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

/** Tekst die een mens typt: getrimd, niet leeg. */
const text = (message, max = 2000) => worded(message).trim().min(1, message).max(max, message);

/** Een geheel getal op de query string. */
const whole = (name) => z.coerce.number({ invalid_type_error: `${name} is een getal.` })
    .int(`${name} is een heel getal.`)
    .optional();

/** Een lijst van id's — wat er ín staat is aan de store om te toetsen. */
const idList = (message) => z.array(worded(message).trim().min(1, message), {
    required_error: message, invalid_type_error: message,
});

/** Niets. Gezegd in plaats van weggelaten: een genegeerde sleutel is een belofte. */
const NO_QUERY = z.object({}).strict('Dit accepteert geen queryparameters.');
const NOTHING = bodyOf({});

module.exports = { worded, bodyOf, choice, flag, text, whole, idList, NO_QUERY, NOTHING };
