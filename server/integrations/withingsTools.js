/**
 * Withings Tools — read a user's health measurements, sleep and activity from
 * the Withings Health Mate API (https://wbsapi.withings.net).
 *
 * READ-ONLY on purpose. Withings data is special-category health data under
 * GDPR; a tool that could write back to a medical-adjacent device account earns
 * far more risk than it pays for, and nothing in the product needs it.
 *
 * ── Why this module normalises so aggressively ──────────────────────────
 * Withings returns measurements as nested groups of scaled integers:
 *
 *   { measuregrps: [ { grpid, date, modified,
 *                      measures: [ { value: 813, unit: -1, type: 1 } ] } ] }
 *
 * `value × 10^unit` is the real number (813 × 10⁻¹ = 81.3 kg) and `type` is a
 * numeric code. Handing that to the connector-sync column inference, to a
 * chart, or to a model would produce nonsense. So every tool here flattens to
 * ONE row per measurement with a real `value`, a human `unit`, an ISO
 * `measured_at`, and a stable `measurement_key` for upsert-on-sync.
 *
 * `modified` (epoch seconds) rides along on every row as the incremental
 * watermark, and each tool accepts `lastupdate` — the request-side parameter
 * Withings pairs it with. Together they let App Studio's connector sync detect
 * the 'request' incremental tier (connectorSchema.detectIncremental) instead of
 * refetching the user's whole history every hour.
 */

const automationAuth = require('../auth/automationAuth');
const { OAUTH_PROVIDERS } = require('../auth/permissions');
const log = require('../telemetry/log');

const API_BASE = OAUTH_PROVIDERS.withings.apiBase;
const REQUEST_TIMEOUT_MS = 30000;
// One Withings page is up to a few hundred groups; the cap keeps a runaway
// history (years of 1-minute heart rate) from filling a model's context or a
// connector's 500-row budget with a single call.
const MAX_ROWS = 500;
const DEFAULT_ROWS = 100;

// ── Measure-type dictionary ─────────────────────────────────────────
// Withings' numeric `type` → (slug, label, unit). Only the types the Health
// Mate consumer devices actually emit; an unknown code still yields a row, slug
// `type_<n>`, so a new device never silently drops data.
const MEASURE_TYPES = {
    1:   { slug: 'weight',                 label: 'Weight',                     unit: 'kg' },
    4:   { slug: 'height',                 label: 'Height',                     unit: 'm' },
    5:   { slug: 'fat_free_mass',          label: 'Fat-free mass',              unit: 'kg' },
    6:   { slug: 'fat_ratio',              label: 'Fat ratio',                  unit: '%' },
    8:   { slug: 'fat_mass',               label: 'Fat mass',                   unit: 'kg' },
    9:   { slug: 'diastolic_bp',           label: 'Diastolic blood pressure',   unit: 'mmHg' },
    10:  { slug: 'systolic_bp',            label: 'Systolic blood pressure',    unit: 'mmHg' },
    11:  { slug: 'heart_rate',             label: 'Heart rate',                 unit: 'bpm' },
    12:  { slug: 'temperature',            label: 'Temperature',                unit: '°C' },
    54:  { slug: 'spo2',                   label: 'Blood oxygen (SpO₂)',        unit: '%' },
    71:  { slug: 'body_temperature',       label: 'Body temperature',           unit: '°C' },
    73:  { slug: 'skin_temperature',       label: 'Skin temperature',           unit: '°C' },
    76:  { slug: 'muscle_mass',            label: 'Muscle mass',                unit: 'kg' },
    77:  { slug: 'hydration',              label: 'Hydration',                  unit: 'kg' },
    88:  { slug: 'bone_mass',              label: 'Bone mass',                  unit: 'kg' },
    91:  { slug: 'pulse_wave_velocity',    label: 'Pulse wave velocity',        unit: 'm/s' },
    123: { slug: 'vo2_max',                label: 'VO₂ max',                    unit: 'ml/kg/min' },
    130: { slug: 'atrial_fibrillation',    label: 'Atrial fibrillation result',  unit: '' },
    135: { slug: 'qrs_interval',           label: 'QRS interval',               unit: 'ms' },
    136: { slug: 'pr_interval',            label: 'PR interval',                unit: 'ms' },
    137: { slug: 'qt_interval',            label: 'QT interval',                unit: 'ms' },
    138: { slug: 'corrected_qt_interval',  label: 'Corrected QT interval',      unit: 'ms' },
    155: { slug: 'vascular_age',           label: 'Vascular age',               unit: 'years' },
    167: { slug: 'nerve_health_score',     label: 'Nerve health score',         unit: '' },
    168: { slug: 'extracellular_water',    label: 'Extracellular water',        unit: 'kg' },
    169: { slug: 'intracellular_water',    label: 'Intracellular water',        unit: 'kg' },
    170: { slug: 'visceral_fat',           label: 'Visceral fat',               unit: '' },
    226: { slug: 'basal_metabolic_rate',   label: 'Basal metabolic rate',       unit: 'kcal' },
};

// Slug → type code, so callers can ask for "weight" instead of 1.
const TYPE_BY_SLUG = new Map(Object.entries(MEASURE_TYPES).map(([code, m]) => [m.slug, Number(code)]));

function describeType(typeCode) {
    return MEASURE_TYPES[typeCode] || { slug: `type_${typeCode}`, label: `Measure type ${typeCode}`, unit: '' };
}

// ── Value scaling ───────────────────────────────────────────────────

/**
 * Withings stores `value × 10^unit`. Multiplying by a negative power of ten in
 * floating point re-introduces the very noise the integer encoding avoided
 * (813 × 1e-1 = 81.30000000000001), so scale by division and round to the
 * decimal count the exponent implies — the result is exactly what the app shows.
 */
function scaleMeasure(value, unit) {
    const v = Number(value);
    const e = Number(unit);
    if (!Number.isFinite(v)) return null;
    if (!Number.isFinite(e) || e === 0) return v;
    if (e > 0) return v * (10 ** e);
    const divisor = 10 ** -e;
    const scaled = v / divisor;
    // -e is the number of decimals; cap at 6 so a pathological exponent can't
    // ask toFixed for more precision than it accepts.
    return Number(scaled.toFixed(Math.min(-e, 6)));
}

function isoFromEpochSeconds(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n * 1000).toISOString();
}

function ymd(value) {
    if (value === undefined || value === null || value === '') return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
}

function epochSeconds(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Tolerate millis — a caller echoing back a JS timestamp is a likelier
        // mistake than a real 1970-era measurement.
        return Math.floor(value > 1e12 ? value / 1000 : value);
    }
    const t = Date.parse(String(value));
    if (Number.isNaN(t)) return null;
    return Math.floor(t / 1000);
}

function clampLimit(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROWS;
    return Math.min(Math.floor(n), MAX_ROWS);
}

// ── Transport ───────────────────────────────────────────────────────

/**
 * Call one Withings action. Every Withings endpoint is a POST with an `action`
 * field and form-encoded params; success and failure share HTTP 200, so the
 * envelope check lives in automationAuth.readWithingsBody (shared with the token
 * refresher, which faces the same shape).
 */
async function withingsCall(userId, path, action, params) {
    const auth = await automationAuth.getProviderAuth(userId, 'withings');
    if (!auth?.accessToken) {
        throw new Error('Withings is not connected. Connect it in Settings → Integrations.');
    }

    const form = new URLSearchParams({ action });
    for (const [k, v] of Object.entries(params || {})) {
        if (v === undefined || v === null || v === '') continue;
        form.set(k, String(v));
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form.toString(),
            signal: ac.signal,
        });
    } catch (err) {
        throw new Error(`Withings request failed (${err?.name === 'AbortError' ? 'timeout' : err.message})`);
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Withings API error ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('Withings returned a non-JSON body');
    return automationAuth.readWithingsBody(data, action);
}

// ── Normalisers ─────────────────────────────────────────────────────

/**
 * measuregrps[] → one flat row per individual measure.
 *
 * `attrib` records how the value was obtained; 1 and 4 mean "the device was
 * ambiguous about who stood on it", so they are labelled rather than dropped —
 * a weight trend that silently omits contested readings would mislead.
 */
const ATTRIB_LABELS = {
    0: 'device_confirmed',
    1: 'device_ambiguous',
    2: 'manual',
    4: 'manual_ambiguous',
    5: 'auto',
    7: 'measure_confirmed',
    8: 'same_as_device',
};

function normalizeMeasureGroups(groups, limit) {
    const rows = [];
    for (const grp of Array.isArray(groups) ? groups : []) {
        if (!grp || typeof grp !== 'object') continue;
        const measuredAt = isoFromEpochSeconds(grp.date);
        const modified = Number(grp.modified) || Number(grp.created) || Number(grp.date) || null;
        for (const m of Array.isArray(grp.measures) ? grp.measures : []) {
            if (!m || typeof m !== 'object') continue;
            const typeCode = Number(m.type);
            const meta = describeType(typeCode);
            const value = scaleMeasure(m.value, m.unit);
            if (value === null) continue;
            rows.push({
                measurement_key: `withings:meas:${grp.grpid}:${typeCode}`,
                source: 'withings',
                type: meta.slug,
                type_id: typeCode,
                label: meta.label,
                value,
                unit: meta.unit,
                measured_at: measuredAt,
                modified,
                group_id: grp.grpid ?? null,
                device_id: grp.deviceid || null,
                // 1 = "real" measurement, 2 = a user objective (a goal, not a
                // reading). Kept so a sync can filter goals out of a trend.
                category: Number(grp.category) === 2 ? 'objective' : 'real',
                attrib: ATTRIB_LABELS[Number(grp.attrib)] || null,
                comment: typeof grp.comment === 'string' ? grp.comment.slice(0, 500) : null,
            });
            if (rows.length >= limit) return rows;
        }
    }
    return rows;
}

// Sleep summary fields worth pulling. Withings returns durations in SECONDS;
// they are converted to minutes here because every consumer (chart axis, model
// answer, table column) reads minutes and nobody wants to divide by 60 twice.
const SLEEP_SECOND_FIELDS = {
    lightsleepduration: 'light_sleep_minutes',
    deepsleepduration: 'deep_sleep_minutes',
    remsleepduration: 'rem_sleep_minutes',
    wakeupduration: 'awake_minutes',
    durationtosleep: 'minutes_to_fall_asleep',
    durationtowakeup: 'minutes_to_wake_up',
    total_sleep_time: 'total_sleep_minutes',
    total_timeinbed: 'time_in_bed_minutes',
};
const SLEEP_PLAIN_FIELDS = {
    wakeupcount: 'wake_up_count',
    hr_average: 'heart_rate_average',
    hr_min: 'heart_rate_min',
    hr_max: 'heart_rate_max',
    rr_average: 'breathing_rate_average',
    snoring: 'snoring_seconds',
    sleep_score: 'sleep_score',
    apnea_hypopnea_index: 'apnea_hypopnea_index',
};

function toMinutes(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n)) return null;
    return Math.round(n / 60);
}

function normalizeSleepSeries(series, limit) {
    const rows = [];
    for (const s of Array.isArray(series) ? series : []) {
        if (!s || typeof s !== 'object') continue;
        const data = (s.data && typeof s.data === 'object') ? s.data : s;
        const row = {
            measurement_key: `withings:sleep:${s.id ?? s.date ?? s.startdate}`,
            source: 'withings',
            type: 'sleep',
            date: ymd(s.date) || (isoFromEpochSeconds(s.startdate) || '').slice(0, 10) || null,
            start_at: isoFromEpochSeconds(s.startdate),
            end_at: isoFromEpochSeconds(s.enddate),
            modified: Number(s.modified) || Number(s.enddate) || null,
            timezone: s.timezone || null,
        };
        for (const [src, dest] of Object.entries(SLEEP_SECOND_FIELDS)) {
            const v = toMinutes(data[src]);
            if (v !== null) row[dest] = v;
        }
        for (const [src, dest] of Object.entries(SLEEP_PLAIN_FIELDS)) {
            const v = Number(data[src]);
            if (Number.isFinite(v)) row[dest] = v;
        }
        // Withings only sends total_sleep_time on some plans; derive it when
        // absent so the column is never half-populated across a history.
        if (row.total_sleep_minutes === undefined) {
            const parts = [row.light_sleep_minutes, row.deep_sleep_minutes, row.rem_sleep_minutes]
                .filter((v) => Number.isFinite(v));
            if (parts.length) row.total_sleep_minutes = parts.reduce((a, b) => a + b, 0);
        }
        rows.push(row);
        if (rows.length >= limit) break;
    }
    return rows;
}

const ACTIVITY_FIELDS = {
    steps: 'steps',
    distance: 'distance_meters',
    elevation: 'elevation_meters',
    calories: 'active_calories',
    totalcalories: 'total_calories',
    soft: 'soft_activity_seconds',
    moderate: 'moderate_activity_seconds',
    intense: 'intense_activity_seconds',
    active: 'active_seconds',
    hr_average: 'heart_rate_average',
    hr_min: 'heart_rate_min',
    hr_max: 'heart_rate_max',
};

function normalizeActivities(activities, limit) {
    const rows = [];
    for (const a of Array.isArray(activities) ? activities : []) {
        if (!a || typeof a !== 'object') continue;
        const date = ymd(a.date);
        const row = {
            measurement_key: `withings:activity:${date || a.date}`,
            source: 'withings',
            type: 'activity',
            date,
            measured_at: date ? `${date}T00:00:00.000Z` : null,
            modified: Number(a.modified) || null,
            timezone: a.timezone || null,
        };
        for (const [src, dest] of Object.entries(ACTIVITY_FIELDS)) {
            const v = Number(a[src]);
            if (Number.isFinite(v)) row[dest] = v;
        }
        rows.push(row);
        if (rows.length >= limit) break;
    }
    return rows;
}

// ── Tool definitions ────────────────────────────────────────────────

// `lastupdate` is declared on every tool because it is what makes an App Studio
// connector sync incremental: connectorSchema pairs the request parameter with
// the `modified` field on the rows above and only fetches what changed.
const LASTUPDATE_PARAM = {
    type: 'integer',
    description: 'Only return entries added or changed after this Unix timestamp (seconds). Use for incremental syncs; omit for a full window.',
};

const WITHINGS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'withings_get_measures',
            description: 'Read body measurements from the user\'s Withings account (weight, body composition, blood pressure, heart rate, temperature, SpO₂, ECG intervals). Returns one flat row per measurement with a real value and unit.',
            parameters: {
                type: 'object',
                properties: {
                    types: {
                        type: 'array',
                        items: { type: 'string' },
                        description: `Measurement types to return, e.g. ["weight","systolic_bp"]. Known: ${Array.from(TYPE_BY_SLUG.keys()).join(', ')}. Omit for all types.`,
                    },
                    startDate: { type: 'string', description: 'Earliest measurement date (YYYY-MM-DD or ISO 8601).' },
                    endDate: { type: 'string', description: 'Latest measurement date (YYYY-MM-DD or ISO 8601).' },
                    lastupdate: LASTUPDATE_PARAM,
                    limit: { type: 'integer', description: `Maximum rows to return (default ${DEFAULT_ROWS}, max ${MAX_ROWS}).` },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'withings_get_sleep_summary',
            description: 'Read nightly sleep summaries from the user\'s Withings account: time in each sleep stage (minutes), wake-ups, heart and breathing rate, and sleep score.',
            parameters: {
                type: 'object',
                properties: {
                    startDate: { type: 'string', description: 'First night to include (YYYY-MM-DD).' },
                    endDate: { type: 'string', description: 'Last night to include (YYYY-MM-DD).' },
                    lastupdate: LASTUPDATE_PARAM,
                    limit: { type: 'integer', description: `Maximum nights to return (default ${DEFAULT_ROWS}, max ${MAX_ROWS}).` },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'withings_get_activity',
            description: 'Read daily activity totals from the user\'s Withings account: steps, distance, elevation, calories, time per intensity band, and heart-rate range.',
            parameters: {
                type: 'object',
                properties: {
                    startDate: { type: 'string', description: 'First day to include (YYYY-MM-DD).' },
                    endDate: { type: 'string', description: 'Last day to include (YYYY-MM-DD).' },
                    lastupdate: LASTUPDATE_PARAM,
                    limit: { type: 'integer', description: `Maximum days to return (default ${DEFAULT_ROWS}, max ${MAX_ROWS}).` },
                },
                required: [],
            },
        },
    },
];

// ── Executors ───────────────────────────────────────────────────────

function resolveTypeCodes(types) {
    if (!Array.isArray(types) || !types.length) return null;
    const codes = [];
    for (const t of types) {
        if (typeof t === 'number' && Number.isFinite(t)) { codes.push(Math.floor(t)); continue; }
        const slug = String(t || '').trim().toLowerCase();
        if (!slug) continue;
        if (TYPE_BY_SLUG.has(slug)) { codes.push(TYPE_BY_SLUG.get(slug)); continue; }
        const asNumber = Number(slug);
        if (Number.isFinite(asNumber)) codes.push(Math.floor(asNumber));
    }
    return codes.length ? Array.from(new Set(codes)) : null;
}

async function getMeasures(userId, args) {
    const limit = clampLimit(args.limit);
    const codes = resolveTypeCodes(args.types);
    // Withings pairs `lastupdate` with the group's `modified`, and startdate /
    // enddate with its `date`. Sending both is rejected, so lastupdate wins:
    // an incremental sync must not be silently narrowed by a stale window.
    const lastupdate = epochSeconds(args.lastupdate);
    const params = { category: 1 };
    if (codes) params.meastypes = codes.join(',');
    if (lastupdate !== null) {
        params.lastupdate = lastupdate;
    } else {
        const start = epochSeconds(args.startDate);
        const end = epochSeconds(args.endDate);
        if (start !== null) params.startdate = start;
        if (end !== null) params.enddate = end;
    }

    const body = await withingsCall(userId, '/measure', 'getmeas', params);
    const rows = normalizeMeasureGroups(body.measuregrps, limit);
    return {
        rows,
        rowCount: rows.length,
        truncated: rows.length >= limit,
        // The server's own clock for this response — the value to store as the
        // next sync's `lastupdate`. Withings' `updatetime` is authoritative
        // here; deriving one from the rows would re-fetch the boundary row
        // forever (or skip it, depending on the comparison).
        updatetime: Number(body.updatetime) || null,
        timezone: body.timezone || null,
    };
}

async function getSleepSummary(userId, args) {
    const limit = clampLimit(args.limit);
    const lastupdate = epochSeconds(args.lastupdate);
    const params = {
        data_fields: [
            ...Object.keys(SLEEP_SECOND_FIELDS),
            ...Object.keys(SLEEP_PLAIN_FIELDS),
        ].join(','),
    };
    if (lastupdate !== null) {
        params.lastupdate = lastupdate;
    } else {
        const start = ymd(args.startDate);
        const end = ymd(args.endDate);
        if (start) params.startdateymd = start;
        if (end) params.enddateymd = end;
        // The endpoint requires a window when lastupdate is absent; default to
        // the last 30 nights rather than returning a bare "Invalid Params".
        if (!params.startdateymd || !params.enddateymd) {
            const now = Date.now();
            params.enddateymd = params.enddateymd || new Date(now).toISOString().slice(0, 10);
            params.startdateymd = params.startdateymd
                || new Date(now - 30 * 86400_000).toISOString().slice(0, 10);
        }
    }

    const body = await withingsCall(userId, '/v2/sleep', 'getsummary', params);
    const rows = normalizeSleepSeries(body.series, limit);
    return { rows, rowCount: rows.length, truncated: rows.length >= limit, hasMore: !!body.more };
}

async function getActivity(userId, args) {
    const limit = clampLimit(args.limit);
    const lastupdate = epochSeconds(args.lastupdate);
    const params = { data_fields: Object.keys(ACTIVITY_FIELDS).join(',') };
    if (lastupdate !== null) {
        params.lastupdate = lastupdate;
    } else {
        const start = ymd(args.startDate);
        const end = ymd(args.endDate);
        params.enddateymd = end || new Date().toISOString().slice(0, 10);
        params.startdateymd = start
            || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    }

    const body = await withingsCall(userId, '/v2/measure', 'getactivity', params);
    const rows = normalizeActivities(body.activities, limit);
    return { rows, rowCount: rows.length, truncated: rows.length >= limit, hasMore: !!body.more };
}

async function executeWithingsTool(toolName, args = {}, userId) {
    if (!userId) return { error: 'Withings tools need a signed-in user.' };
    try {
        if (toolName === 'withings_get_measures') return await getMeasures(userId, args);
        if (toolName === 'withings_get_sleep_summary') return await getSleepSummary(userId, args);
        if (toolName === 'withings_get_activity') return await getActivity(userId, args);
        return { error: `Unknown Withings tool: ${toolName}` };
    } catch (err) {
        log.error('[Withings] Error:', err.message);
        return { error: err.message };
    }
}

function isWithingsTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('withings_');
}

module.exports = {
    WITHINGS_TOOLS,
    executeWithingsTool,
    isWithingsTool,
    // Exported for tests and for the App Studio table template, which needs the
    // same slug/unit vocabulary the rows carry.
    MEASURE_TYPES,
    TYPE_BY_SLUG,
    scaleMeasure,
    normalizeMeasureGroups,
    normalizeSleepSeries,
    normalizeActivities,
};
