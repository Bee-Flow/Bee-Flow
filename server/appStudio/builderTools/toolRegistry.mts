/**
 * App Studio builder: the registry of AI builder tools added after the base menu.
 *
 * One CommonJS file per tool, `builderTools/tools/<name>.js`, found by a sorted directory read
 * (componentSpecs/registryDir.js) and exporting
 *
 *   { name, since, description, schema, apply, mutating, dataModel?, core: false, mcp, verb }
 *
 *   name         the tool name; equals the file name and starts with app_
 *   since        the schema version of the vocabulary it writes (an integer of 3 or more)
 *   description  the call protocol, as the model reads it (what it does, when to call it, what
 *                comes back). The vocabulary it writes is described on its spec entries.
 *   schema       the JSON schema of the arguments: { type: 'object', properties, required? },
 *                never closed (no additionalProperties anywhere)
 *   apply        (draftWrap, args) => result | Promise<result>. A rejected call answers
 *                { error, _fixHint } and never throws (a throw still becomes { error }).
 *   mutating     true when it changes the draft definition: the route and MCP then persist the
 *                draft after it, discuss mode refuses it, MCP marks it as a write
 *   dataModel    true when it changes the data side (tables, rows, datasets, roles): the route
 *                then sends a data_model event. Implies mutating.
 *   core         false. The small-model band keeps its fixed menu (builderModelProfiles.js).
 *   mcp          true to offer it over the Studio MCP endpoint too, false for the in-product
 *                builder only
 *   verb         { key, en }: the past-tense row title the builder chat shows for a call. The
 *                key lives in the tool's own i18n namespace (server/i18n/defaults/en/<ns>.js).
 *
 * The tools join TOOL_SCHEMAS after every base tool (schemas.js), so the base schemas and their
 * order never move. A name already on the menu is refused at load.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);
const { listRegistryFiles, requireSince } = nodeRequire('../componentSpecs/registryDir.js') as {
    listRegistryFiles: (dir: string) => { name: string; file: string }[];
    requireSince: (since: unknown, where: string) => number;
};

export const TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools');

/** The longest tool name every provider takes. */
const MAX_TOOL_NAME = 64;

export interface ToolVerb { key: string; en: string }
export interface ToolParameters { type: 'object'; properties: Record<string, unknown>; required?: string[] }
export interface RegistryTool {
    name: string;
    since: number;
    description: string;
    schema: ToolParameters;
    apply: (draftWrap: unknown, args: Record<string, unknown>) => unknown;
    mutating: boolean;
    dataModel?: boolean;
    core: false;
    mcp: boolean;
    verb: ToolVerb;
}
export interface ToolSchema { type: 'function'; function: { name: string; description: string; parameters: ToolParameters } }

type Loose = Record<string, unknown>;

const isObject = (v: unknown): v is Loose => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** What is wrong with the argument schema, as sentences. */
function schemaProblems(schema: unknown): string[] {
    if (!isObject(schema) || schema.type !== 'object' || !isObject(schema.properties)) return ['"schema" is { type: "object", properties: { … } }'];
    const out: string[] = [];
    const props = schema.properties;
    if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((k) => typeof k === 'string' && Object.hasOwn(props, k)))) {
        out.push('"schema.required" lists names of its own properties');
    }
    let text: string;
    try {
        text = JSON.stringify(schema);
    } catch {
        return ['"schema" is plain JSON'];
    }
    if (text.includes('"additionalProperties"')) out.push('"schema" never closes a property list (no additionalProperties): a later key must not be refused');
    return out;
}

/** What is wrong with the flags and the verb, as sentences. */
function flagProblems(e: Loose): string[] {
    const out: string[] = [];
    if (typeof e.apply !== 'function') out.push('"apply" is a function (draftWrap, args) => result');
    if (typeof e.mutating !== 'boolean') out.push('"mutating" is true or false');
    if (e.dataModel !== undefined && typeof e.dataModel !== 'boolean') out.push('"dataModel" is true or false when present');
    if (e.dataModel === true && e.mutating !== true) out.push('"dataModel": true needs "mutating": true');
    if (e.core !== false) out.push('"core" is false: the small-model band keeps its fixed menu');
    if (typeof e.mcp !== 'boolean') out.push('"mcp" is true (also offered over MCP) or false');
    const verb = e.verb;
    if (!isObject(verb) || !nonEmpty(verb.key) || !verb.key.includes('.') || !nonEmpty(verb.en)) out.push('"verb" is { key: "<namespace>.<key>", en: "<past tense, product wording>" }');
    return out;
}

/** Throws on a malformed entry: a broken tool file must fail the boot, not vanish from the menu. */
export function checkTool(entry: unknown, fileName: string | null = null): RegistryTool {
    const where = fileName ? `builderTools/tools/${fileName}.js` : 'registry tool';
    if (!isObject(entry)) throw new Error(`${where}: must export an object`);
    const problems: string[] = [];
    if (typeof entry.name !== 'string' || !entry.name.startsWith('app_') || entry.name.length > MAX_TOOL_NAME) problems.push(`"name" starts with app_ and has at most ${MAX_TOOL_NAME} characters`);
    else if (fileName !== null && entry.name !== fileName) problems.push(`"name" (${entry.name}) equals the file name`);
    try {
        requireSince(entry.since, where);
    } catch (e) {
        problems.push((e as Error).message);
    }
    if (!nonEmpty(entry.description)) problems.push('"description" teaches the call protocol');
    problems.push(...schemaProblems(entry.schema), ...flagProblems(entry));
    if (problems.length) throw new Error(`${where}: ${problems.join('; ')}`);
    return entry as unknown as RegistryTool;
}

/** Every `<name>.js` in `dir`, sorted by file name. A missing directory is an empty registry. */
export function loadRegistryTools(dir: string = TOOLS_DIR): RegistryTool[] {
    return listRegistryFiles(dir).map(({ name, file }) => checkTool(nodeRequire(file), name));
}

let entries: RegistryTool[] | null = null;

/** The registered tools, in file-name order. */
export function registryTools(): readonly RegistryTool[] {
    if (!entries) entries = loadRegistryTools();
    return entries;
}

/** The tool registered under `name`, or null. */
export function registryTool(name: unknown): RegistryTool | null {
    return registryTools().find((tool) => tool.name === name) || null;
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Loose)) deepFreeze(child);
    }
    return value;
}

/**
 * The tools in the shape of TOOL_SCHEMAS, frozen copies. `reserved` holds the names already on
 * the menu: a registry tool may not take one (it would shadow a base tool, or be shadowed).
 */
export function registryToolSchemas(reserved: Iterable<string>): ToolSchema[] {
    const taken = new Set(reserved);
    return registryTools().map((tool) => {
        if (taken.has(tool.name)) throw new Error(`builderTools/tools/${tool.name}.js: "${tool.name}" is already a builder tool`);
        taken.add(tool.name);
        const parameters = JSON.parse(JSON.stringify(tool.schema)) as ToolParameters;
        return deepFreeze({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters } });
    });
}

/** The names of the tools that are not offered over MCP (mcp: false). */
export function mcpExcludedToolNames(): string[] {
    return registryTools().filter((tool) => !tool.mcp).map((tool) => tool.name);
}

/** tool name → its chat verb, for the web's generated list (scripts/gen-app-catalog.mjs --tools). */
export function registryToolVerbs(): Record<string, ToolVerb> {
    return Object.fromEntries(registryTools().map((tool) => [tool.name, { key: tool.verb.key, en: tool.verb.en }]));
}

/**
 * Test-only: use `list` as the registry. The tool schemas and the tool sets are module
 * constants, so this has to run BEFORE anything requires builderTools/schemas.js; it refuses
 * once the registry was read.
 */
export function _installRegistryTools(list: unknown[]): void {
    if (entries) throw new Error('toolRegistry: install the test tools before anything reads the registry (builderTools/schemas.js builds the menu at load)');
    entries = list.map((entry) => checkTool(entry));
}
