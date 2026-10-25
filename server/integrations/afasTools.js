// @typecheck noImplicitAny
/**
 * AFAS Profit Tools — Built-in tools for AI to discover and query AFAS Profit data
 *
 * AFAS exposes data through customer-defined GetConnectors behind an AppConnector
 * (token-based). Because every Profit environment has its own set of GetConnectors,
 * these tools are discovery-driven: list connectors via /metainfo, inspect a
 * connector's fields, then query it. Read-only — no UpdateConnectors.
 * Uses raw REST API — no npm dependencies.
 */

const configStore = require('../stores/configStore');
const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');
const { REQUEST_TIMEOUT_MS, DEFAULT_TAKE, MAX_TAKE, MAX_RESPONSE_CHARS, MAX_CONNECTOR_LIST, MAX_ERROR_MESSAGE_CHARS, OPERATORS, CONNECTOR_ID_RE, FIELD_RE, AFAS_TOOLS, buildBaseUrl, STATUS_REASONS } = require('./afasToolsBuildBaseUrl');

// ─── Pure helpers (exported for tests) ─────────────────────────

/**
 * Normalize a pasted AppConnector token to canonical XML form. Accepts the full
 * '<token><version>1</version><data>HEX</data></token>' XML or just the hex
 * data (whitespace-tolerant). Returns null when unrecognizable.
 * @param {unknown} raw
 */
function normalizeAfasToken(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const xmlMatch = s.match(/^<token>\s*<version>(\d+)<\/version>\s*<data>([0-9A-Fa-f\s]+)<\/data>\s*<\/token>$/i);
    if (xmlMatch) {
        const hex = xmlMatch[2].replace(/\s+/g, '');
        if (!/^[0-9A-Fa-f]{16,128}$/.test(hex)) return null;
        return `<token><version>${xmlMatch[1]}</version><data>${hex.toUpperCase()}</data></token>`;
    }
    const hex = s.replace(/\s+/g, '');
    if (/^[0-9A-Fa-f]{16,128}$/.test(hex)) {
        return `<token><version>1</version><data>${hex.toUpperCase()}</data></token>`;
    }
    return null;
}

/** @param {unknown} rawToken */
function buildAuthHeader(rawToken) {
    const xml = normalizeAfasToken(rawToken);
    if (!xml) {
        throw new Error('AFAS token is not a valid AppConnector token. Paste the token XML or its hex data.');
    }
    return `AfasToken ${Buffer.from(xml, 'utf8').toString('base64')}`;
}

/**
 * Map structured filters to AFAS filterfieldids/filtervalues/operatortypes.
 * AND-only (comma-joined); AFAS separators have no escaping, so values and
 * fields containing "," or ";" are rejected outright.
 * @param {Array<{ field?: string, operator?: string, value?: unknown }> | null | undefined} filters
 */
function buildFilterParams(filters) {
    if (!Array.isArray(filters) || filters.length === 0) return null;
    const ids = [], vals = [], ops = [];
    for (const f of filters) {
        const field = String((f && f.field) || '');
        if (!FIELD_RE.test(field) || /[,;]/.test(field)) {
            throw new Error(`Invalid filter field: "${field}"`);
        }
        const code = OPERATORS[String((f && f.operator) || 'equals').trim().toLowerCase()];
        if (!code) {
            throw new Error(`Unknown filter operator "${f.operator}". Use: ${Object.keys(OPERATORS).join(', ')}`);
        }
        const value = (code === OPERATORS.empty || code === OPERATORS.not_empty) ? '' : String(f.value ?? '');
        if (/[,;]/.test(value)) {
            throw new Error('Filter values may not contain "," or ";" (AFAS filter separators cannot be escaped). Use a shorter substring with the contains operator.');
        }
        ids.push(field);
        vals.push(value);
        ops.push(String(code));
    }
    return {
        filterfieldids: ids.join(','),
        filtervalues: vals.join(','),
        operatortypes: ops.join(','),
    };
}

/** @param {Array<{ field?: string, direction?: string }> | null | undefined} orderBy */
function buildOrderByParam(orderBy) {
    if (!Array.isArray(orderBy) || orderBy.length === 0) return null;
    /** @type {string[]} */
    const parts = [];
    for (const o of orderBy) {
        const field = String((o && o.field) || '');
        if (!FIELD_RE.test(field) || /[,;]/.test(field)) {
            throw new Error(`Invalid orderBy field: "${field}"`);
        }
        const desc = String((o && o.direction) || 'asc').trim().toLowerCase() === 'desc';
        parts.push(desc ? `-${field}` : field);
    }
    return parts.join(',');
}

/**
 * Drop trailing rows until the serialized result fits the LLM-context budget.
 * Never truncates mid-row.
 * @template T
 * @param {T[]} rows
 * @param {number} [maxChars]
 */
function truncateRows(rows, maxChars = MAX_RESPONSE_CHARS) {
    if (!Array.isArray(rows)) return { rows: [], truncated: false };
    let kept = rows;
    let truncated = false;
    while (kept.length > 1 && JSON.stringify(kept).length > maxChars) {
        kept = kept.slice(0, Math.floor(kept.length / 2));
        truncated = true;
    }
    if (kept.length > 0 && JSON.stringify(kept).length > maxChars) {
        // Even a single row blows the budget — drop it rather than flood the context.
        kept = [];
        truncated = true;
    }
    return { rows: kept, truncated };
}

// ─── API Client ────────────────────────────────────────────────

/**
 * Extract a short, sanitized error message from an AFAS error body. AFAS
 * returns XML or JSON; we only surface the human-readable message text — never
 * the raw body and never the request URL (it carries the member number and
 * filter data).
 * @param {unknown} bodyText
 */
function extractAfasErrorMessage(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return null;
    let message = null;
    const xmlMatch = bodyText.match(/<message>([\s\S]*?)<\/message>/i);
    if (xmlMatch) {
        message = xmlMatch[1];
    } else if (bodyText.trim().startsWith('{')) {
        try {
            const data = JSON.parse(bodyText);
            message = data.externalMessage || data.message || (data.error && data.error.message) || null;
        } catch (err) { fallback('integrations/afasTools:extractAfasErrorMessage', err); /* not JSON after all */ }
    }
    if (!message) return null;
    return String(message).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS) || null;
}

/**
 * The parts of an AFAS response body this module reads (metainfo, connector metadata, rows).
 * @typedef {{
 *   getConnectors?: Array<{ id: string, description?: string }>,
 *   fields?: Array<{ id: string, label?: string, dataType?: string, length?: number }>,
 *   rows?: Array<Record<string, unknown>>,
 * }} AfasResponse
 */

/**
 * @param {{ token: string, memberNumber: string, envType: string }} creds
 * @param {string} path
 * @param {Record<string, string> | null} [query]
 * @returns {Promise<AfasResponse>}
 */
async function afasRequest(creds, path, query = null) {
    const baseUrl = buildBaseUrl(creds.memberNumber, creds.envType);
    // Built outside the fetch try-block so an invalid stored token surfaces as
    // its own clear error instead of being masked as "could not reach AFAS".
    const authHeader = buildAuthHeader(creds.token);
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const url = `${baseUrl}${path}${qs}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();

    let response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': authHeader,
                'Accept': 'application/json',
            },
            // The AfasToken header must never follow a redirect off the pinned host.
            redirect: 'error',
            signal: controller.signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`AFAS request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
        }
        throw new Error('Could not reach AFAS. Check the member number and environment type.');
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        const reason = STATUS_REASONS[response.status] || `AFAS returned HTTP ${response.status}`;
        let detail = null;
        try {
            detail = extractAfasErrorMessage(await response.text());
        } catch (err) { fallback('integrations/afasTools:afasRequest', err); /* body unreadable — keep the mapped reason */ }
        throw new Error(detail ? `${reason}: ${detail}` : reason);
    }

    try {
        return /** @type {AfasResponse} */ (await response.json());
    } catch {
        throw new Error('AFAS returned an unexpected non-JSON response.');
    }
}

// ─── Tool Execution ────────────────────────────────────────────

/** @param {string} userId */
async function getAfasCredentials(userId) {
    const token = await configStore.getSecret(`afas_token_user_${userId}`);
    const memberNumber = await configStore.getSecret(`afas_member_number_user_${userId}`);
    const envType = await configStore.getSecret(`afas_env_type_user_${userId}`);
    if (!token || !memberNumber) return null;
    return { token, memberNumber, envType: envType || 'production' };
}

/**
 * @param {string} toolName
 * @param {{ connectorId?: string, take?: string, skip?: string,
 *   filters?: Parameters<typeof buildFilterParams>[0], orderBy?: Parameters<typeof buildOrderByParam>[0] }} args
 * @param {string} userId
 */
async function executeAfasTool(toolName, args, userId) {
    if (!userId) return { error: 'User context required for AFAS Profit.' };
    const creds = await getAfasCredentials(userId);
    if (!creds) {
        return { error: 'AFAS Profit not configured. Add your member number and AppConnector token in Settings.' };
    }

    try {
        if (toolName === 'afas_list_connectors') {
            log.info('[AFAS] Listing connectors');
            const meta = await afasRequest(creds, '/metainfo');
            const all = (meta && Array.isArray(meta.getConnectors)) ? meta.getConnectors : [];
            const connectors = all.slice(0, MAX_CONNECTOR_LIST).map(c => ({
                id: c.id,
                description: c.description || '',
            }));
            /** @type {{ connectors: typeof connectors, count: number, message: string, truncated?: boolean, total?: number }} */
            const result = {
                connectors,
                count: connectors.length,
                message: connectors.length === 0
                    ? 'No GetConnectors available — they must be created and authorized in the AFAS AppConnector first.'
                    : `Found ${connectors.length} GetConnector(s).`,
            };
            if (all.length > MAX_CONNECTOR_LIST) {
                result.truncated = true;
                result.total = all.length;
            }
            return result;

        } else if (toolName === 'afas_describe_connector') {
            const connectorId = String(args.connectorId || '').trim();
            if (!CONNECTOR_ID_RE.test(connectorId)) {
                return { error: 'Invalid connectorId. Use an ID from afas_list_connectors.' };
            }
            log.info(`[AFAS] Describing connector: ${connectorId}`);
            const meta = await afasRequest(creds, `/metainfo/get/${encodeURIComponent(connectorId)}`);
            const rawFields = (meta && (meta.fields || meta.rows)) || [];
            return {
                connectorId,
                fields: rawFields.map(f => ({
                    id: f.id,
                    label: f.label || '',
                    dataType: f.dataType || '',
                    length: f.length ?? null,
                })),
                count: rawFields.length,
            };

        } else if (toolName === 'afas_query') {
            const connectorId = String(args.connectorId || '').trim();
            if (!CONNECTOR_ID_RE.test(connectorId)) {
                return { error: 'Invalid connectorId. Use an ID from afas_list_connectors.' };
            }
            const take = Math.min(Math.max(parseInt(args.take) || DEFAULT_TAKE, 1), MAX_TAKE);
            const skip = Math.max(parseInt(args.skip) || 0, 0);

            /** @type {Record<string, string>} */
            const query = { skip: String(skip), take: String(take) };
            const filterParams = buildFilterParams(args.filters);
            if (filterParams) Object.assign(query, filterParams);
            const orderBy = buildOrderByParam(args.orderBy);
            if (orderBy) query.orderbyfieldids = orderBy;

            log.info(`[AFAS] Querying connector: ${connectorId} (skip=${skip}, take=${take})`);
            const data = await afasRequest(creds, `/connectors/${encodeURIComponent(connectorId)}`, query);
            const allRows = (data && Array.isArray(data.rows)) ? data.rows : [];
            const { rows, truncated } = truncateRows(allRows);

            /** @type {{ connectorId: string, rows: typeof rows, count: number, skip: number, take: number, hasMore: boolean, truncated?: boolean, message?: string }} */
            const result = {
                connectorId,
                rows,
                count: rows.length,
                skip,
                take,
                hasMore: allRows.length === take,
            };
            if (truncated) {
                result.truncated = true;
                result.message = `Response too large — showing ${rows.length} of ${allRows.length} fetched rows. Narrow with filters or lower take.`;
            }
            return result;

        } else {
            return { error: `Unknown AFAS tool: ${toolName}` };
        }
    } catch (err) {
        log.warn(`[AFAS] ${toolName} failed: ${err.message}`);
        return { error: `AFAS Profit: ${err.message}` };
    }
}

/** @param {string} toolName */
function isAfasTool(toolName) {
    return [
        'afas_list_connectors',
        'afas_describe_connector',
        'afas_query',
    ].includes(toolName);
}

module.exports = {
    AFAS_TOOLS,
    executeAfasTool,
    isAfasTool,
    // Pure helpers exported for unit tests.
    buildBaseUrl,
    normalizeAfasToken,
    buildAuthHeader,
    buildFilterParams,
    buildOrderByParam,
    truncateRows,
    extractAfasErrorMessage,
};
