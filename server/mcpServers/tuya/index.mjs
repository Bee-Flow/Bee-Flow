#!/usr/bin/env node
/**
 * Tuya MCP server (first-party, bundled).
 *
 * Tuya publishes no MCP server that a client can connect to for device control
 * — `tuya/tuya-mcp-sdk` points the other way (it exposes your capabilities to
 * Tuya's own agent, in Python/Go/C#), and MCP Management on the developer
 * platform is about registering servers *into* Tuya. The third-party device
 * servers are Python and would be handed the user's Tuya Access Secret, so this
 * ships as a bundled server instead: the process is spawned by
 * core/mcpManager.js with the user's own credentials injected as env vars, and
 * it speaks nothing but HTTPS to the Tuya data center the user picked.
 *
 * The Cloud OpenAPI is plain HTTPS with an HMAC-SHA256 signature, so this needs
 * no dependency beyond node:crypto and fetch. The signing lives in tuya.js.
 *
 * Env (per-user credentials injected by the MCP manager; operator env on the
 * API container supplies defaults for any of them):
 *   TUYA_ACCESS_ID       cloud project Access ID
 *   TUYA_ACCESS_SECRET   cloud project Access Secret
 *   TUYA_UID             linked Smart Life app account UID (optional — without
 *                        it we list every device in the cloud project)
 *   TUYA_REGION          eu | weu | us | cn | in   (default eu)
 *   TUYA_BASE_URL        operator override, wins over TUYA_REGION
 *   TUYA_READ_ONLY       operator flag — drops every write tool
 *   TUYA_ALLOW_LOCKS     operator flag — allows commands to locks and gates
 *
 * ESM because @modelcontextprotocol/sdk is ESM-only; the helpers stay CommonJS
 * so node --test can require them.
 *
 * NOTE: stdout is the JSON-RPC channel. Never console.log here — diagnostics go
 * to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import helpers from './tuya.js';

const {
    readConfig,
    requireCredentials,
    clampLimit,
    canonicalUrl,
    signRequest,
    scrubSecrets,
    isLockDevice,
    summarizeDevice,
    filterDevices,
    matchDevice,
    parseSpecValues,
    percentToRaw,
    summarizeStatus,
    findSwitchCode,
    validateCommands,
    allowedTools,
} = helpers;

const config = readConfig(process.env);

/** How long a cached device list stays fresh — long enough to make name resolution cheap. */
const DEVICE_CACHE_MS = 60 * 1000;
/** Paging cap for the project-wide device list, so a big project cannot stall a tool call. */
const MAX_PROJECT_DEVICES = 500;
const HTTP_TIMEOUT_MS = 15000;

// ─── Tool definitions ───────────────────────────────────────────────
const DEVICE_PROP = {
    type: 'string',
    description: 'Device id, or the device name as it appears in the Smart Life app (e.g. "Woonkamer lamp").',
};

const TOOLS = [
    {
        name: 'list_devices',
        description:
            'List the smart devices on the linked Tuya / Smart Life account, with id, name, category, product and online state. ' +
            'Start here — the ids and names returned are what every other tool takes.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Filter on name, product or category (substring, case-insensitive).' },
                online: { type: 'boolean', description: 'true = only online devices, false = only offline.' },
                category: { type: 'string', description: 'Exact Tuya category code, e.g. "dj" (light) or "cz" (socket).' },
                limit: { type: 'integer', description: 'Max results, 1-200 (default 50).' },
                include_status: {
                    type: 'boolean',
                    description: 'Include each device\'s raw data points (code/value pairs). Used by status-change triggers; costs no extra API calls.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'get_device_status',
        description:
            'Read the current state of one device — every data point it reports, decorated with the unit, ' +
            'scaled value and percentage from its product specification.',
        inputSchema: {
            type: 'object',
            properties: { device: DEVICE_PROP },
            required: ['device'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_device_functions',
        description:
            'Get what a device accepts: its instruction set (codes, types and ranges) and the status codes it reports. ' +
            'Call this before send_command when you are unsure which codes a device supports.',
        inputSchema: {
            type: 'object',
            properties: { device: DEVICE_PROP },
            required: ['device'],
            additionalProperties: false,
        },
    },
    {
        name: 'send_command',
        description:
            'Send raw instructions to a device. Codes are validated against the device specification first. ' +
            'Prefer switch_device and set_light for ordinary on/off and lighting changes.',
        inputSchema: {
            type: 'object',
            properties: {
                device: DEVICE_PROP,
                commands: {
                    type: 'array',
                    description: 'Instructions, e.g. [{"code":"switch_1","value":true}].',
                    items: {
                        type: 'object',
                        properties: {
                            code: { type: 'string', description: 'Instruction code from get_device_functions.' },
                            value: { description: 'Value — boolean, number, string or object, per the code\'s type.' },
                        },
                        required: ['code', 'value'],
                    },
                },
            },
            required: ['device', 'commands'],
            additionalProperties: false,
        },
    },
    {
        name: 'switch_device',
        description: 'Turn a device on or off. Finds the right switch code for the product itself.',
        inputSchema: {
            type: 'object',
            properties: {
                device: DEVICE_PROP,
                on: { type: 'boolean', description: 'true = on, false = off.' },
            },
            required: ['device', 'on'],
            additionalProperties: false,
        },
    },
    {
        name: 'set_light',
        description:
            'Adjust a lamp: brightness, white colour temperature, or colour. Values are percentages and degrees — ' +
            'the per-product ranges Tuya actually wants are worked out from the device specification.',
        inputSchema: {
            type: 'object',
            properties: {
                device: DEVICE_PROP,
                brightness: { type: 'integer', description: 'Brightness 0-100 %.' },
                color_temp: { type: 'integer', description: 'White temperature 0-100 % (0 = warmest).' },
                color: {
                    type: 'object',
                    description: 'Colour in HSV. Switches the lamp to colour mode.',
                    properties: {
                        hue: { type: 'integer', description: 'Hue 0-360°.' },
                        saturation: { type: 'integer', description: 'Saturation 0-100 %.' },
                        brightness: { type: 'integer', description: 'Value/brightness 0-100 %.' },
                    },
                    required: ['hue'],
                },
            },
            required: ['device'],
            additionalProperties: false,
        },
    },
    {
        name: 'list_scenes',
        description: 'List the tap-to-run scenes ("Smart" scenes) configured on the account, per home.',
        inputSchema: {
            type: 'object',
            properties: {
                home_id: { type: 'string', description: 'Limit to one home. Defaults to every home on the account.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'trigger_scene',
        description: 'Run a tap-to-run scene by id or name, as if the user tapped it in the app.',
        inputSchema: {
            type: 'object',
            properties: {
                scene: { type: 'string', description: 'Scene id or name from list_scenes.' },
                home_id: { type: 'string', description: 'Home the scene belongs to — only needed to disambiguate.' },
            },
            required: ['scene'],
            additionalProperties: false,
        },
    },
];

// ─── Tuya Cloud transport ───────────────────────────────────────────
let token = null;          // { accessToken, expiresAt }
let deviceCache = null;    // { devices, fetchedAt }

/** One signed request. `auth: false` is the token endpoint, which signs without a token. */
async function request(method, path, { query, body, auth = true } = {}) {
    requireCredentials(config);

    const url = canonicalUrl(path, query);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const accessToken = auth ? await getAccessToken() : '';

    const headers = signRequest({
        method,
        url,
        body: payload,
        accessId: config.accessId,
        accessSecret: config.accessSecret,
        accessToken,
        t: Date.now(),
    });
    if (payload) headers['Content-Type'] = 'application/json';

    let response;
    try {
        response = await fetch(`${config.baseUrl}${url}`, {
            method,
            headers,
            body: payload || undefined,
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
    } catch (err) {
        throw new Error(`Tuya request failed: ${err.message}`);
    }

    if (!response.ok) {
        throw new Error(`Tuya returned HTTP ${response.status} for ${method} ${path}`);
    }

    const json = await response.json();
    if (json.success === false) {
        // 1010/1011 = token expired or invalid. Drop it so the next call re-mints.
        if (json.code === 1010 || json.code === 1011) token = null;
        throw new Error(`Tuya API error ${json.code}: ${json.msg || 'unknown error'}`);
    }
    return json.result;
}

async function getAccessToken() {
    if (token && token.expiresAt > Date.now() + 60000) return token.accessToken;

    const result = await request('GET', '/v1.0/token', { query: { grant_type: 1 }, auth: false });
    if (!result || !result.access_token) throw new Error('Tuya did not return an access token');

    token = {
        accessToken: result.access_token,
        // expire_time is in seconds from now.
        expiresAt: Date.now() + Math.max(60, Number(result.expire_time) || 7200) * 1000,
    };
    return token.accessToken;
}

/**
 * Fetch every device we can see.
 *
 * With a linked app account UID we ask for that account's devices. Without one
 * we page the project's associated-user devices instead, capped so a large
 * project cannot stall a tool call — the cap is reported, never silent.
 */
async function fetchDevices() {
    if (config.uid) {
        const result = await request('GET', `/v1.0/users/${encodeURIComponent(config.uid)}/devices`);
        return { devices: Array.isArray(result) ? result : [], truncated: false };
    }

    const devices = [];
    let lastRowKey = '';
    let truncated = false;

    for (;;) {
        const result = await request('GET', '/v1.0/iot-01/associated-users/devices', {
            query: { page_size: 100, last_row_key: lastRowKey },
        });
        devices.push(...(result?.devices || []));

        if (devices.length >= MAX_PROJECT_DEVICES) {
            truncated = !!result?.has_more;
            devices.length = MAX_PROJECT_DEVICES;
            break;
        }
        if (!result?.has_more || !result?.last_row_key) break;
        lastRowKey = result.last_row_key;
    }

    return { devices, truncated };
}

async function getDevices({ refresh = false } = {}) {
    if (!refresh && deviceCache && Date.now() - deviceCache.fetchedAt < DEVICE_CACHE_MS) {
        return deviceCache;
    }
    const { devices, truncated } = await fetchDevices();
    deviceCache = { devices, truncated, fetchedAt: Date.now() };
    return deviceCache;
}

/** Resolve a device reference to the raw device object, or explain why we cannot. */
async function resolveDevice(reference) {
    const ref = String(reference ?? '').trim();
    if (!ref) throw new Error('A device id or name is required');

    const { devices } = await getDevices();
    const { device, candidates } = matchDevice(devices, ref);
    if (device) return device;

    if (candidates.length > 1) {
        const names = candidates.map((d) => `${d.name} (${d.id})`).join(', ');
        throw new Error(`"${ref}" matches more than one device: ${names}. Use the id.`);
    }

    // Not in the list — it may still be a valid id in the project, so ask Tuya.
    if (/^[a-z0-9]{12,}$/i.test(ref)) {
        const detail = await request('GET', `/v1.0/devices/${encodeURIComponent(ref)}`);
        if (detail && (detail.id || detail.name)) return detail;
    }
    throw new Error(`No device matches "${ref}". Call list_devices to see what is available.`);
}

const specCache = new Map();
async function getSpecification(deviceId) {
    if (specCache.has(deviceId)) return specCache.get(deviceId);
    let spec = {};
    try {
        spec = (await request('GET', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/specification`)) || {};
    } catch (err) {
        // Not every product publishes a spec; that only costs us the decoration.
        process.stderr.write(`[tuya-mcp] no specification for ${deviceId}: ${err.message}\n`);
    }
    specCache.set(deviceId, spec);
    return spec;
}

/**
 * Refuse to command locks, safes and gate openers unless the operator opted in.
 *
 * An agent acts on text it did not write. Without this guard a prompt-injected
 * e-mail or web page would be one tool call away from opening a front door.
 */
function assertCommandable(device) {
    if (isLockDevice(device) && !config.allowLocks) {
        throw new Error(
            `"${device.name || device.id}" is a lock, safe or gate opener. Controlling it from an assistant is ` +
            'disabled — an operator must set TUYA_ALLOW_LOCKS=1 to allow it. Reading its status is still allowed.'
        );
    }
}

async function issueCommands(device, commands) {
    assertCommandable(device);
    const deviceId = device.id || device.device_id;
    await request('POST', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`, {
        body: { commands },
    });
    return { device: summarizeDevice(device), sent: commands };
}

// ─── Tool handlers ──────────────────────────────────────────────────
const handlers = {
    async list_devices(args = {}) {
        const { devices, truncated } = await getDevices();
        const matched = filterDevices(devices, args);
        const limit = clampLimit(args.limit);

        return {
            total: matched.length,
            returned: Math.min(matched.length, limit),
            // Only ever true when a project-wide listing hit the paging cap.
            truncated: truncated || matched.length > limit,
            source: config.uid ? 'linked app account' : 'cloud project',
            // The device listing already carries each device's data points, so
            // include_status is free — no per-device call. Raw code/value pairs
            // only: spec decoration would cost one /specification request per
            // device, and change detection compares values, not units.
            // Reading state is a read: TUYA_READ_ONLY does not restrict it, and
            // TUYA_ALLOW_LOCKS gates commands rather than status.
            devices: matched.slice(0, limit).map(d => (args.include_status
                ? { ...summarizeDevice(d), status: Array.isArray(d.status) ? d.status : [] }
                : summarizeDevice(d))),
        };
    },

    async get_device_status(args = {}) {
        const device = await resolveDevice(args.device);
        const deviceId = device.id || device.device_id;
        const [status, specification] = await Promise.all([
            request('GET', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`),
            getSpecification(deviceId),
        ]);

        return {
            device: summarizeDevice(device),
            status: summarizeStatus(status, specification),
        };
    },

    async get_device_functions(args = {}) {
        const device = await resolveDevice(args.device);
        const deviceId = device.id || device.device_id;
        const specification = await getSpecification(deviceId);

        return {
            device: summarizeDevice(device),
            commandable: !isLockDevice(device) || config.allowLocks,
            functions: (specification.functions || []).map((f) => ({
                code: f.code,
                type: f.type,
                values: parseSpecValues(f.values),
            })),
            status_codes: (specification.status || []).map((s) => ({
                code: s.code,
                type: s.type,
                values: parseSpecValues(s.values),
            })),
        };
    },

    async send_command(args = {}) {
        const device = await resolveDevice(args.device);
        const deviceId = device.id || device.device_id;
        const specification = await getSpecification(deviceId);
        const commands = validateCommands(args.commands, specification);

        return issueCommands(device, commands);
    },

    async switch_device(args = {}) {
        if (typeof args.on !== 'boolean') throw new Error('"on" must be true or false');

        const device = await resolveDevice(args.device);
        const deviceId = device.id || device.device_id;
        const specification = await getSpecification(deviceId);

        const code = findSwitchCode(specification);
        if (!code) {
            throw new Error(
                `"${device.name || deviceId}" has no on/off instruction. Use get_device_functions to see what it accepts.`
            );
        }
        return issueCommands(device, [{ code, value: args.on }]);
    },

    async set_light(args = {}) {
        const device = await resolveDevice(args.device);
        const deviceId = device.id || device.device_id;
        const specification = await getSpecification(deviceId);
        const functions = specification.functions || [];
        const find = (...codes) => functions.find((f) => codes.includes(f.code));

        const commands = [];
        const wantsColour = args.color && typeof args.color === 'object';

        if (typeof args.brightness === 'number') {
            const spec = find('bright_value_v2', 'bright_value');
            if (!spec) throw new Error(`"${device.name || deviceId}" does not support brightness`);
            commands.push({ code: spec.code, value: percentToRaw(args.brightness, spec) });
        }

        if (typeof args.color_temp === 'number') {
            const spec = find('temp_value_v2', 'temp_value');
            if (!spec) throw new Error(`"${device.name || deviceId}" does not support colour temperature`);
            commands.push({ code: spec.code, value: percentToRaw(args.color_temp, spec) });
        }

        if (wantsColour) {
            const spec = find('colour_data_v2', 'colour_data');
            if (!spec) throw new Error(`"${device.name || deviceId}" does not support colour`);
            const ranges = parseSpecValues(spec.values);
            const hueRange = ranges.h || { min: 0, max: 360 };
            const hue = Math.min(hueRange.max ?? 360, Math.max(hueRange.min ?? 0, Math.round(Number(args.color.hue) || 0)));

            commands.push({
                code: spec.code,
                value: {
                    h: hue,
                    s: percentToRaw(args.color.saturation ?? 100, ranges.s || { min: 0, max: 1000 }),
                    v: percentToRaw(args.color.brightness ?? 100, ranges.v || { min: 0, max: 1000 }),
                },
            });
        }

        if (commands.length === 0) {
            throw new Error('Set at least one of "brightness", "color_temp" or "color"');
        }

        // A lamp ignores colour data while it is in white mode, and vice versa.
        const workMode = find('work_mode');
        if (workMode) {
            const mode = wantsColour ? 'colour' : 'white';
            const allowed = parseSpecValues(workMode.values).range || [];
            if (allowed.length === 0 || allowed.includes(mode)) {
                commands.unshift({ code: workMode.code, value: mode });
            }
        }

        return issueCommands(device, commands);
    },

    async list_scenes(args = {}) {
        const homes = args.home_id ? [{ home_id: args.home_id, name: null }] : await fetchHomes();
        const scenes = [];

        for (const home of homes) {
            const result = await request('GET', '/v2.0/cloud/scene/rule', {
                query: { space_id: home.home_id, type: 'scene' },
            });
            const list = Array.isArray(result) ? result : result?.list || [];
            for (const scene of list) {
                scenes.push({
                    id: scene.id || scene.scene_id,
                    name: scene.name || '',
                    home_id: String(home.home_id),
                    home_name: home.name,
                    enabled: scene.status !== false && scene.enabled !== false,
                });
            }
        }

        return { total: scenes.length, scenes };
    },

    async trigger_scene(args = {}) {
        const reference = String(args.scene ?? '').trim();
        if (!reference) throw new Error('A scene id or name is required');

        const { scenes } = await handlers.list_scenes(args.home_id ? { home_id: args.home_id } : {});
        const needle = reference.toLowerCase();
        let match = scenes.find((s) => s.id === reference);
        if (!match) {
            const byName = scenes.filter((s) => s.name.toLowerCase() === needle);
            const partial = byName.length ? byName : scenes.filter((s) => s.name.toLowerCase().includes(needle));
            if (partial.length > 1) {
                throw new Error(
                    `"${reference}" matches more than one scene: ${partial.map((s) => `${s.name} (${s.id})`).join(', ')}. Use the id.`
                );
            }
            match = partial[0];
        }
        if (!match) throw new Error(`No scene matches "${reference}". Call list_scenes to see what is available.`);

        await request('POST', `/v2.0/cloud/scene/rule/${encodeURIComponent(match.id)}/actions/trigger`);
        return { triggered: true, scene: match };
    },
};

async function fetchHomes() {
    if (!config.uid) {
        throw new Error(
            'Scenes need a linked app account. Add your Smart Life app account UID (TUYA_UID) under Settings → Integrations.'
        );
    }
    const result = await request('GET', `/v1.0/users/${encodeURIComponent(config.uid)}/homes`);
    const homes = Array.isArray(result) ? result : result?.list || [];
    return homes.map((home) => ({ home_id: home.home_id ?? home.id, name: home.name || '' }));
}

// ─── Wire up the MCP server ─────────────────────────────────────────
const server = new Server(
    { name: 'tuya', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allowedTools(TOOLS, config),
}));

server.setRequestHandler(CallToolRequestSchema, async (request_) => {
    const { name, arguments: args } = request_.params;

    const available = allowedTools(TOOLS, config);
    if (!available.some((t) => t.name === name)) {
        const reason = TOOLS.some((t) => t.name === name)
            ? `Tool "${name}" is disabled — this Tuya connection is read-only.`
            : `Unknown tool: ${name}`;
        return { content: [{ type: 'text', text: reason }], isError: true };
    }

    try {
        const result = await handlers[name](args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
        // Tuya echoes request details back in some error payloads — never let the
        // access secret or a live token ride out on an error string.
        const message = scrubSecrets(String(err.message || err), config, token?.accessToken);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

await server.connect(new StdioServerTransport());
process.stderr.write(
    `[tuya-mcp] ready (${config.region}, ${config.readOnly ? 'read-only' : 'read-write'}` +
    `${config.allowLocks ? ', locks allowed' : ''})\n`
);
