/**
 * canUseFacts — de FEITEN achter de tab "Kan gebruiken", los van hoe ze
 * getekend worden (Bee Flow Builder-herontwerp, sep 2026; Agents-artboard 1a,
 * A2 stap 2).
 *
 * Alles hier is puur: in gaan de rauwe antwoorden van de server plus de eigen
 * config van de agent, eruit komen rijen met FEITEN — geen zinnen. De zinnen
 * staan in de kaarten, want daar staan ook de letterlijke t()-sleutels die de
 * i18n-guard leest.
 *
 * ── DRIE TOESTANDEN, NIET TWEE ──────────────────────────────────────
 * Elke bron draagt een `READ`-toestand mee, want "nog niet gelezen", "gelezen
 * en leeg" en "niet te lezen" zijn drie verschillende antwoorden en maar één
 * ervan mag als "de agent heeft niets" op het scherm komen. Een mislukte fetch
 * die op `[]` landt is de klassieke manier om dat verschil te verliezen: de
 * kaart zegt dan doodleuk "geen kennis gekoppeld" over een agent met vijf
 * kennisbanken.
 *
 * ── EEN GEKOPPELD ID DAT NIEMAND KENT VERDWIJNT NIET ────────────────
 * De KOPPELING staat in de config van de agent en die lezen we altijd; de
 * NAAM komt uit een lijst die kan ontbreken (een kennisbank buiten
 * `?context=agent`, een tabel achter de automations-module, een skill zonder
 * `skills`-capability). Zo'n rij wordt daarom `readable: false` — hij blijft
 * staan, met zijn id, en de kaart zegt erbij dat de naam niet gelezen kon
 * worden. Wegfilteren zou de koppeling zelf ontkennen: de agent gebruikt hem
 * wél.
 *
 * ── DE TABELKANT SPIEGELT DE SERVER, INCLUSIEF ZIJN VERSMALLINGEN ───
 * `server/core/agentRuntime/toolPolicy.js` (`datatableGrantsOf` /
 * `normaliseToolsConfig`) leest `config.tools.datatables` aan BEIDE kanten
 * opnieuw en versmalt daarbij: een onbekende `scope` wordt `'own'`, een
 * onleesbare `columns` wordt `[]` (= de tabel wordt geweigerd), en boven de
 * 25 grants telt alleen de eerste 25. Deze module doet exact hetzelfde, want
 * een kaart die "alle rijen" zegt waar de runtime "alleen eigen rijen" doet is
 * precies de opgeslagen-belofte-zonder-handhaving die dat bestand verbiedt.
 */

/** De leesbaarheid van een bron. `LOADING` is nooit hetzelfde als `OK` met nul rijen. */
export const READ = Object.freeze({ LOADING: 'loading', OK: 'ok', ERROR: 'error' });

/** Spiegelt toolPolicy.js — hoger telt de runtime niet mee. */
export const MAX_DATATABLE_GRANTS = 25;

/** Spiegelt toolPolicy.js: `scope` is een TOEGANGSvraag, dus onbekend ⇒ de smalle. */
const DATATABLE_SCOPES = Object.freeze(['own', 'all']);

/** Sleutels die een gewoon object niet veilig kan dragen (toolPolicy.js). */
const UNSAFE_OBJECT_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Een eindig, niet-negatief geheel getal, of `null` als het dat niet is.
 *
 * `null`, `undefined` en `''` worden EERST afgevangen, vóór `Number()` — die
 * maakt van `null` en `''` namelijk 0, en dat is precies de nul die deze
 * functie hoort tegen te houden: een ontbrekende teller die als "nul
 * documenten" op het scherm komt.
 */
export function countOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * `'*'` (elke gedeclareerde kolom) of de gekozen lijst — spiegel van
 * `_datatableColumns` in toolPolicy.js. Onleesbaar ⇒ `[]`, en `[]` betekent
 * daar "geen kolommen", niet "alle".
 */
export function datatableColumnsOf(raw) {
    if (raw === undefined || raw === null || raw === '*') return '*';
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const c of raw) {
        if (typeof c !== 'string' || !c || seen.has(c)) continue;
        seen.add(c);
        out.push(c);
    }
    return out;
}

/**
 * De gegunde tabellen uit `config.tools`, als `[{ id, scope, columns }]` in
 * configvolgorde. Nooit een exception: dit draait in een render.
 *
 * @returns {{grants: Array<{id: string, scope: 'own'|'all', columns: string[]|'*'}>, truncated: number}}
 *   `truncated` is het aantal grants dat de runtime NIET meer meeneemt.
 */
export function datatableGrantsOf(toolsConfig) {
    const empty = { grants: [], truncated: 0 };
    try {
        if (!isPlainObject(toolsConfig) || !isPlainObject(toolsConfig.datatables)) return empty;
        const allIds = Object.keys(toolsConfig.datatables).filter(id => !UNSAFE_OBJECT_KEYS.has(id));
        const ids = allIds.slice(0, MAX_DATATABLE_GRANTS);
        const grants = ids.map((id) => {
            const raw = toolsConfig.datatables[id];
            // Geen object ⇒ smalst mogelijk, net als de server: de tabel blijft
            // staan (het id is de leesbare helft) maar levert niets.
            if (!isPlainObject(raw)) return { id, scope: 'own', columns: [] };
            return {
                id,
                scope: DATATABLE_SCOPES.includes(raw.scope) ? raw.scope : 'own',
                columns: datatableColumnsOf(raw.columns),
            };
        });
        return { grants, truncated: allIds.length - ids.length };
    } catch (_) {
        // Een onleesbare sectie gunt niets — en zegt dat via READ.ERROR bij de
        // aanroeper, niet via een stille lege lijst hier.
        return empty;
    }
}

/**
 * Zet een lijst objecten om in een `Map` op id. Een lijst die geen lijst is
 * levert een LEGE map plus `false` — de aanroeper weet daarmee dat hij niets
 * heeft kunnen indexeren en mag dat niet als "er is niets" lezen.
 */
function indexById(list) {
    if (!Array.isArray(list)) return null;
    const map = new Map();
    for (const row of list) {
        const id = row && (row.id ?? row.ID);
        if (typeof id === 'string' && id) map.set(id, row);
    }
    return map;
}

/** Uniek, in volgorde, alleen niet-lege strings. */
function uniqueIds(ids) {
    const seen = new Set();
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * De kennisbankrijen: de gekoppelde ids van de agent, aangevuld met wat de
 * lijst uit `GET /api/kb?context=agent` erover weet.
 *
 * `documentCount` en `lastContentAt` staan op die route in SNAKE_CASE
 * (`decorateKbList` draait alleen op de detailroutes), dus beide spellingen
 * worden gelezen. Een ontbrekende teller wordt `null` en NOOIT 0: "nul
 * documenten" is een bewering over een kennisbank die je dan niet gemeten
 * hebt.
 *
 * @param {{ids: string[], kbs: Array|null, state: string}} p
 */
export function knowledgeBaseRows({ ids, kbs, state = READ.OK }) {
    const linked = uniqueIds(ids);
    const index = state === READ.OK ? indexById(kbs) : null;
    return linked.map((id) => {
        const kb = index ? index.get(id) : null;
        if (!kb) return { id, name: null, documentCount: null, lastContentAt: null, readable: false };
        return {
            id,
            name: typeof kb.name === 'string' && kb.name ? kb.name : null,
            documentCount: countOrNull(kb.documentCount ?? kb.document_count),
            lastContentAt: kb.lastContentAt ?? kb.last_content_at ?? null,
            readable: true,
        };
    });
}

/**
 * De tabelrijen: de grants uit de agentconfig, aangevuld met de naam uit
 * `GET /api/datatables` — een route die achter de automations-module hangt,
 * dus de naam ontbreekt geregeld terwijl de grant er wel degelijk is.
 *
 * @param {{toolsConfig: object|null, tables: Array|null, state: string}} p
 */
export function datatableRows({ toolsConfig, tables, state = READ.OK }) {
    const { grants, truncated } = datatableGrantsOf(toolsConfig);
    const index = state === READ.OK ? indexById(tables) : null;
    const rows = grants.map((g) => {
        const table = index ? index.get(g.id) : null;
        return {
            id: g.id,
            name: table && typeof table.name === 'string' && table.name ? table.name : null,
            scope: g.scope,
            columns: g.columns,
            // Geen kolommen = de runtime weigert deze tabel hardop. Dat is een
            // FEIT over de grant en staat los van of we de naam konden lezen.
            grantsNothing: Array.isArray(g.columns) && g.columns.length === 0,
            readable: !!table,
        };
    });
    return { rows, truncated };
}

/**
 * "ook gebruikt door k ANDERE agents".
 *
 * De samenvatting (`GET /api/skills/usage-summary`) telt élke agent die de
 * skill koppelt — deze erbij. `selfCounted` zegt of dat zo is; alleen dan gaat
 * er één af. Onbekend blijft `null`, want een teller die niet gelezen is mag
 * niet als 0 ("verder gebruikt niemand dit") gelezen worden.
 */
export function otherAgentUsers(count, selfCounted) {
    const n = countOrNull(count);
    if (n === null) return null;
    return Math.max(0, n - (selfCounted ? 1 : 0));
}

/**
 * De skillrijen: de gekoppelde ids, aangevuld met de skill zelf en met de
 * gebruikstelling.
 *
 * `steps` en `rulesV2` zijn `[]` zolang de eenmalige parse niet gelopen heeft
 * (skillStore.mapRow presenteert NULL als `[]`), dus 0 stappen is hier een
 * echte 0 en geen gemis. `usage` is een aparte lezing met een eigen toestand:
 * die kan mislukken terwijl de skills zelf prima gelezen zijn.
 *
 * @param {{ids: string[], skills: Array|null, state: string,
 *          usage: object|null, usageState: string,
 *          savedSkillIds: string[], agentSaved: boolean}} p
 */
export function skillRows({ ids, skills, state = READ.OK, usage, usageState = READ.OK, savedSkillIds, agentSaved = false }) {
    const attached = uniqueIds(ids);
    const index = state === READ.OK ? indexById(skills) : null;
    const saved = new Set(uniqueIds(savedSkillIds));
    const summary = usageState === READ.OK && isPlainObject(usage) ? usage : null;
    return attached.map((id) => {
        const skill = index ? index.get(id) : null;
        // De telling komt van de server en kent alleen de OPGESLAGEN config.
        // Een skill die je zojuist aanvinkte zit er nog niet in, dus telt hij
        // zichzelf ook niet mee — en dan mag er niets af.
        const selfCounted = agentSaved && saved.has(id);
        const entry = summary ? summary[id] : null;
        const others = summary ? otherAgentUsers(isPlainObject(entry) ? entry.agents : null, selfCounted) : null;
        if (!skill) {
            return { id, name: null, icon: null, stepCount: null, ruleCount: null, otherAgents: others, readable: false };
        }
        return {
            id,
            name: typeof skill.name === 'string' && skill.name ? skill.name : null,
            icon: typeof skill.icon === 'string' && skill.icon ? skill.icon : null,
            stepCount: Array.isArray(skill.steps) ? skill.steps.length : null,
            ruleCount: Array.isArray(skill.rulesV2) ? skill.rulesV2.length : null,
            otherAgents: others,
            readable: true,
        };
    });
}

/**
 * Mag de kaart "hier staat niets" zeggen?
 *
 * Alleen als élke bron gelezen ís én geen enkele rij opleverde. Eén bron die
 * nog laadt of stukging maakt het antwoord onbekend, en onbekend is geen leeg.
 */
export function isTrulyEmpty(states, rowCounts) {
    const allRead = (Array.isArray(states) ? states : []).every(s => s === READ.OK);
    const noRows = (Array.isArray(rowCounts) ? rowCounts : []).every(n => n === 0);
    return allRead && noRows;
}

/** Heeft minstens één van deze bronnen gefaald? */
export function anyFailed(states) {
    return (Array.isArray(states) ? states : []).some(s => s === READ.ERROR);
}
