/**
 * Pure helpers for the "preserve & patch" refine flow. No React — unit-testable
 * in isolation.
 *
 *   buildRefineContext(state) → { plan, current }
 *     The request payload the editor sends to POST /agents/wizard/refine. `plan`
 *     is the editable text surface the AI rewrites — including the four
 *     descriptive `persona` fields, so a refine can patch the role instead of
 *     re-inventing it; `current` is the curated configuration the server is
 *     told to preserve.
 *
 *   personaFieldsOf(persona) → { who, tone, does, doesNot } | null
 *   hasFreeInstruction(state) → boolean
 *     The two questions the persona half of the merge turns on. See each.
 *
 *   diffRefinedPlan(before, after) → changes[]
 *     Wat de verfijning FEITELIJK veranderde: de diff tussen de staat vóór de
 *     merge en de snapshot die eruit kwam. Zie de docblock bij de functie.
 *
 *   mergeRefinedPlan(current, updated, preserved, opts) → { name, description,
 *     systemPrompt, avatar, model, config, persona }
 *     Deterministically folds the AI's plan into the agent's current state so a
 *     tone-only refine NEVER wipes curated apps/skills/model/KBs.
 *
 * Golden rule: absent/empty field ⇒ keep current. Curated collections
 * (apps, skills, knowledge bases) are additive on refine — refine can add to
 * them but never silently empties them; removals are done manually in the editor.
 */

/**
 * De vier BESCHRIJVENDE persona-velden van een persona-object, of `null`.
 *
 * Dit is de vorm die met het plan meereist — heen (zodat een verfijning de rol
 * die er staat kan behouden in plaats van hem opnieuw te verzinnen) en terug
 * (het model vult ze in). `unknown`, `language`, `mode` en `freeText` gaan
 * NOOIT mee: `unknown` heeft gevolgen in de config (strenge kennis, een app,
 * een routine-grant) en `language`/`mode`/`freeText` zijn van de editor, niet
 * van het model. Een plan is een voorstel, geen grant.
 *
 * `null` betekent "hier staat geen rol" en dat is een echt antwoord: de
 * callers vallen daarop terug op de prozatekst als bron.
 */
export function personaFieldsOf(persona) {
    if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return null;
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
    const tone = persona.tone && typeof persona.tone === 'object' ? persona.tone : {};
    const fields = {
        who: str(persona.who),
        tone: { chips: list(tone.chips), text: str(tone.text) },
        does: list(persona.does),
        doesNot: list(persona.doesNot),
    };
    const hasContent = !!(fields.who || fields.does.length || fields.doesNot.length
        || fields.tone.chips.length || fields.tone.text);
    return hasContent ? fields : null;
}

/**
 * Heeft deze agent AL een vrije instructie — tekst die iemand zelf schreef en
 * die de bron van zijn gedrag is?
 *
 * De vraag beslist of de wizard de EERSTE versie in de velden mag zetten. Twee
 * bronnen, en de smalle lezing wint:
 *
 *   - staat de persona in `fields`-modus, dan is er per definitie geen vrije
 *     instructie (`freeText` wordt in die modus niet bewaard) — het prompt dat
 *     de editor toont is dan de RENDERING van die velden, geen eigen tekst;
 *   - anders telt elke niet-lege `freeText` én elk niet-leeg `systemPrompt`.
 *
 * `systemPrompt` is bewust de doorslaggevende terugval voor een agent van wie
 * we de persona niet kennen (de kolom is niet gelezen, of hij bestond nog niet
 * toen de agent gemaakt werd): `agents.system_prompt` IS de rendering van de
 * persona, dus een agent met een leeg prompt heeft niets te verliezen, en een
 * agent met tekst erin wel — ook als we niet kunnen zien waar die vandaan komt.
 */
export function hasFreeInstruction(state = {}) {
    const persona = state.persona;
    if (persona && typeof persona === 'object' && persona.mode === 'fields') return false;
    const freeText = persona && typeof persona === 'object' && typeof persona.freeText === 'string'
        ? persona.freeText : '';
    return !!(freeText.trim() || String(state.systemPrompt || '').trim());
}

/** Build the { plan, current } portions of the refine request from live state. */
export function buildRefineContext(state = {}) {
    const {
        name, description, avatar, systemPrompt, capabilities,
        model, enabledIntegrations, attachedSkills, knowledge_base_ids, persona,
    } = state;
    const personaFields = personaFieldsOf(persona);
    return {
        plan: {
            name: name || '',
            description: description || '',
            avatar: avatar || '',
            systemPrompt: systemPrompt || '',
            capabilities: Array.isArray(capabilities) ? capabilities : [],
            // Alleen meesturen als er echt een rol staat. Een leeg blok zou het
            // model vertellen dat deze agent er een heeft die leeg is, en dan
            // is "behouden tenzij gevraagd" een instructie om niets te schrijven.
            ...(personaFields ? { persona: personaFields } : {}),
        },
        current: {
            // Full model string (e.g. "tier:thinking" / a custom tier) — the
            // server echoes it back verbatim in `preserved.model`.
            model: typeof model === 'string' ? model : null,
            enabledIntegrations: Array.isArray(enabledIntegrations) ? enabledIntegrations : [],
            // [{ id, name }] so the model can reuse skills by id.
            attachedSkills: Array.isArray(attachedSkills) ? attachedSkills : [],
            knowledge_base_ids: Array.isArray(knowledge_base_ids) ? knowledge_base_ids : [],
        },
    };
}

const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

/**
 * The persona (A1c) after a refine.
 *
 * Persona is the SOURCE of the system prompt on the server, so the two may
 * never drift: a refine that rewrites the prompt and leaves the persona
 * untouched leaves the fields describing instructions the agent no longer has,
 * and the next save would render the OLD fields straight back over the new
 * prompt.
 *
 * Three cases now, and the golden rule ("absent ⇒ keep") decides the first two:
 *
 *   the prompt did NOT change → keep the current persona verbatim, including
 *   `undefined` (the PUT then omits the field and the server preserves the
 *   column). A tone-only refine must not rewrite a persona the user built by
 *   hand.
 *
 *   the prompt DID change on an agent that ALREADY HAS A FREE INSTRUCTION →
 *   free mode over the refined prompt, exactly as before. This is the guard
 *   that matters: someone who writes their own instructions must never find
 *   them replaced by five fields because a refine ran. Their text stays the
 *   source; the fields keep describing it.
 *
 *   the prompt DID change on an agent WITHOUT one — the wizard's first version
 *   out of one sentence — → the FIELDS become the source (A3). This is the
 *   whole point of the Role tab: five cards you can edit. An agent born in free
 *   mode opens them read-only, and since the wizard is how nearly every agent
 *   is born, that would make Role a read-only screen for the whole product.
 *   Nothing is thrown away doing it, because the fields are not guessed from
 *   `description` + `capabilities` any more: the plan schema asks the model for
 *   `who`/`tone`/`does`/`doesNot` and this writes what it wrote. When the plan
 *   carries no role (an older server, a model that skipped the block) there is
 *   nothing to be the source, so free mode is what happens.
 *
 * Either way the SETTINGS a refine says nothing about ("when you do not know",
 * language) are carried over rather than reset. The server re-normalises all of
 * it; this only has to be honest.
 *
 * ── EEN ONLEESBARE PERSONA SCHRIJFT NIET ───────────────────────────────────
 *
 * `undefined` in de kolom betekent hier "niet gelezen", niet "leeg": de
 * lijstroute STRIPT `persona` (`agentCrud._stripPersona`), dus alles hangt aan
 * de extra `GET /agents/:id?draft=1`, en die kan 403'en of omvallen. Op zo'n
 * antwoord bouwde deze functie vroeger een VERSE persona in vrije modus — over
 * een agent die in de kolom `{mode:'fields', unknown:{mode:'handoff',
 * automationId:'auto-1'}, language:'nl'}` kan hebben staan. Die twee
 * instellingen heeft deze code nooit gelezen en zou ze dus weggooien, waarna de
 * server ze terugvult op 'honest'/null: de doorgeef-routine en de taalregel
 * stil verdwenen, en de vijf rolkaarten alleen-lezen. Onbekend versmalt naar
 * `undefined` — de PUT laat het veld dan weg en de kolom blijft staan.
 *
 * ── EEN VERFIJNING MAG OOK IETS WEGHALEN ───────────────────────────────────
 *
 * "Absent/leeg ⇒ behouden" was ongevaarlijk toen het prompt de bron was. Nu de
 * VELDEN de bron zijn, betekende het dat een verfijning een regel niet meer kon
 * WEGHALEN: het model haalt "nooit geld terug beloven" netjes uit `doesNot` én
 * uit het prompt, de Gedaan-kaart meldt gewijzigde instructies, en de server
 * rendert de regel uit de bewaarde `doesNot` gewoon terug in het prompt. Dus:
 * dráágt het plan een rolblok, dan zijn `does`, `doesNot` en `tone` van dat
 * blok — leeg inbegrepen. Draagt het er geen (een oudere server, een model dat
 * het blok oversloeg), dan geldt "behouden" nog steeds, want dan is er niets
 * gezegd.
 *
 * `who` is de uitzondering en blijft terugvallen: het is één veld, een model
 * dat het leeg laat heeft het vrijwel altijd overgeslagen, en een lege `who`
 * over een gevulde heenschrijven is niet wat "bijstellen" betekent.
 */
function personaAfterRefine(current, { systemPrompt, description, capabilities, planPersona }) {
    const cur = current.persona;
    if (systemPrompt === current.systemPrompt) return cur;
    const readable = !!cur && typeof cur === 'object' && !Array.isArray(cur);
    // ONBEKEND SCHRIJFT NIET, en `noStoredPersona` is de enige uitzondering:
    // die zegt dat er nog geen RIJ is (de wizard maakt hem pas bij de eerste
    // opslag aan), dus er is geen kolom om te beschermen en dit IS de eerste
    // versie. De vlag staat standaard uit: wie hem vergeet krijgt de smalle
    // uitkomst, niet de destructieve.
    if (!readable && current.noStoredPersona !== true) return undefined;
    const base = readable ? cur : {};
    const fields = personaFieldsOf(planPersona);
    const described = fields
        ? {
            ...base,
            who: fields.who || base.who || '',
            does: fields.does,
            doesNot: fields.doesNot,
            tone: fields.tone,
        }
        : {
            ...base,
            who: description || base.who || '',
            does: (Array.isArray(capabilities) && capabilities.length ? capabilities : (base.does || [])),
        };
    if (fields && !hasFreeInstruction(current)) {
        // Fields mode drops freeText on the server; sending '' says the same
        // thing here, so nothing downstream reads a stale second copy.
        return { ...described, mode: 'fields', freeText: '' };
    }
    return { ...described, mode: 'free', freeText: systemPrompt || '' };
}

/**
 * @param {object} current  { name, description, systemPrompt, avatar, model,
 *   config:{ enabledIntegrations, attachedSkillIds, knowledge_base_ids, wizard },
 *   persona, noStoredPersona }
 *   `persona` is wat er in de kolom staat; onleesbaar/afwezig betekent "niet
 *   gelezen" en laat de kolom met rust. `noStoredPersona: true` is het enige
 *   antwoord dat zegt dat er nog geen rij is — zie personaAfterRefine.
 * @param {object} updated  the normalized AI plan
 * @param {object} preserved the server's echo of the current curated config
 * @param {object} opts     { availableIntegrationIds, selectableTierKeys, resolvedSkillIds }
 */
export function mergeRefinedPlan(current = {}, updated = {}, preserved = {}, opts = {}) {
    const {
        availableIntegrationIds = [],
        selectableTierKeys = [],
        resolvedSkillIds = null, // caller's already-unioned skill ids (current ∪ reused ∪ created)
    } = opts;
    const curConfig = current.config || {};

    // ── name / avatar — take the AI value only when it provided a real one ──
    const name = (typeof updated.name === 'string' && updated.name.trim()) ? updated.name : current.name;
    const avatar = updated.avatar || current.avatar;

    // ── description / systemPrompt — the patch targets ──
    const description = (typeof updated.description === 'string') ? updated.description : current.description;
    const systemPrompt = (typeof updated.systemPrompt === 'string' && updated.systemPrompt.trim())
        ? updated.systemPrompt
        : current.systemPrompt;

    // ── model — apply the AI's tier ONLY if it maps to a real, selectable tier;
    // otherwise keep the current tier. Never blank the model. (preserved.model
    // already equals current.model.) ──
    let model = current.model;
    if (typeof updated.model === 'string' && updated.model) {
        const tierName = updated.model === 'smart' ? 'thinking' : updated.model;
        if (selectableTierKeys.includes(tierName)) model = `tier:${tierName}`;
    }

    // ── enabledIntegrations — replace only with a NON-EMPTY AI array (handles
    // add & remove intent); an empty/absent array means "AI didn't touch apps"
    // → preserve. This is what stops a tone refine from wiping curated apps. ──
    const curApps = Array.isArray(preserved.enabledIntegrations) && preserved.enabledIntegrations.length
        ? preserved.enabledIntegrations
        : (Array.isArray(curConfig.enabledIntegrations) ? curConfig.enabledIntegrations : []);
    let enabledIntegrations = curApps;
    if (Array.isArray(updated.enabledIntegrations) && updated.enabledIntegrations.length) {
        enabledIntegrations = updated.enabledIntegrations.filter(id => availableIntegrationIds.includes(id));
    }

    // ── skills — UNION, never subtract. resolvedSkillIds is the caller's fully
    // resolved set; fall back to current when the refine touched no skills. ──
    const attachedSkillIds = Array.isArray(resolvedSkillIds)
        ? uniq(resolvedSkillIds)
        : (Array.isArray(curConfig.attachedSkillIds) ? curConfig.attachedSkillIds : []);

    // ── knowledge_base_ids — replace only with a NON-EMPTY AI array; else
    // preserve (refines almost never edit KBs and the model often omits them). ──
    const curKbs = Array.isArray(preserved.knowledge_base_ids) && preserved.knowledge_base_ids.length
        ? preserved.knowledge_base_ids
        : (Array.isArray(curConfig.knowledge_base_ids) ? curConfig.knowledge_base_ids : []);
    let knowledge_base_ids = curKbs;
    if (Array.isArray(updated.knowledge_base_ids) && updated.knowledge_base_ids.length) {
        knowledge_base_ids = updated.knowledge_base_ids;
    }

    const config = {
        ...curConfig,
        enabledIntegrations,
        attachedSkillIds,
        knowledge_base_ids,
        wizard: {
            ...(curConfig.wizard || {}),
            capabilities: Array.isArray(updated.capabilities) ? updated.capabilities : (curConfig.wizard?.capabilities || []),
        },
    };

    const persona = personaAfterRefine(current, {
        systemPrompt,
        description,
        capabilities: config.wizard.capabilities,
        planPersona: updated.persona,
    });

    return { name, description, systemPrompt, avatar, model, config, persona };
}

/**
 * De diff tussen de staat VÓÓR de merge en de snapshot die mergeRefinedPlan
 * teruggaf — de "Gedaan: …"-beurt in de verfijn-rail.
 *
 * Waarom hier en niet op de server: de server rekent de merge niet uit. Zijn
 * antwoord is een PLAN plus een echo van de bewaarde config; welke velden er
 * daadwerkelijk veranderen beslist `mergeRefinedPlan` hier, met zijn
 * preserve-regels ("leeg ⇒ behouden", "skills alleen unie"). Een changes[]
 * van de server zou dus vertellen wat het model wilde, niet wat er gebeurde —
 * en precies daar zit het verschil dat de gebruiker moet lezen.
 *
 * De vorm is bewust DATA, geen zin: `{ field, direction?, count?, ids? }`. De
 * rail kiest er zijn sleutel bij (enkelvoud/meervoud), zodat de vertaling een
 * sleutelkeuze blijft en geen samengeplakte Engelse grammatica.
 *
 * Wat er NIET in staat: `persona` (die volgt per definitie de instructies —
 * hem apart noemen zou dezelfde verandering twee keer melden) en
 * `wizard.capabilities` (intern; de gebruiker ziet er geen veld voor).
 */
export function diffRefinedPlan(before = {}, after = {}) {
    const changes = [];
    const text = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
    for (const field of ['systemPrompt', 'name', 'description', 'avatar', 'model']) {
        if (text(before[field]) !== text(after[field])) changes.push({ field });
    }
    const beforeCfg = before.config || {};
    const afterCfg = after.config || {};
    for (const [field, key] of [
        ['apps', 'enabledIntegrations'],
        ['skills', 'attachedSkillIds'],
        ['knowledge', 'knowledge_base_ids'],
    ]) {
        const was = Array.isArray(beforeCfg[key]) ? beforeCfg[key] : [];
        const now = Array.isArray(afterCfg[key]) ? afterCfg[key] : [];
        const added = now.filter(id => !was.includes(id));
        const removed = was.filter(id => !now.includes(id));
        if (added.length) changes.push({ field, direction: 'added', count: added.length, ids: added });
        if (removed.length) changes.push({ field, direction: 'removed', count: removed.length, ids: removed });

    }
    return changes;
}
