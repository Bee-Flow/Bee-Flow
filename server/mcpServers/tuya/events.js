/**
 * Trigger events the bundled Tuya MCP server can back.
 *
 * CommonJS on purpose: index.mjs is ESM (the MCP SDK is ESM-only) and requiring
 * it would start a JSON-RPC server on stdout. The API process reads this
 * sibling instead — the same split mcpServers/README.md already prescribes for
 * tuya.js.
 *
 * Tuya's cloud API has no webhook a multi-tenant SaaS can subscribe to, and
 * this codebase's MCP client speaks only listTools/callTool, so both events are
 * poll-derived: the generic poll_diff runtime calls list_devices with
 * include_status and compares each device's data points between ticks.
 *
 * Reading device state is a read-only operation — TUYA_READ_ONLY leaves it
 * alone, and TUYA_ALLOW_LOCKS gates commands, not status. A routine triggered
 * by a lock's status therefore gains no ability to operate that lock.
 */

const STATUS_SAMPLE = [
    { code: 'switch_led', value: true },
    { code: 'bright_value_v2', value: 540 },
];

const TRIGGER_SOURCES = [{
    id: 'tuya',
    label: 'Tuya Smart Home',
    order: 100,
    defaultEvent: 'device.status.changed',
    availability: { kind: 'mcp', serverId: 'tuya' },
    events: [
        {
            id: 'device.status.changed',
            label: 'Device status changed',
            fields: [
                'deviceId', 'deviceName', 'category', 'productName', 'online', 'isLock',
                'status', 'changedKeys', 'previous', 'current', 'changedAt',
            ],
            sample: {
                deviceId: 'bf12ab34cd56ef7890',
                deviceName: 'Woonkamer lamp',
                category: 'dj',
                productName: 'Smart Bulb',
                online: true,
                isLock: false,
                status: STATUS_SAMPLE,
                changedKeys: ['status.switch_led'],
                previous: { 'status.switch_led': false },
                current: { 'status.switch_led': true, 'status.bright_value_v2': 540, online: true },
                changedAt: '2026-08-02T10:14:03.115Z',
            },
            // Tuya credentials are per-user secrets, so a device event belongs
            // to exactly one subscriber and must never fan out org-wide.
            scope: 'user',
            source: {
                kind: 'poll_diff',
                tool: 'mcp_tuya_list_devices',
                args: { include_status: true, limit: 200 },
                requiresIntegration: 'mcp:tuya',
                itemsPath: 'devices',
                idPath: 'id',
                changePaths: [
                    'online',
                    // Tuya returns data points as an unordered array. Keying
                    // them means a re-ordering is not a change, and it makes
                    // changedKeys name the codes that actually moved.
                    { path: 'status', keyBy: 'code', pick: 'value' },
                ],
                emitOnAppear: false,      // adding a device is not a status change
                emitOnDisappear: false,
                firstRun: 'anchor',       // activating must not fire once per device
                // Two minutes: Tuya's quotas are per cloud project, and the MCP
                // connection pool drops idle servers after five, so a longer
                // interval would pay a process spawn on every poll.
                minIntervalMs: 120_000,
                cacheTtlMs: 15_000,
                maxItemsPerTick: 25,
                maxTrackedItems: 100,
                trackValues: true,
                emit: {
                    mode: 'item',
                    map: {
                        deviceId: 'id',
                        deviceName: 'name',
                        category: 'category',
                        productName: 'product_name',
                        online: 'online',
                        isLock: 'is_lock',
                        status: 'status',
                    },
                    includeChanges: true,
                },
            },
        },
        {
            id: 'device.online.changed',
            label: 'Device came online or went offline',
            fields: [
                'deviceId', 'deviceName', 'category', 'online', 'isLock',
                'changedKeys', 'previous', 'current', 'changedAt',
            ],
            sample: {
                deviceId: 'bf98zy76xw54vu3210',
                deviceName: 'Voordeur sensor',
                category: 'mcs',
                online: false,
                isLock: false,
                changedKeys: ['online'],
                previous: { online: true },
                current: { online: false },
                changedAt: '2026-08-02T10:14:03.115Z',
            },
            scope: 'user',
            source: {
                kind: 'poll_diff',
                tool: 'mcp_tuya_list_devices',
                // Same tool and arguments as the event above, so a user
                // subscribed to both pays for one call per pass, not two.
                args: { include_status: true, limit: 200 },
                requiresIntegration: 'mcp:tuya',
                itemsPath: 'devices',
                idPath: 'id',
                changePaths: ['online'],
                emitOnAppear: false,
                emitOnDisappear: false,
                firstRun: 'anchor',
                minIntervalMs: 120_000,
                cacheTtlMs: 15_000,
                maxItemsPerTick: 25,
                maxTrackedItems: 100,
                trackValues: true,
                emit: {
                    mode: 'item',
                    map: {
                        deviceId: 'id',
                        deviceName: 'name',
                        category: 'category',
                        online: 'online',
                        isLock: 'is_lock',
                    },
                    includeChanges: true,
                },
            },
        },
    ],
}];

module.exports = { TRIGGER_SOURCES };
