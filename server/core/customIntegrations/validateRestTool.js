/**
 * Validation of one REST tool of a custom-integration definition
 * (./validateCustomIntegration.js): name, description, method, the parameters
 * schema, and the path / query / headers / body / pagination that are
 * cross-checked against it. Every check reports through `r` (see
 * makeReporter in ./validateShared).
 */

const {
    MAX_PROPERTIES_PER_TOOL, MAX_QUERY_ENTRIES, MAX_DESCRIPTION_CHARS, MAX_ENUM_ENTRY_CHARS,
    MAX_COMBINED_NAME_CHARS, MAX_BODY_TEMPLATE_DEPTH,
    TOOL_NAME_RE, PARAM_NAME_RE, QUERY_NAME_RE, RESULT_PATH_RE, PATH_PLACEHOLDER_RE, EXACT_PLACEHOLDER_RE,
    METHODS, PAGINATION_STYLES, PARAM_SCALAR_TYPES, PARAM_TYPES,
    isObject, findInjectionPhrases, collectBodyPlaceholders, checkHeaderMap,
} = require('./validateShared');

/**
 * Validate `def.tools[i]`. `seenNames` collects the tool names across the
 * whole list (duplicates are an error); `slug` enables the combined-name
 * length check.
 */
function validateRestTool(r, tool, i, { slug, seenNames }) {
    const at = `tools[${i}]`;
    if (!isObject(tool)) {
        r.pushE({ code: 'tool.not_object', path: at, message: 'Each tool must be an object.', hint: 'See the specVersion 1 tool shape: { name, description, method, pathTemplate, … }.' });
        return;
    }
    const label = typeof tool.name === 'string' && tool.name ? tool.name : `#${i}`;

    // name
    if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
        r.pushE({ code: 'tool.name_invalid', path: `${at}.name`, message: `Tool ${label}: name must match ^[a-z][a-z0-9_]{2,40}$.`, hint: 'Lowercase snake_case, 3-41 chars, starting with a letter.' });
    } else if (seenNames.has(tool.name)) {
        r.pushE({ code: 'tool.name_duplicate', path: `${at}.name`, message: `Duplicate tool name "${tool.name}".`, hint: 'Tool names must be unique within the integration.' });
    } else {
        seenNames.add(tool.name);
    }
    if (typeof slug === 'string' && typeof tool.name === 'string') {
        const combined = `cint_${slug}_${tool.name}`;
        if (combined.length > MAX_COMBINED_NAME_CHARS) {
            r.pushE({ code: 'tool.name_too_long', path: `${at}.name`, message: `Tool ${label}: combined name "${combined}" is ${combined.length} chars; the cap is ${MAX_COMBINED_NAME_CHARS}.`, hint: 'Shorten the tool name.' });
        }
    }

    // description (+ injection lint)
    if (typeof tool.description !== 'string' || tool.description.length < 1 || tool.description.length > MAX_DESCRIPTION_CHARS) {
        r.pushE({ code: 'tool.description_invalid', path: `${at}.description`, message: `Tool ${label}: description must be a string of 1..${MAX_DESCRIPTION_CHARS} chars.`, hint: 'One or two sentences describing what the endpoint does.' });
    } else {
        const phrases = findInjectionPhrases(tool.description);
        if (phrases.length) {
            r.pushLint({ code: 'tool.description_injection', path: `${at}.description`, message: `Tool ${label}: description contains instruction-like or secret-related phrasing (${phrases.map(p => `"${p}"`).join(', ')}).`, hint: 'Descriptions are read by the model; describe the endpoint factually and never give the model instructions or mention secrets.' });
        }
    }

    // method
    if (!METHODS.has(tool.method)) {
        r.pushE({ code: 'tool.method_invalid', path: `${at}.method`, message: `Tool ${label}: method must be one of GET|POST|PUT|PATCH|DELETE (got ${JSON.stringify(tool.method)}).`, hint: 'Use the uppercase HTTP verb.' });
    }

    // parameters schema first — path/query/body cross-check against it.
    const { declaredParams, requiredParams } = checkParameters(r, tool.parameters, at, label);

    checkPathTemplate(r, tool.pathTemplate, at, label, { declaredParams, requiredParams });
    checkQueryMap(r, tool, at, label, declaredParams);
    checkToolHeaders(r, tool, at, label);
    checkBody(r, tool, at, label, declaredParams);

    // readOnly
    if (tool.readOnly !== undefined && typeof tool.readOnly !== 'boolean') {
        r.pushE({ code: 'tool.read_only_invalid', path: `${at}.readOnly`, message: `Tool ${label}: readOnly must be a boolean.`, hint: 'true for safe reads, false for mutations.' });
    }

    checkPagination(r, tool, at, label, declaredParams);

    // resultPath
    if (tool.resultPath !== undefined && (typeof tool.resultPath !== 'string' || !RESULT_PATH_RE.test(tool.resultPath))) {
        r.pushE({ code: 'tool.result_path_invalid', path: `${at}.resultPath`, message: `Tool ${label}: resultPath must be a dot-path like "data.items".`, hint: 'Segments match [A-Za-z0-9_]+ joined by dots; omit the field to return the whole response.' });
    }
}

/**
 * The tool's `parameters` JSON schema. Resolves to the declared and the
 * required parameter names, which path, query and body are checked against.
 */
function checkParameters(r, params, at, label) {
    const declaredParams = new Set();
    const requiredParams = new Set();
    if (params === undefined) return { declaredParams, requiredParams };
    if (!isObject(params)) {
        r.pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters`, message: `Tool ${label}: parameters must be a JSON-schema object.`, hint: 'Use { "type": "object", "properties": {…}, "required": […] }.' });
        return { declaredParams, requiredParams };
    }
    if (params.type !== 'object') {
        r.pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.type`, message: `Tool ${label}: parameters.type must be "object".`, hint: 'The schema root is always an object of named arguments.' });
    }
    const allowedRoot = new Set(['type', 'properties', 'required', 'additionalProperties', 'description']);
    for (const k of Object.keys(params)) {
        if (!allowedRoot.has(k)) {
            r.pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.${k}`, message: `Tool ${label}: unsupported schema keyword "${k}".`, hint: `Allowed root keywords: ${[...allowedRoot].join(', ')}.` });
        }
    }
    if (params.additionalProperties !== undefined && params.additionalProperties !== false) {
        r.pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.additionalProperties`, message: `Tool ${label}: additionalProperties must be false.`, hint: 'Omit it — it is forced to false at activation.' });
    }
    if (params.properties !== undefined) {
        if (!isObject(params.properties)) {
            r.pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.properties`, message: `Tool ${label}: parameters.properties must be an object.`, hint: 'Map of parameter name → schema.' });
        } else {
            const names = Object.keys(params.properties);
            if (names.length > MAX_PROPERTIES_PER_TOOL) {
                r.pushE({ code: 'tool.params_too_many', path: `${at}.parameters.properties`, message: `Tool ${label}: ${names.length} parameters declared; the cap is ${MAX_PROPERTIES_PER_TOOL}.`, hint: 'Drop parameters the model does not need.' });
            }
            checkParamProperties(r, params, names, at, label, declaredParams);
        }
    }
    if (params.required !== undefined) {
        if (!Array.isArray(params.required)) {
            r.pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.required`, message: `Tool ${label}: parameters.required must be an array of property names.`, hint: 'Example: ["invoice_id"].' });
        } else {
            params.required.forEach((rname, j) => {
                if (typeof rname !== 'string' || !declaredParams.has(rname)) {
                    r.pushE({ code: 'tool.param_required_unknown', path: `${at}.parameters.required[${j}]`, message: `Tool ${label}: required entry ${JSON.stringify(rname)} is not a declared property.`, hint: `Declared properties: ${[...declaredParams].join(', ') || '(none)'}.` });
                } else {
                    requiredParams.add(rname);
                }
            });
        }
    }
    return { declaredParams, requiredParams };
}

/** Each declared parameter's own schema: scalar types and arrays of scalars only. */
function checkParamProperties(r, params, names, at, label, declaredParams) {
    for (const pname of names) {
        const pAt = `${at}.parameters.properties.${pname}`;
        if (!PARAM_NAME_RE.test(pname)) {
            r.pushE({ code: 'tool.param_name_invalid', path: pAt, message: `Tool ${label}: parameter name "${pname}" must match ^[a-z][a-z0-9_]{0,40}$.`, hint: 'Lowercase snake_case, starting with a letter.' });
        }
        declaredParams.add(pname);
        const schema = params.properties[pname];
        if (!isObject(schema)) {
            r.pushE({ code: 'tool.param_schema_invalid', path: pAt, message: `Tool ${label}: parameter "${pname}" schema must be an object.`, hint: 'Example: { "type": "string", "description": "…" }.' });
            continue;
        }
        const allowedProp = new Set(['type', 'description', 'enum', 'items']);
        for (const k of Object.keys(schema)) {
            if (!allowedProp.has(k)) {
                r.pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.${k}`, message: `Tool ${label}: parameter "${pname}" uses unsupported keyword "${k}".`, hint: `Allowed keywords: ${[...allowedProp].join(', ')}.` });
            }
        }
        if (!PARAM_TYPES.has(schema.type)) {
            const nested = schema.type === 'object';
            r.pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.type`, message: nested ? `Tool ${label}: parameter "${pname}" is a nested object — not allowed.` : `Tool ${label}: parameter "${pname}" type must be string|number|integer|boolean|array.`, hint: nested ? 'Flatten nested data into scalar parameters, or accept a JSON string.' : 'Pick one of the supported scalar types or array-of-scalar.' });
        }
        if (schema.description !== undefined && (typeof schema.description !== 'string' || schema.description.length > MAX_DESCRIPTION_CHARS)) {
            r.pushE({ code: 'tool.param_description_invalid', path: `${pAt}.description`, message: `Tool ${label}: parameter "${pname}" description must be a string of at most ${MAX_DESCRIPTION_CHARS} chars.`, hint: 'Keep parameter descriptions short.' });
        }
        if (schema.enum !== undefined) {
            if (schema.type !== 'string') {
                r.pushE({ code: 'tool.param_enum_invalid', path: `${pAt}.enum`, message: `Tool ${label}: enum is only supported on string parameters.`, hint: 'Change the type to string or drop the enum.' });
            } else if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some(e => typeof e !== 'string' || e.length > MAX_ENUM_ENTRY_CHARS)) {
                r.pushE({ code: 'tool.param_enum_invalid', path: `${pAt}.enum`, message: `Tool ${label}: enum must be a non-empty array of strings, each at most ${MAX_ENUM_ENTRY_CHARS} chars.`, hint: 'List the allowed literal values.' });
            }
        }
        if (schema.type === 'array') {
            const items = schema.items;
            if (!isObject(items) || !PARAM_SCALAR_TYPES.has(items.type)) {
                r.pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.items`, message: `Tool ${label}: array parameter "${pname}" items must be scalar (string|number|integer|boolean).`, hint: 'Arrays of objects are not supported; accept a JSON string instead.' });
            } else {
                const allowedItems = new Set(['type', 'description', 'enum']);
                for (const k of Object.keys(items)) {
                    if (!allowedItems.has(k)) {
                        r.pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.items.${k}`, message: `Tool ${label}: items uses unsupported keyword "${k}".`, hint: `Allowed item keywords: ${[...allowedItems].join(', ')}.` });
                    }
                }
                if (items.enum !== undefined && (items.type !== 'string' || !Array.isArray(items.enum) || items.enum.length === 0 || items.enum.some(e => typeof e !== 'string' || e.length > MAX_ENUM_ENTRY_CHARS))) {
                    r.pushE({ code: 'tool.param_enum_invalid', path: `${pAt}.items.enum`, message: `Tool ${label}: items.enum must be a non-empty array of strings (string items only), each at most ${MAX_ENUM_ENTRY_CHARS} chars.`, hint: 'List the allowed literal values.' });
                }
            }
        } else if (schema.items !== undefined) {
            r.pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.items`, message: `Tool ${label}: "items" is only valid on array parameters.`, hint: 'Remove items or set type to array.' });
        }
    }
}

/** The pathTemplate: a relative path that cannot leave the base origin, with declared, required placeholders. */
function checkPathTemplate(r, pt, at, label, { declaredParams, requiredParams }) {
    if (typeof pt !== 'string' || !/^\/(?!\/)/.test(pt)) {
        r.pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must start with a single '/'.`, hint: "Use a relative path like '/invoices/{invoice_id}' — the origin comes from api.baseUrl." });
    } else {
        if (pt.includes('://')) {
            r.pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must not contain '://'.`, hint: 'Absolute URLs are not allowed; all requests stay on api.baseUrl.' });
        }
        if (/[?#]/.test(pt)) {
            r.pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must not contain '?' or '#'.`, hint: 'Declare query parameters in the `query` map instead.' });
        }
        if (/\s/.test(pt)) {
            r.pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must not contain whitespace.`, hint: 'Percent-encode literal segments if needed.' });
        }
        if (pt.includes('\\')) {
            // WHATWG URL parsing turns '\' into '/' ('/\evil.com'
            // → '//evil.com'), which would escape the origin pin.
            r.pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must not contain '\\'.`, hint: 'URL parsers treat backslashes as slashes; use forward slashes only.' });
        }
        if (/%2f|%2e/i.test(pt)) {
            r.pushE({ code: 'tool.path_traversal', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate contains raw %2f/%2e sequences.`, hint: 'Encoded slash/dot sequences can smuggle traversal past the origin pin; spell the path out literally.' });
        }
        if (pt.includes('..')) {
            r.pushE({ code: 'tool.path_traversal', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate contains '..'.`, hint: 'Parent-directory segments are not allowed.' });
        }
        PATH_PLACEHOLDER_RE.lastIndex = 0;
        let m;
        while ((m = PATH_PLACEHOLDER_RE.exec(pt))) {
            const p = m[1];
            if (!declaredParams.has(p)) {
                r.pushE({ code: 'tool.path_param_undeclared', path: `${at}.pathTemplate`, message: `Tool ${label}: path placeholder {${p}} is not a declared parameter.`, hint: `Add "${p}" to parameters.properties and parameters.required.` });
            } else if (!requiredParams.has(p)) {
                r.pushE({ code: 'tool.path_param_not_required', path: `${at}.pathTemplate`, message: `Tool ${label}: path placeholder {${p}} must be listed in parameters.required.`, hint: 'A path segment cannot be omitted, so its parameter must be required.' });
            }
        }
        const stripped = pt.replace(PATH_PLACEHOLDER_RE, '');
        if (stripped.includes('{') || stripped.includes('}')) {
            r.pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate has malformed placeholder braces.`, hint: 'Placeholders must look like {param_name}.' });
        }
    }
}

/** The query map: each value one "{param}" placeholder or a brace-free literal. */
function checkQueryMap(r, tool, at, label, declaredParams) {
    if (tool.query !== undefined) {
        if (!isObject(tool.query)) {
            r.pushE({ code: 'tool.query_invalid', path: `${at}.query`, message: `Tool ${label}: query must be an object map.`, hint: 'Each value is either a single "{param}" placeholder or a literal.' });
        } else {
            const qKeys = Object.keys(tool.query);
            if (qKeys.length > MAX_QUERY_ENTRIES) {
                r.pushE({ code: 'tool.query_too_many', path: `${at}.query`, message: `Tool ${label}: ${qKeys.length} query entries; the cap is ${MAX_QUERY_ENTRIES}.`, hint: 'Drop parameters the API does not strictly need.' });
            }
            for (const qk of qKeys) {
                const qAt = `${at}.query.${qk}`;
                if (!QUERY_NAME_RE.test(qk)) {
                    r.pushE({ code: 'tool.query_name_invalid', path: qAt, message: `Tool ${label}: query parameter name "${qk}" is invalid.`, hint: 'Names must match ^[A-Za-z0-9_.[\\]-]{1,64}$.' });
                }
                const qv = tool.query[qk];
                if (typeof qv === 'string') {
                    const pm = qv.match(EXACT_PLACEHOLDER_RE);
                    if (pm) {
                        if (!declaredParams.has(pm[1])) {
                            r.pushE({ code: 'tool.query_param_undeclared', path: qAt, message: `Tool ${label}: query placeholder {${pm[1]}} is not a declared parameter.`, hint: `Add "${pm[1]}" to parameters.properties.` });
                        }
                    } else if (qv.includes('{') || qv.includes('}')) {
                        r.pushE({ code: 'tool.query_value_invalid', path: qAt, message: `Tool ${label}: query value for "${qk}" must be a single "{param}" placeholder or a brace-free literal.`, hint: 'Partial templating like "a-{x}" is not supported.' });
                    }
                } else if (typeof qv !== 'number' && typeof qv !== 'boolean') {
                    r.pushE({ code: 'tool.query_value_invalid', path: qAt, message: `Tool ${label}: query value for "${qk}" must be a string, number or boolean.`, hint: 'Objects/arrays are not valid query values.' });
                }
            }
        }
    }
}

/** The tool's own literal headers. */
function checkToolHeaders(r, tool, at, label) {
    if (tool.headers !== undefined) {
        if (!isObject(tool.headers)) {
            r.pushE({ code: 'tool.headers_invalid', path: `${at}.headers`, message: `Tool ${label}: headers must be an object map of literal strings.`, hint: 'Example: { "X-Tenant": "main" }.' });
        } else {
            checkHeaderMap(r, tool.headers, `${at}.headers`, {
                tooMany: 'tool.headers_too_many',
                name: 'tool.header_name_invalid',
                denied: 'tool.header_denied',
                value: 'tool.header_value_not_literal',
            }, `Tool ${label}:`);
        }
    }
}

/** The JSON body template and its placeholders. */
function checkBody(r, tool, at, label, declaredParams) {
    if (tool.body !== undefined) {
        if (!isObject(tool.body)) {
            r.pushE({ code: 'tool.body_invalid', path: `${at}.body`, message: `Tool ${label}: body must be an object { mode, template? }.`, hint: 'Use { "mode": "none" } or { "mode": "json", "template": {…} }.' });
        } else {
            const mode = tool.body.mode;
            if (mode !== 'none' && mode !== 'json') {
                r.pushE({ code: 'tool.body_mode_invalid', path: `${at}.body.mode`, message: `Tool ${label}: body.mode must be "none" or "json" (got ${JSON.stringify(mode)}).`, hint: 'Only JSON request bodies are supported.' });
            }
            if (mode === 'none' && tool.body.template !== undefined) {
                r.pushE({ code: 'tool.body_template_unexpected', path: `${at}.body.template`, message: `Tool ${label}: body.mode "none" must not carry a template.`, hint: 'Remove the template or switch the mode to "json".' });
            }
            if (mode === 'json') {
                if (!isObject(tool.body.template) && !Array.isArray(tool.body.template)) {
                    r.pushE({ code: 'tool.body_template_invalid', path: `${at}.body.template`, message: `Tool ${label}: body.mode "json" requires an object (or array) template.`, hint: '"{param}" at string leaves substitutes the typed argument; everything else is sent literally.' });
                } else {
                    const found = { placeholders: [], tooDeep: [] };
                    collectBodyPlaceholders(tool.body.template, `${at}.body.template`, 0, found);
                    if (found.tooDeep.length) {
                        r.pushE({ code: 'tool.body_template_too_deep', path: found.tooDeep[0], message: `Tool ${label}: body template nests deeper than ${MAX_BODY_TEMPLATE_DEPTH} levels.`, hint: 'Flatten the payload.' });
                    }
                    for (const ph of found.placeholders) {
                        if (!declaredParams.has(ph.name)) {
                            r.pushE({ code: 'tool.body_param_undeclared', path: ph.path, message: `Tool ${label}: body placeholder {${ph.name}} is not a declared parameter.`, hint: `Add "${ph.name}" to parameters.properties.` });
                        }
                    }
                    if (tool.method === 'GET' || tool.method === 'DELETE') {
                        r.pushW({ code: 'tool.body_on_read_method', path: `${at}.body`, message: `Tool ${label}: a JSON body on ${tool.method} is unusual and some servers reject it.`, hint: 'Move the data into query parameters, or double-check the vendor docs.' });
                    }
                }
            }
        }
    }
}

/** Pagination (a hint only, but shape-checked; undeclared params lint). */
function checkPagination(r, tool, at, label, declaredParams) {
    if (tool.pagination !== undefined) {
        const pg = tool.pagination;
        const pgAt = `${at}.pagination`;
        if (!isObject(pg)) {
            r.pushE({ code: 'tool.pagination_invalid', path: pgAt, message: `Tool ${label}: pagination must be an object.`, hint: 'Example: { "style": "page", "pageParam": "page", "sizeParam": "limit", "maxPageSize": 100 }.' });
        } else {
            if (!PAGINATION_STYLES.has(pg.style)) {
                r.pushE({ code: 'tool.pagination_invalid', path: `${pgAt}.style`, message: `Tool ${label}: pagination.style must be page|offset|cursor|none (got ${JSON.stringify(pg.style)}).`, hint: 'Pick the style the vendor documents.' });
            }
            if (pg.maxPageSize !== undefined && (!Number.isInteger(pg.maxPageSize) || pg.maxPageSize < 1 || pg.maxPageSize > 1000)) {
                r.pushE({ code: 'tool.pagination_invalid', path: `${pgAt}.maxPageSize`, message: `Tool ${label}: pagination.maxPageSize must be an integer 1..1000.`, hint: 'Use the vendor\'s documented page-size cap.' });
            }
            for (const f of ['pageParam', 'sizeParam']) {
                const v = pg[f];
                if (v === undefined) continue;
                if (typeof v !== 'string' || !v) {
                    r.pushE({ code: 'tool.pagination_invalid', path: `${pgAt}.${f}`, message: `Tool ${label}: pagination.${f} must be a non-empty string.`, hint: 'Name the parameter that carries the page/size value.' });
                    continue;
                }
                if (pg.style !== 'none' && !declaredParams.has(v)) {
                    r.pushLint({ code: 'tool.pagination_param_undeclared', path: `${pgAt}.${f}`, message: `Tool ${label}: pagination.${f} "${v}" is not a declared parameter.`, hint: `Declare "${v}" in parameters.properties (and map it in query) so the model can actually page.` });
                }
            }
        }
    }
}

module.exports = { validateRestTool };
