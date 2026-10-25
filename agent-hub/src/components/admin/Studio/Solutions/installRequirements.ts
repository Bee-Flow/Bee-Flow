import type { StepAddress, TableRequirement, BlueprintRequires, SourceClaim, GrantRow, BlueprintReadOk, BlueprintReadNone, BlueprintRead, InstallAnswers, Obj, StepVisitor } from './installRequirements.types';
export type { StepAddress, TableRequirement, BlueprintRequires, SourceClaim, GrantRow, BlueprintReadOk,  BlueprintRead, InstallAnswers } from './installRequirements.types';
const ENTITY_KINDS = ['automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases'];

/** The sentinel a table row uses for "make me an empty one". */
export const CREATE_EMPTY = '__create_empty__';

/** How long a claim from a file may be before it is truncated. */
const MAX_CLAIM_CHARS = 200;

/**
 * What the file CLAIMS about its own origin.
 *
 * ── Why this is its own function, and not `manifest.source` ────────────
 *
 * This is input from outside: the file comes from the installer's disk, and anyone
 * with a text editor can put in whatever they want. Three rules therefore apply
 * here, and they all have to do with DISPLAY — deciding is not something this
 * screen does:
 *
 *   1. NO ACCESS. `orgId` and `orgName` grant nothing. The server decides with
 *      blueprintStore.canRead on the REAL gallery row; what is here does not touch
 *      that question (server/projects/packaging/install.js, `provenanceOf`).
 *   2. A NAME FROM A FILE IS A CLAIM. The wizard wraps it in the sentence “this file
 *      claims…”, never a bare sender — otherwise another person's name reads as an
 *      established fact.
 *   3. STRINGS ONLY, AND BOUNDED. An object, an array or a name of ten thousand
 *      characters becomes null or is truncated here, so that the rest of this screen
 *      never receives anything but text.
 *
 * The same normalisation as `readSource` on the server, and deliberately not shared:
 * this is the DISPLAYING half, and it must never give the impression that the screen
 * uses the claim for anything.
 */
function readSourceClaim(manifest: unknown): SourceClaim {
    const raw: Obj = isObject(manifest) && isObject(manifest.source) ? manifest.source : {};
    const text = (v: unknown) => {
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

function isObject(v: unknown): v is Obj {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function list(v: unknown) {
    return Array.isArray(v) ? v : [];
}

function walkSteps(steps: unknown, layerKey: string | null, visit: StepVisitor) {
    for (const step of list(steps)) {
        if (!isObject(step)) continue;
        visit(step, layerKey);
        if (Array.isArray(step.body)) walkSteps(step.body, layerKey, visit);
        if (Array.isArray(step.branches)) for (const branch of step.branches) walkSteps(branch, layerKey, visit);
        if (isObject(step.cases)) for (const branch of Object.values(step.cases)) walkSteps(branch, layerKey, visit);
    }
}

function walkDefinition(definition: unknown, visit: StepVisitor) {
    if (!isObject(definition)) return;
    walkSteps(definition.steps, null, visit);
    if (!isObject(definition.layers)) return;
    for (const [key, layer] of Object.entries(definition.layers)) {
        if (isObject(layer)) walkSteps(layer.steps, key, visit);
    }
}

/**
 * A step's address inside one bundled automation, for keying the wizard's state.
 *
 * Only ever used as a lookup key — never parsed back apart. A ref, a flowlet
 * key or a step id from a hand-made file can contain anything at all, and a
 * resolution that pointed at the wrong step because a name held a separator
 * would be the worst kind of wrong. `buildResolutions` therefore reads the ROW
 * for the ids and uses this only to find the answer.
 */
export function addressOf(ref: unknown, stepId: string, layerKey: string | null) {
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
function collectGrantRows(entities: Obj): GrantRow[] {
    const declared = new Set<string>();
    for (const kind of ENTITY_KINDS) {
        for (const entity of list(entities[kind])) {
            if (isObject(entity) && typeof entity.ref === 'string') declared.add(entity.ref);
        }
    }

    const rows: GrantRow[] = [];
    for (const page of list(entities.webpages)) {
        if (!isObject(page)) continue;
        const asked: Obj = isObject(page.bridgeGrants) ? page.bridgeGrants : {};
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
            const flags: Obj = {};
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
export function readBlueprint(manifest: unknown): BlueprintRead {
    const solution = isObject(manifest) && isObject(manifest.solution) ? manifest.solution : null;
    if (!solution) return { ok: false };

    const entities: Obj = isObject(solution.entities) ? solution.entities : {};
    // Counted off the entities rather than read from `solution.report.counts`.
    // The report is the exporter's CLAIM about the file; the entity arrays are
    // the file. Where a hand-made Blueprint carries one and not the other, the
    // wizard describes what will actually install.
    const counts: Record<string, number> = {};
    for (const kind of ENTITY_KINDS) counts[kind] = list(entities[kind]).length;

    const bundledTableKeys = new Set(
        list(entities.datatables)
            .map(t => (isObject(t) && typeof t.key === 'string' ? t.key.trim() : ''))
            .filter(Boolean),
    );

    const tables = new Map<string, TableRequirement>();
    const connections: StepAddress[] = [];
    const approvers: StepAddress[] = [];

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
                (tables.get(key) as TableRequirement).steps.push(where);
                return;
            }
            if (step.type === 'http_request' && step.auth === null) {
                connections.push(where);
                return;
            }
            if (step.type === 'approval' && isObject(step.approval)) {
                const seated = ['assignee', 'approvers', 'escalateTo', 'finalApprover']
                    .some(f => (step.approval as Obj)[f] !== undefined && (step.approval as Obj)[f] !== null);
                if (!seated) approvers.push(where);
            }
        });
    }

    return {
        ok: true,
        name: typeof solution.name === 'string' ? solution.name : '',
        description: typeof solution.description === 'string' ? solution.description : '',
        version: Number.isInteger(solution.version) ? solution.version as number : 1,
        counts,
        // The exporter's own list of what a Blueprint does NOT carry. Shown
        // verbatim: it is the most valuable thing on the export screen, and it
        // is worth exactly as much to whoever is about to install.
        notCarried: list((solution.report as Obj | undefined)?.warnings).filter(w => typeof w === 'string'),
        // What the FILE says about its own origin. A claim, and the screen shows it as a
        // claim — see readSourceClaim.
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
export function buildResolutions(requires: BlueprintRequires | undefined, { tables = {}, connections = {}, approvers = {} }: InstallAnswers = {}) {
    const out: {
        tables: Array<{ key: string; create: true } | { key: string; datatableId: string }>;
        connections: Array<{ ref: unknown; stepId: string; layerKey: string | null; connectionId: string }>;
        approvers: Array<{ ref: unknown; stepId: string; layerKey: string | null; seat: { userId: string } | { groupId: string } }>;
    } = { tables: [], connections: [], approvers: [] };

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
