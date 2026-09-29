/**
 * What is in a Blueprint, and what the person installing it will have to
 * supply — read off the file itself, before anything is created.
 *
 * ── Why this is read on the client at all ─────────────────────────────────
 *
 * The server answers the same question, but only in the install REPORT, which
 * arrives after the Solution exists. A wizard that asks "which table should
 * this step use?" has to ask BEFORE the install, so the only copy of the file
 * available at that moment is the one in the browser.
 *
 * Two consequences worth knowing:
 *
 *   1. This is the SHOWING half; projects/packaging/install.js is the DECIDING
 *      half. Nothing here is a permission check and nothing here is trusted by
 *      the server — a body this module produced still goes through
 *      projects/packaging/resolutions.js, which drops anything it does not
 *      recognise. If the two ever disagree about what a file asks for, the
 *      server wins, and the post-install report it returns lists the grants it
 *      refused whether or not this module spotted them.
 *   2. It reads the RAW file. `sanitizeManifest` strips every `ai.public*` key
 *      and every `fixedArgs` server-side, so by the time the server sees a
 *      manifest those requests are gone — and showing what was asked for is
 *      the entire reason the Connect step exists. `fixedArgs` VALUES are never
 *      carried out of here for the same reason the server does not echo them:
 *      they can hold a path, an id or a token.
 *
 * ── What counts as "the installer has to supply this" ─────────────────────
 *
 * Each of the three is a hole scrub.js left, recognisable by its exact shape:
 *
 *   table       a `datatable` step with an EMPTY `datatableId` — scrub blanks
 *               the id and leaves the author's own `datatableKey` standing.
 *               Only for keys this Blueprint does not bring a table for: a
 *               Solution that ships its own "invoices" table needs nothing.
 *   connection  an `http_request` step whose `auth` is exactly `null`. That is
 *               what scrub writes when it removes a credential; a step that
 *               never had one has no `auth` key at all, so the two are
 *               distinguishable and only the first is asked about.
 *   approver    an `approval` step with none of the four seat fields set.
 *               Advisory rather than blocking — an unseated approval means the
 *               routine's owner decides — so the row says so rather than
 *               demanding a pick.
 *
 * No English sentences leave this module: every row is data, and the modal
 * renders it through `t()`. A helper that returned prose would put copy in a
 * place no translator can reach.
 */

const ENTITY_KINDS = ['automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases'];

/** The sentinel a table row uses for "make me an empty one". */
export const CREATE_EMPTY = '__create_empty__';

/** Hoe lang een bewering uit een bestand mag zijn voor hij wordt afgekapt. */
const MAX_CLAIM_CHARS = 200;

/**
 * Wat het bestand over zijn eigen herkomst BEWEERT.
 *
 * ── Waarom dit een eigen functie is, en niet `manifest.source` ────────────
 *
 * Dit is invoer van buiten: het bestand komt van de schijf van de installateur
 * en iedereen met een teksteditor kan er in zetten wat hij wil. Drie regels
 * gelden daarom hier, en ze hebben allemaal met TONEN te maken — beslissen doet
 * dit scherm niets:
 *
 *   1. GEEN TOEGANG. `orgId` en `orgName` geven nergens recht op. De server
 *      beslist met blueprintStore.canRead over de ECHTE galerijrij; wat hier
 *      staat raakt die vraag niet aan (server/projects/packaging/install.js,
 *      `provenanceOf`).
 *   2. EEN NAAM UIT EEN BESTAND IS EEN BEWERING. De wizard zet er de zin
 *      "dit bestand zégt…" omheen, nooit een kale afzender — anders leest
 *      andermans naam als een vastgesteld feit.
 *   3. ALLEEN STRINGS, EN BEGRENSD. Een object, een array of een naam van
 *      tienduizend tekens wordt hier null of afgekapt, zodat de rest van dit
 *      scherm nooit iets anders dan tekst in handen krijgt.
 *
 * Dezelfde normalisatie als `readSource` op de server, en met opzet niet
 * gedeeld: dit is de TONENDE helft, en zij mag nooit de indruk wekken dat het
 * scherm de bewering ergens voor gebruikt.
 */
function readSourceClaim(manifest) {
    const raw = isObject(manifest) && isObject(manifest.source) ? manifest.source : {};
    const text = (v) => {
        if (typeof v !== 'string') return null;
        const trimmed = v.trim();
        return trimmed ? trimmed.slice(0, MAX_CLAIM_CHARS) : null;
    };
    const version = Number(raw.version);
    return {
        blueprintId: text(raw.blueprintId),
        orgId: text(raw.orgId),
        orgName: text(raw.orgName),
        version: Number.isInteger(version) && version > 0 ? version : null,
    };
}

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function list(v) {
    return Array.isArray(v) ? v : [];
}

/**
 * Every step of every graph in a definition, with its flowlet key.
 *
 * The browser twin of automation/portability.walkAllSteps. Deliberately not
 * shared: the server's walker also visits triggers and owns the nesting rules,
 * and all a wizard needs is "which steps, in which graph". Anything it misses
 * shows up in the post-install report rather than silently changing what
 * installs.
 */
function walkSteps(steps, layerKey, visit) {
    for (const step of list(steps)) {
        if (!isObject(step)) continue;
        visit(step, layerKey);
        if (Array.isArray(step.body)) walkSteps(step.body, layerKey, visit);
        if (Array.isArray(step.branches)) for (const branch of step.branches) walkSteps(branch, layerKey, visit);
        if (isObject(step.cases)) for (const branch of Object.values(step.cases)) walkSteps(branch, layerKey, visit);
    }
}

function walkDefinition(definition, visit) {
    if (!isObject(definition)) return;
    walkSteps(definition.steps, null, visit);
    if (!isObject(definition.layers)) return;
    for (const [key, layer] of Object.entries(definition.layers)) {
        if (isObject(layer)) walkSteps(layer.steps, key, visit);
    }
}

/**
 * A step's address inside one bundled routine, for keying the wizard's state.
 *
 * Only ever used as a lookup key — never parsed back apart. A ref, a flowlet
 * key or a step id from a hand-made file can contain anything at all, and a
 * resolution that pointed at the wrong step because a name held a separator
 * would be the worst kind of wrong. `buildResolutions` therefore reads the ROW
 * for the ids and uses this only to find the answer.
 */
export function addressOf(ref, stepId, layerKey) {
    return JSON.stringify([ref, layerKey || null, stepId]);
}

/**
 * What the file asks each PAGE to be allowed to do.
 *
 * The browser twin of install.js `collectGrantRequires`, and the same three
 * kinds for the same reasons. An install grants none of them: a bridge runs as
 * the page's author, who after an install is whoever pressed the button, so a
 * tool name in a file is a request for authority over their account.
 *
 * `integration` is the only kind the wizard can hand back, and only through the
 * page's own grants route once the page exists. The other two are shown and not
 * offered: an automation id from another installation names nothing here, and
 * public AI has no route but the page's own AI chat.
 */
function collectGrantRows(entities) {
    const declared = new Set();
    for (const kind of ENTITY_KINDS) {
        for (const entity of list(entities[kind])) {
            if (isObject(entity) && typeof entity.ref === 'string') declared.add(entity.ref);
        }
    }

    const rows = [];
    for (const page of list(entities.webpages)) {
        if (!isObject(page)) continue;
        const asked = isObject(page.bridgeGrants) ? page.bridgeGrants : {};
        const on = {
            ref: typeof page.ref === 'string' ? page.ref : null,
            name: typeof page.name === 'string' ? page.name : '',
        };

        for (const grant of list(asked.integrations)) {
            // The tool NAME travels and nothing else. `fixedArgs` can hold a
            // path, an id or a token, and a row that displayed them would put
            // them back on a screen.
            if (isObject(grant) && typeof grant.tool === 'string' && grant.tool) {
                rows.push({ ...on, kind: 'integration', tool: grant.tool });
            }
        }

        for (const grant of list(asked.automations)) {
            const pointer = isObject(grant) ? grant.automationId : null;
            const ref = isObject(pointer) && typeof pointer.$ref === 'string' ? pointer.$ref : null;
            // An in-bundle reference is the one thing install DOES carry, so
            // listing it would ask somebody to grant what they already have.
            if (ref && declared.has(ref)) continue;
            rows.push({ ...on, kind: 'automation' });
        }

        const ai = isObject(asked.ai) ? asked.ai : null;
        // Matched by SHAPE, like the server's stripNeverInstallable: a
        // `publicSomethingNew` invented next year is shown by the rule written
        // before it existed.
        if (ai && Object.entries(ai).some(([k, v]) => /^public/.test(k) && v === true)) {
            const flags = {};
            for (const [k, v] of Object.entries(ai)) if (/^public/.test(k)) flags[k] = v;
            rows.push({ ...on, kind: 'public_ai', flags });
        }
    }
    return rows;
}

/**
 * Read a manifest into everything the three wizard steps show.
 *
 * `ok: false` is the answer for anything that is not a Blueprint, and it stays
 * distinguishable from an empty one — a file with no entities is a real (if
 * pointless) Blueprint; a `.json` of holiday photos is not.
 */
export function readBlueprint(manifest) {
    const solution = isObject(manifest) && isObject(manifest.solution) ? manifest.solution : null;
    if (!solution) return { ok: false };

    const entities = isObject(solution.entities) ? solution.entities : {};
    // Counted off the entities rather than read from `solution.report.counts`.
    // The report is the exporter's CLAIM about the file; the entity arrays are
    // the file. Where a hand-made Blueprint carries one and not the other, the
    // wizard describes what will actually install.
    const counts = {};
    for (const kind of ENTITY_KINDS) counts[kind] = list(entities[kind]).length;

    const bundledTableKeys = new Set(
        list(entities.datatables)
            .map(t => (isObject(t) && typeof t.key === 'string' ? t.key.trim() : ''))
            .filter(Boolean),
    );

    const tables = new Map();
    const connections = [];
    const approvers = [];

    for (const entity of list(entities.automations)) {
        if (!isObject(entity) || typeof entity.ref !== 'string') continue;
        const title = typeof entity.title === 'string' ? entity.title : '';
        walkDefinition(entity.definition, (step, layerKey) => {
            const stepId = typeof step.id === 'string' ? step.id : '';
            if (!stepId) return;
            const where = { ref: entity.ref, title, stepId, layerKey: layerKey || null };

            if (step.type === 'datatable' && !step.datatableId) {
                const key = typeof step.datatableKey === 'string' ? step.datatableKey.trim() : '';
                // No key means no useful question to ask — "pick a table" with
                // nothing to say which one. The install report names that step
                // instead, and it is opened by hand.
                if (!key || bundledTableKeys.has(key)) return;
                if (!tables.has(key)) tables.set(key, { key, steps: [] });
                tables.get(key).steps.push(where);
                return;
            }
            if (step.type === 'http_request' && step.auth === null) {
                connections.push(where);
                return;
            }
            if (step.type === 'approval' && isObject(step.approval)) {
                const seated = ['assignee', 'approvers', 'escalateTo', 'finalApprover']
                    .some(f => step.approval[f] !== undefined && step.approval[f] !== null);
                if (!seated) approvers.push(where);
            }
        });
    }

    return {
        ok: true,
        name: typeof solution.name === 'string' ? solution.name : '',
        description: typeof solution.description === 'string' ? solution.description : '',
        version: Number.isInteger(solution.version) ? solution.version : 1,
        counts,
        // The exporter's own list of what a Blueprint does NOT carry. Shown
        // verbatim: it is the most valuable thing on the export screen, and it
        // is worth exactly as much to whoever is about to install.
        notCarried: list(solution.report?.warnings).filter(w => typeof w === 'string'),
        // Wat het BESTAND over zijn eigen herkomst zegt. Een bewering, en het
        // scherm toont hem als bewering — zie readSourceClaim.
        source: readSourceClaim(manifest),
        requires: { tables: [...tables.values()], connections, approvers },
        grants: collectGrantRows(entities),
    };
}

/**
 * Turn the wizard's answers into the body `POST /package/install` takes.
 *
 * Only complete answers travel. A half-filled row is the same as no answer:
 * the server drops it anyway (resolutions.js rebuilds every row from a fixed
 * key set), and sending it would make the request look like a decision nobody
 * made.
 *
 * Driven by the REQUIREMENT ROWS rather than by the answer map, so an answer
 * left over from a file the user then swapped out cannot travel with the next
 * one.
 */
export function buildResolutions(requires, { tables = {}, connections = {}, approvers = {} } = {}) {
    const out = { tables: [], connections: [], approvers: [] };

    for (const row of list(requires?.tables)) {
        const choice = tables[row.key];
        if (choice === CREATE_EMPTY) out.tables.push({ key: row.key, create: true });
        else if (typeof choice === 'string' && choice) out.tables.push({ key: row.key, datatableId: choice });
    }

    for (const row of list(requires?.connections)) {
        const connectionId = connections[addressOf(row.ref, row.stepId, row.layerKey)];
        if (typeof connectionId !== 'string' || !connectionId) continue;
        out.connections.push({
            ref: row.ref, stepId: row.stepId, layerKey: row.layerKey, connectionId,
        });
    }

    for (const row of list(requires?.approvers)) {
        const choice = approvers[addressOf(row.ref, row.stepId, row.layerKey)];
        if (typeof choice !== 'string' || !choice.includes(':')) continue;
        const kind = choice.slice(0, choice.indexOf(':'));
        const id = choice.slice(choice.indexOf(':') + 1);
        if (!id || (kind !== 'user' && kind !== 'group')) continue;
        out.approvers.push({
            ref: row.ref, stepId: row.stepId, layerKey: row.layerKey,
            seat: kind === 'user' ? { userId: id } : { groupId: id },
        });
    }

    return out;
}
