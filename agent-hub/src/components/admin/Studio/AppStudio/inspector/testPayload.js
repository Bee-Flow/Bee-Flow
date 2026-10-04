/**
 * Wat een testrun MEEKRIJGT, en wat er aantoonbaar niet in zit.
 *
 * De testknop naast een `run_automation`-actie draaide de automatisering met alleen de
 * STATISCHE waarden uit de input-mapping. Alles wat aan een formulierveld hing
 * — meestal de echte invoer — kwam als `undefined` aan, viel uit de JSON, en de
 * automatisering begon met een lege `trigger.output`. De run zag er daarna precies uit
 * als een kapotte stap.
 *
 * Deze functie bouwt dezelfde payload uit de ACTUELE schermwaarden, en geeft
 * los daarvan terug wat er NIET in zit en waarom. Dat tweede is geen extraatje:
 * wie test met de helft van de invoer en dat niet weet, trekt de verkeerde
 * conclusie over de automation.
 *
 * ── Bestandsvelden gaan nooit mee ──────────────────────────────────────────
 *
 * Vier onafhankelijke redenen, elk op zich al genoeg:
 *
 *   1. De browser heeft de bytes niet. Een bestandsveld houdt alleen een
 *      descriptor vast: `{ kind:'studio_attachment', fileId, name, mime, size }`
 *      (runtime/components/AppInputFile.jsx).
 *   2. Alleen de app-brug kan die descriptor uitpakken (`expandFileInput` in
 *      server/appStudio/actionExecutor/automationBridge.js), en die zit achter
 *      `POST /api/studio-apps/:id/actions/:actionId/run` — niet achter de
 *      automation-route waar deze knop op uitkomt.
 *   3. Die opzoeking is app- én eigenaar-scoped en weigert een niet-gescand of
 *      in quarantaine gezet bestand.
 *   4. De download-URL wordt per run gemunt en verloopt; een uit een scherm
 *      gekopieerde URL is óf dood óf een lek.
 *
 * Dus: overslaan, en het zeggen. Een stap die op `trigger.output.<veld>.url`
 * bindt gaat in de test anders leeg door, en dat lijkt op een bug in de stap.
 *
 * ── Onbekend versmalt ──────────────────────────────────────────────────────
 *
 * Een veldverwijzing waarvoor het scherm geen waarde heeft wordt NIET als
 * `null` of `''` verzonnen. Hij wordt overgeslagen en gemeld — dat is hetzelfde
 * antwoord met een ander gezicht, maar het verschil is precies wat de tester
 * moet weten.
 *
 * Puur: geen React, geen fetch. De aanroeper haalt de schermwaarden op
 * (editor/ScreenValuesContext) en toont wat hier uitkomt.
 */

/** Waarom een parameter niet meegaat. Elk met een eigen zin in de UI. */
export const SKIP_REASONS = Object.freeze({
    FILE: 'file',           // bestandsveld — kan per definitie niet mee
    NO_SCREEN: 'no_screen', // het formulier staat niet (meer) op het scherm
    NO_VALUE: 'no_value',   // het formulier staat er, dit veld heeft geen waarde
    UNMAPPED: 'unmapped',   // de mapping is leeg of van een onbekende soort
    NO_MAPPING: 'no_mapping', // de automatisering vraagt de parameter, er is geen regel voor
});

/** Componenttypes die een bestand opleveren in plaats van een waarde. */
const FILE_FIELD_TYPES = ['input_file'];

/**
 * @param {object}      args
 * @param {object}      args.inputMapping  `{ [param]: {kind:'static',value} | {kind:'field',name} }`
 * @param {Array}       args.formFields    `[{ name, type, multiple }]` van het omsluitende formulier
 * @param {object|null} args.formValues    de LIVE waarden van dat formulier, of
 *                                         null als het niet op het scherm staat
 * @param {object|null} args.paramMeta     `{ [param]: { type, required } }` uit het
 *                                         contract van de automatisering, als dat er is
 * @returns {{payload: object, skipped: Array<{param: string, field: string|null, reason: string}>}}
 */
export function buildTestPayload({
    inputMapping = null, formFields = [], formValues = null, paramMeta = null,
} = {}) {
    const payload = {};
    const skipped = [];
    const fieldByName = new Map((formFields || []).filter((f) => f && f.name).map((f) => [f.name, f]));
    const skip = (param, field, reason) => skipped.push({ param, field: field || null, reason });

    // DE UNIE, NIET DE MAPPING ALLEEN.
    //
    // Een parameter die de automatisering WEL declareert maar die geen mapping-regel
    // heeft (de automatisering kreeg er later een bij, of iemand haalde de regel weg)
    // kwam in geen van beide lijsten voor: hij reisde niet mee én werd niet
    // gemeld. De UI toont hem wél — ContractDrift zegt "The automation also
    // expects: + invoiceFile *" — maar de testrun deed alsof hij niet bestond,
    // en dat is precies de half-ingevulde run waar deze module tegen is
    // geschreven. Gedeclareerde volgorde eerst, daarna wat de mapping extra
    // noemt (een regel voor een parameter die de automatisering niet meer kent).
    const mapping0 = inputMapping || {};
    const declared = paramMeta && typeof paramMeta === 'object' ? Object.keys(paramMeta) : [];
    const names = [...new Set([...declared, ...Object.keys(mapping0)])];

    for (const param of names) {
        const mapping = mapping0[param];
        // Gedeclareerd, maar niets dat zegt waar de waarde vandaan komt. Niets
        // verzinnen: overslaan en melden. Een `file`-parameter valt hieronder
        // niet — die krijgt hierboven al de FILE-reden, die specifieker is.
        if (mapping === undefined && !Object.prototype.hasOwnProperty.call(mapping0, param)
            && paramMeta?.[param]?.type !== 'file') {
            skip(param, null, SKIP_REASONS.NO_MAPPING);
            continue;
        }
        // Het CONTRACT wint van de mapping: een parameter die de automatisering als
        // `file` declareert gaat niet mee, ook niet als er per ongeluk een
        // statische lege string aan hangt (de plaatsvervanger die de picker
        // schrijft als er geen bestandsveld is om naar te wijzen).
        if (paramMeta?.[param]?.type === 'file') {
            skip(param, mapping?.kind === 'field' ? mapping.name : null, SKIP_REASONS.FILE);
            continue;
        }
        if (mapping?.kind === 'static') {
            payload[param] = mapping.value;
            continue;
        }
        if (mapping?.kind === 'field') {
            const field = fieldByName.get(mapping.name) || null;
            // Ook zonder gedeclareerd contract: een bestandsinvoer is een
            // bestandsinvoer.
            if (field && FILE_FIELD_TYPES.includes(field.type)) {
                skip(param, mapping.name, SKIP_REASONS.FILE);
                continue;
            }
            if (!formValues || typeof formValues !== 'object') {
                skip(param, mapping.name, SKIP_REASONS.NO_SCREEN);
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(formValues, mapping.name)) {
                skip(param, mapping.name, SKIP_REASONS.NO_VALUE);
                continue;
            }
            payload[param] = formValues[mapping.name];
            continue;
        }
        // Een lege of onbekende mapping. Niets verzinnen.
        skip(param, null, SKIP_REASONS.UNMAPPED);
    }

    return { payload, skipped };
}

/**
 * Welke parameters STRUCTUREEL nooit meegaan — puur uit de mapping en het
 * contract, zonder de schermwaarden.
 *
 * Dit is wat er onder de knop kan staan vóórdat er iemand op drukt. De rest
 * (staat het formulier op het scherm, heeft dit veld een waarde) hangt van het
 * moment af en hoort bij de uitslag.
 */
const STRUCTURAL_REASONS = new Set([SKIP_REASONS.FILE, SKIP_REASONS.NO_MAPPING]);

export function alwaysSkipped({ inputMapping = null, formFields = [], paramMeta = null } = {}) {
    return buildTestPayload({ inputMapping, formFields, paramMeta, formValues: {} })
        .skipped
        // FILE en NO_MAPPING hangen allebei alleen van de mapping en het
        // contract af, dus ze zijn te weten vóórdat er iemand op Test drukt.
        // NO_SCREEN en NO_VALUE hangen van het moment af en horen bij de
        // uitslag.
        .filter((s) => STRUCTURAL_REASONS.has(s.reason));
}
