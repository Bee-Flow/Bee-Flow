// @typecheck noImplicitAny
/**
 * Validate an org-scoped custom-integration definition (specVersion 1).
 *
 * Two kinds:
 *   - 'rest'       — declarative toolset executed by the hardened generic runner
 *   - 'mcp_remote' — vendor-hosted HTTP MCP server
 *
 * Returns { ok, errors[], warnings[] } where each record is
 * `{ code, severity, path, message, hint }` — the same structured shape as
 * automation/validate.js, so the AI builder loop can feed specific failures
 * back to the LLM for self-correction.
 *
 * Security invariants enforced here (the runner relies on them):
 *   - api.baseUrl / mcp.url: https only, no userinfo, no query/fragment
 *     (REST), hostname not a private/forbidden literal (ssrfGuard).
 *   - '{{credential.' may ONLY appear in auth.valueTemplate / mcp.valueTemplate.
 *   - pathTemplate cannot escape the base origin/path ('//', '://', '..',
 *     '?', '#', whitespace, raw %2f/%2e sequences).
 *   - header names pass a deny-list (transport + proxy/forwarding headers);
 *     header values are literals — never parameter- or credential-templated.
 *   - parameters schema is restricted: scalar types + array-of-scalar only,
 *     no nested objects, additionalProperties forced false at derivation.
 *
 * Run-time argument caps (string <= 2000 chars, array <= 100 items) are
 * enforced by the runner, not here.
 *
 * `strict: true` (used at activation) additionally promotes the lint set
 * (description injection, undeclared pagination params) from warnings to
 * errors. `ok` is always `errors.length === 0`.
 */

const {
    MAX_DEF_CHARS, MIN_TOOLS, MAX_TOOLS, MAX_NOTES_CHARS, MAX_TOOL_ALLOW_LIST,
    MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_RESPONSE_CHARS, MAX_RESPONSE_CHARS,
    SLUG_RE, HEADER_NAME_RE, AUTH_QUERY_PARAM_RE, AUTH_TYPES, MCP_AUTH_STYLES,
    isObject, isDeniedHeader, findInjectionPhrases, findCredentialLeaks, makeReporter,
    checkHttpsUrl, checkHeaderMap, checkValueTemplate, checkCredentialList, checkIntRange,
} = require('./validateShared');
const { validateRestTool } = require('./validateRestTool');

/**
 * Validate a definition for an org-scoped custom integration.
 *
 * @param {{ specVersion?: number, meta?: object, api?: object, auth?: object, tools?: object[], mcp?: object }} def  the JSONB definition blob
 * @param {{ kind?: string, strict?: boolean, librarySource?: boolean, slug?: string }} [opts]
 *   `kind`: 'rest' | 'mcp_remote'; defaults to 'rest'; `strict`: promote lint findings to errors
 *   (activation); `librarySource`: the MCP library's own install path: `meta.source` must then be
 *   'mcp_library'. Anywhere else `meta.source` is refused, because that marker decides which gate and
 *   licence govern a row (customIntegrations/mcpLibrary/gate.js); `slug`: integration slug; enables the
 *   combined cint_<slug>_<tool> length check
 */
function validateCustomIntegration(def, { kind = 'rest', strict = false, slug = null, librarySource = false } = {}) {
    const r = makeReporter(strict);
    const { errors, warnings } = r;

    if (kind !== 'rest' && kind !== 'mcp_remote') {
        return {
            ok: false,
            errors: [{ code: 'def.kind_invalid', severity: 'error', path: '', message: `Unknown integration kind "${kind}".`, hint: "Use 'rest' or 'mcp_remote'." }],
            warnings: [],
        };
    }
    if (slug !== null && slug !== undefined && (typeof slug !== 'string' || !SLUG_RE.test(slug))) {
        r.pushE({ code: 'def.slug_invalid', path: '', message: `Slug "${slug}" must match ^[a-z0-9]{4,16}$ (no underscores).`, hint: 'Pick 4-16 lowercase letters/digits; underscores are reserved as the tool-name separator.' });
    }
    if (!isObject(def)) {
        r.pushE({ code: 'def.not_object', path: '', message: 'Definition must be a JSON object.', hint: 'Pass the definition blob, e.g. { specVersion: 1, api: {...}, auth: {...}, tools: [...] }.' });
        return { ok: false, errors, warnings };
    }

    // Serializability + size cap — bail out on circular structures before
    // any tree walk would recurse forever.
    /** @type {string} */
    let serialized;
    try {
        serialized = JSON.stringify(def);
    } catch {
        r.pushE({ code: 'def.not_serializable', path: '', message: 'Definition must be JSON-serializable (no circular references).', hint: 'Build the definition as plain JSON data.' });
        return { ok: false, errors, warnings };
    }
    if (serialized.length > MAX_DEF_CHARS) {
        r.pushE({ code: 'def.too_large', path: '', message: `Definition is ${serialized.length} chars; the cap is ${MAX_DEF_CHARS}.`, hint: 'Trim notes/descriptions or split the integration into smaller ones.' });
    }

    if (def.specVersion !== 1) {
        r.pushE({ code: 'def.spec_version_unsupported', path: 'specVersion', message: `specVersion must be 1 (got ${JSON.stringify(def.specVersion)}).`, hint: 'Set "specVersion": 1.' });
    }

    // Global credential ban — '{{credential.' is only legal in the auth/mcp
    // value template. Anything else would exfiltrate the secret into URLs,
    // bodies, headers or model-visible text.
    /** @type {string[]} */
    const leaks = [];
    findCredentialLeaks(def, '', leaks);
    for (const p of leaks) {
        r.pushE({ code: 'auth.credential_ref_outside_auth', path: p, message: `'{{credential.*}}' found outside ${kind === 'rest' ? 'auth.valueTemplate' : 'mcp.valueTemplate'}.`, hint: 'Credentials are injected exclusively via the auth value template. Remove the reference; pass request data through tool parameters instead.' });
    }

    checkTopLevelKeys(r, def, kind);
    if (def.meta !== undefined) checkMeta(r, def.meta, librarySource);

    if (kind === 'rest') {
        checkRestApi(r, def.api);
        checkRestAuth(r, def.auth);
        checkRestTools(r, def.tools, slug);
    } else {
        checkMcp(r, def.mcp);
    }

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Kind/shape cross-checks + unknown top-level keys.
 * @param {import('./validateShared').Reporter} r
 * @param {Record<string, unknown>} def
 * @param {string} kind
 */
function checkTopLevelKeys(r, def, kind) {
    const allowedTop = kind === 'rest'
        ? new Set(['specVersion', 'meta', 'api', 'auth', 'tools'])
        : new Set(['specVersion', 'meta', 'mcp']);
    const mismatched = kind === 'rest'
        ? ['mcp'].filter(k => def[k] !== undefined)
        : ['api', 'auth', 'tools'].filter(k => def[k] !== undefined);
    for (const k of mismatched) {
        r.pushE({ code: 'def.kind_mismatch', path: k, message: `Key "${k}" does not belong in a ${kind} definition.`, hint: kind === 'rest' ? "REST definitions use api/auth/tools; 'mcp' is only valid for kind mcp_remote." : "mcp_remote definitions use only the 'mcp' block; api/auth/tools are REST-only." });
    }
    for (const k of Object.keys(def)) {
        if (!allowedTop.has(k) && !mismatched.includes(k)) {
            r.pushW({ code: 'def.unknown_key', path: k, message: `Unknown top-level key "${k}" is ignored.`, hint: `Allowed keys for kind ${kind}: ${[...allowedTop].join(', ')}.` });
        }
    }
}

/**
 * meta (informational).
 * @param {import('./validateShared').Reporter} r
 * @param {import('./validateShared').MetaBlock} meta
 * @param {boolean} librarySource
 */
function checkMeta(r, meta, librarySource) {
    if (!isObject(meta)) {
        r.pushE({ code: 'meta.invalid', path: 'meta', message: 'meta must be an object.', hint: 'Use { docsUrl, notes } or omit meta entirely.' });
        return;
    }
    if (librarySource ? meta.source !== 'mcp_library' : meta.source !== undefined) {
        r.pushE({ code: 'meta.source_reserved', path: 'meta.source', message: librarySource ? 'meta.source must be "mcp_library" here.' : 'meta.source is reserved for the MCP library.', hint: 'Remove meta.source; it is set by the MCP library itself and cannot be chosen.' });
    }
    if (meta.docsUrl !== undefined) {
        let okUrl = false;
        if (typeof meta.docsUrl === 'string') {
            try { const u = new URL(meta.docsUrl); okUrl = u.protocol === 'https:' || u.protocol === 'http:'; } catch { okUrl = false; }
        }
        if (!okUrl) r.pushE({ code: 'meta.docs_url_invalid', path: 'meta.docsUrl', message: 'meta.docsUrl must be an http(s) URL.', hint: 'Link the vendor API docs, or omit the field.' });
    }
    if (meta.notes !== undefined) {
        if (typeof meta.notes !== 'string') {
            r.pushE({ code: 'meta.notes_invalid', path: 'meta.notes', message: 'meta.notes must be a string.', hint: 'Free-text notes for reviewers, max 4000 chars.' });
        } else {
            if (meta.notes.length > MAX_NOTES_CHARS) {
                r.pushE({ code: 'meta.notes_too_long', path: 'meta.notes', message: `meta.notes is ${meta.notes.length} chars; the cap is ${MAX_NOTES_CHARS}.`, hint: 'Shorten the notes.' });
            }
            const phrases = findInjectionPhrases(meta.notes);
            if (phrases.length) {
                r.pushLint({ code: 'meta.notes_injection', path: 'meta.notes', message: `meta.notes contains instruction-like or secret-related phrasing (${phrases.map(p => `"${p}"`).join(', ')}).`, hint: 'Notes may be shown to the model; describe the API factually and never include instructions or secret material.' });
            }
        }
    }
}

/**
 * REST: the `api` block.
 * @param {import('./validateShared').Reporter} r
 * @param {import('./validateShared').RestApiBlock} api
 */
function checkRestApi(r, api) {
    if (!isObject(api)) {
        r.pushE({ code: 'api.missing', path: 'api', message: 'Missing or invalid `api` block.', hint: 'Provide { baseUrl, defaultHeaders?, timeoutMs?, maxResponseChars? }.' });
    } else {
        checkHttpsUrl(r, api.baseUrl, { path: 'api.baseUrl', codePrefix: 'api.base_url', allowQuery: false, requiredLabel: 'api.baseUrl' });
        if (api.defaultHeaders !== undefined) {
            if (!isObject(api.defaultHeaders)) {
                r.pushE({ code: 'api.default_headers_invalid', path: 'api.defaultHeaders', message: 'api.defaultHeaders must be an object map of literal strings.', hint: 'Example: { "Accept": "application/json" }.' });
            } else {
                checkHeaderMap(r, api.defaultHeaders, 'api.defaultHeaders', {
                    tooMany: 'api.default_headers_too_many',
                    name: 'api.default_header_name_invalid',
                    denied: 'api.default_header_denied',
                    value: 'api.default_header_value_not_literal',
                }, 'api.defaultHeaders');
            }
        }
        checkIntRange(r, api.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'api.timeoutMs', 'api.timeout_invalid', 'api.timeoutMs');
        checkIntRange(r, api.maxResponseChars, MIN_RESPONSE_CHARS, MAX_RESPONSE_CHARS, 'api.maxResponseChars', 'api.max_response_chars_invalid', 'api.maxResponseChars');
    }
}

/**
 * REST: the `auth` block.
 * @param {import('./validateShared').Reporter} r
 * @param {import('./validateShared').RestAuthBlock} auth
 */
function checkRestAuth(r, auth) {
    /** @type {Set<string>} */
    let declaredCreds = new Set();
    if (!isObject(auth)) {
        r.pushE({ code: 'auth.missing', path: 'auth', message: 'Missing or invalid `auth` block.', hint: 'Provide { type, … }; use { "type": "none" } for unauthenticated APIs.' });
    } else {
        if (!AUTH_TYPES.has(auth.type)) {
            r.pushE({ code: 'auth.type_invalid', path: 'auth.type', message: `auth.type must be one of bearer|header|query|basic|none (got ${JSON.stringify(auth.type)}).`, hint: 'Pick the scheme the vendor documents.' });
        }
        declaredCreds = checkCredentialList(r, auth.credentials, 'auth', 'auth');

        const needsTemplate = auth.type === 'bearer' || auth.type === 'header' || auth.type === 'query';
        if (needsTemplate) {
            if (typeof auth.valueTemplate !== 'string' || !auth.valueTemplate) {
                r.pushE({ code: 'auth.value_template_missing', path: 'auth.valueTemplate', message: `auth.type "${auth.type}" requires auth.valueTemplate.`, hint: 'Example: "Bearer {{credential.api_key}}".' });
            } else {
                checkValueTemplate(r, auth.valueTemplate, declaredCreds, 'auth.valueTemplate', 'auth');
            }
        }
        if (auth.type === 'basic') {
            if (!declaredCreds.has('username') || !declaredCreds.has('password')) {
                r.pushE({ code: 'auth.basic_credentials_missing', path: 'auth.credentials', message: 'auth.type "basic" requires credentials with keys "username" and "password".', hint: 'Declare both; the runner builds the Basic header from them.' });
            }
            if (auth.valueTemplate !== undefined) {
                if (typeof auth.valueTemplate !== 'string') {
                    r.pushE({ code: 'auth.value_template_invalid', path: 'auth.valueTemplate', message: 'auth.valueTemplate must be a string when present.', hint: 'Omit it for basic auth; the runner derives the header.' });
                } else {
                    checkValueTemplate(r, auth.valueTemplate, declaredCreds, 'auth.valueTemplate', 'auth');
                }
            }
        }
        if (auth.type === 'none' && auth.valueTemplate !== undefined) {
            r.pushE({ code: 'auth.value_template_unexpected', path: 'auth.valueTemplate', message: 'auth.type "none" must not carry a valueTemplate.', hint: 'Remove auth.valueTemplate or pick an auth type that injects it.' });
        }
        if (auth.type === 'header') {
            if (typeof auth.header !== 'string' || !HEADER_NAME_RE.test(auth.header)) {
                r.pushE({ code: 'auth.header_invalid', path: 'auth.header', message: 'auth.type "header" requires a valid auth.header name.', hint: 'Example: "X-Api-Key" (must match ^[A-Za-z0-9-]{1,64}$).' });
            } else if (isDeniedHeader(auth.header, { forAuth: true })) {
                r.pushE({ code: 'auth.header_denied', path: 'auth.header', message: `auth.header "${auth.header}" is a managed transport header.`, hint: 'Use the vendor\'s API-key header, or auth.type "bearer" for Authorization.' });
            }
        }
        if (auth.type === 'query') {
            if (typeof auth.queryParam !== 'string' || !AUTH_QUERY_PARAM_RE.test(auth.queryParam)) {
                r.pushE({ code: 'auth.query_param_invalid', path: 'auth.queryParam', message: 'auth.type "query" requires a valid auth.queryParam name.', hint: 'Example: "api_key".' });
            }
            r.pushW({ code: 'auth.query_secret', path: 'auth.type', message: 'Query-string auth places the secret in URLs, where logs, proxies and referrers can capture it.', hint: 'Prefer a header-based scheme if the vendor supports one.' });
        }
    }
}

/**
 * REST: the `tools` list — each tool in ./validateRestTool.
 * @param {import('./validateShared').Reporter} r
 * @param {import('./validateShared').RestToolDef[] | undefined} tools
 * @param {string | null} slug
 */
function checkRestTools(r, tools, slug) {
    if (!Array.isArray(tools) || tools.length < MIN_TOOLS) {
        r.pushE({ code: 'tools.missing', path: 'tools', message: 'Definition needs a non-empty `tools` array.', hint: 'Declare 1 to 30 tools.' });
        return;
    }
    if (tools.length > MAX_TOOLS) {
        r.pushE({ code: 'tools.too_many', path: 'tools', message: `${tools.length} tools declared; the cap is ${MAX_TOOLS}.`, hint: 'Split into multiple integrations or drop rarely used endpoints.' });
    }
    /** @type {Set<string>} */
    const seenNames = new Set();
    tools.forEach((tool, i) => validateRestTool(r, tool, i, { slug, seenNames }));
}

/**
 * mcp_remote: the `mcp` block.
 * @param {import('./validateShared').Reporter} r
 * @param {import('./validateShared').McpDefBlock} mcp
 */
function checkMcp(r, mcp) {
    if (!isObject(mcp)) {
        r.pushE({ code: 'mcp.missing', path: 'mcp', message: 'Missing or invalid `mcp` block.', hint: 'Provide { url, authStyle, valueTemplate?, credentials?, toolAllowList? }.' });
    } else {
        checkHttpsUrl(r, mcp.url, { path: 'mcp.url', codePrefix: 'mcp.url', allowQuery: true, requiredLabel: 'mcp.url' });
        if (!MCP_AUTH_STYLES.has(mcp.authStyle)) {
            r.pushE({ code: 'mcp.auth_style_invalid', path: 'mcp.authStyle', message: `mcp.authStyle must be bearer|header|none (got ${JSON.stringify(mcp.authStyle)}).`, hint: 'Pick the auth scheme the MCP server documents.' });
        }
        const declared = checkCredentialList(r, mcp.credentials, 'mcp', 'mcp');
        if (mcp.authStyle === 'header') {
            if (typeof mcp.header !== 'string' || !HEADER_NAME_RE.test(mcp.header)) {
                r.pushE({ code: 'mcp.header_invalid', path: 'mcp.header', message: 'mcp.authStyle "header" requires a valid mcp.header name.', hint: 'Example: "X-Api-Key" (must match ^[A-Za-z0-9-]{1,64}$).' });
            } else if (isDeniedHeader(mcp.header, { forAuth: true })) {
                r.pushE({ code: 'mcp.header_denied', path: 'mcp.header', message: `mcp.header "${mcp.header}" is a managed transport header.`, hint: 'Use the vendor\'s key header, or authStyle "bearer" for Authorization.' });
            }
        }
        if (mcp.authStyle === 'bearer' || mcp.authStyle === 'header') {
            if (typeof mcp.valueTemplate !== 'string' || !mcp.valueTemplate) {
                r.pushE({ code: 'mcp.value_template_missing', path: 'mcp.valueTemplate', message: `mcp.authStyle "${mcp.authStyle}" requires mcp.valueTemplate.`, hint: 'Example: "Bearer {{credential.api_key}}".' });
            } else {
                checkValueTemplate(r, mcp.valueTemplate, declared, 'mcp.valueTemplate', 'mcp');
            }
        } else if (mcp.valueTemplate !== undefined) {
            r.pushE({ code: 'mcp.value_template_unexpected', path: 'mcp.valueTemplate', message: 'mcp.authStyle "none" must not carry a valueTemplate.', hint: 'Remove mcp.valueTemplate or pick an auth style that injects it.' });
        }
        if (mcp.toolAllowList !== undefined) {
            if (!Array.isArray(mcp.toolAllowList)) {
                r.pushE({ code: 'mcp.tool_allow_list_invalid', path: 'mcp.toolAllowList', message: 'mcp.toolAllowList must be an array of tool-name strings.', hint: 'Example: ["search", "fetch"]. Omit it to allow all advertised tools.' });
            } else {
                if (mcp.toolAllowList.length > MAX_TOOL_ALLOW_LIST) {
                    r.pushE({ code: 'mcp.tool_allow_list_too_many', path: 'mcp.toolAllowList', message: `${mcp.toolAllowList.length} allow-list entries; the cap is ${MAX_TOOL_ALLOW_LIST}.`, hint: 'List only the tools the org actually needs.' });
                }
                mcp.toolAllowList.forEach((t, j) => {
                    if (typeof t !== 'string' || !t || t.length > 128) {
                        r.pushE({ code: 'mcp.tool_allow_list_invalid', path: `mcp.toolAllowList[${j}]`, message: `toolAllowList entry ${j} must be a non-empty string of at most 128 chars.`, hint: 'Use the tool names the MCP server advertises.' });
                    }
                });
            }
        }
    }
}

/**
 * Derive the OpenAI tool array for a validated REST definition — used to
 * build tools_cache at activation. Pure transform, no validation: call
 * validateCustomIntegration(def, { strict: true, slug }) first.
 *
 * additionalProperties is forced to false on every derived schema, and the
 * output never aliases the input (safe to mutate / persist independently).
 * @param {{ tools?: import('./validateShared').RestToolDef[] }} def
 * @param {string} slug
 */
function deriveOpenAiTools(def, slug) {
    const tools = isObject(def) && Array.isArray(def.tools) ? def.tools : [];
    return tools.filter(isObject).map((t) => {
        const src = isObject(t.parameters) ? t.parameters : /** @type {import('./validateShared').ToolParameters} */ ({});
        /** @type {Record<string, import('./validateShared').ParamSchema>} */
        const properties = {};
        if (isObject(src.properties)) {
            for (const [pname, schema] of Object.entries(src.properties)) {
                if (!isObject(schema)) continue;
                /** @type {import('./validateShared').ParamSchema} */
                const prop = { type: schema.type };
                if (typeof schema.description === 'string') prop.description = schema.description;
                if (Array.isArray(schema.enum)) prop.enum = schema.enum.slice();
                if (schema.type === 'array' && isObject(schema.items)) {
                    prop.items = { type: schema.items.type };
                    if (typeof schema.items.description === 'string') prop.items.description = schema.items.description;
                    if (Array.isArray(schema.items.enum)) prop.items.enum = schema.items.enum.slice();
                }
                properties[pname] = prop;
            }
        }
        return {
            type: 'function',
            function: {
                name: `cint_${slug}_${t.name}`,
                description: typeof t.description === 'string' ? t.description : '',
                parameters: {
                    type: 'object',
                    properties,
                    required: Array.isArray(src.required) ? src.required.filter(r => typeof r === 'string') : [],
                    additionalProperties: false,
                },
            },
        };
    });
}

module.exports = { validateCustomIntegration, deriveOpenAiTools, isDeniedHeader };
