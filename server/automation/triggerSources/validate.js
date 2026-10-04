/**
 * Validator for trigger-source declarations.
 *
 * Returns {code, severity, path, message, hint}[] — the same record shape as
 * automation/validate.js and core/customIntegrations/validateCustomIntegration.js,
 * so an admin surface can render these with the existing component.
 *
 * This REPLACES the old static join assertion in
 * builderTools/triggerProviders.test.js, which could only see one hardcoded
 * array. This runs on every declaration from every channel — first-party
 * manifests, bundled MCP servers, and anything pushed at runtime — and is
 * stricter: it checks that `fields` and `sample` actually agree rather than
 * merely both existing.
 *
 * A declaration with any error-severity issue is REJECTED whole. Half-honouring
 * one would list an event in the builder that can never fire.
 */

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const EVENT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Availability kinds `providerIsAvailable` knows how to resolve. Anything else
// resolves to "absent", so listing it here is what makes a provider reachable.
// 'derived' marks a provider synthesised from the caller's own resolved tool
// set (see ./autoDerive.js) — reaching the availability check already means the
// user has it, so there is nothing further to resolve.
const KNOWN_AVAILABILITY = new Set(['tools', 'check', 'mcp', 'derived']);

// How an event is produced. 'poller'/'push' are the hand-written legacy paths
// (POLLERS in triggerBus.js, the per-provider routes in routes/automation/events.js);
// 'poll_diff' is the generic declaration-driven runtime.
const KNOWN_SOURCE_KINDS = new Set(['poller', 'push', 'poll_diff']);

const KNOWN_SCOPES = new Set(['user', 'org']);

function validateTriggerSource(decl, { existingIds = [] } = {}) {
    const out = [];
    const err = (code, path, message, hint) => out.push({ code, severity: 'error', path, message, hint });
    const warn = (code, path, message, hint) => out.push({ code, severity: 'warning', path, message, hint });

    if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
        err('source.not_object', '', 'A trigger-source declaration must be an object.');
        return out;
    }

    if (!PROVIDER_ID_RE.test(decl.id || '')) {
        err('source.id_invalid', 'id', 'Provider id must be lowercase kebab-case.',
            'e.g. "tuya", "google-drive". It is stored on every subscription, so it is immutable once shipped.');
    } else if ([...existingIds].includes(decl.id)) {
        err('source.id_duplicate', 'id', `Provider id "${decl.id}" is already registered.`,
            'Two integrations cannot share a provider id — saved automations would become ambiguous.');
    }

    if (!decl.label || typeof decl.label !== 'string') {
        err('source.label_missing', 'label', 'Provider needs a human-readable label.',
            'It is what the user picks in the trigger form.');
    }

    // A hidden provider is never listed, so it is never availability-checked
    // (buildAppEventProviders skips it before resolving). Requiring a rule there
    // would block the label-resolution-only declarations, e.g. github.
    if (decl.hidden && decl.availability == null) {
        // no availability needed
    } else if (!decl.availability || typeof decl.availability !== 'object'
        || !KNOWN_AVAILABILITY.has(decl.availability.kind)) {
        err('source.availability_unknown', 'availability', 'Provider needs an availability rule with a known kind.',
            `One of: ${[...KNOWN_AVAILABILITY].join(', ')}. Availability resolution is fail-closed, so an unknown kind is never listed.`);
    } else if (decl.availability.kind === 'mcp' && !decl.availability.serverId) {
        err('source.availability_mcp_no_server', 'availability.serverId',
            'An MCP availability rule needs the server id it gates on.',
            'e.g. { kind: "mcp", serverId: "tuya" } — matched against the servers this user has enabled AND credentialled.');
    }

    if (decl.order != null && typeof decl.order !== 'number') {
        err('source.order_invalid', 'order', '`order` must be a number when present.',
            'Built-ins occupy 10..80; declare 100 or higher so the builder keeps snapping new triggers to the same default provider.');
    }

    const events = Array.isArray(decl.events) ? decl.events : null;
    if (!events) {
        err('source.events_not_array', 'events', '`events` must be an array.');
        return out;
    }

    const listed = events.filter(e => e && !e.hidden);
    if (!decl.hidden && listed.length === 0) {
        err('source.no_listed_events', 'events', 'A listed provider must declare at least one listed event.',
            'Mark the provider `hidden: true` if it exists only to keep already-saved automations label-resolvable.');
    }

    const seen = new Set();
    const scopes = new Set();
    events.forEach((ev, i) => {
        const at = `events[${i}]`;
        if (!ev || typeof ev !== 'object') { err('event.not_object', at, 'Event must be an object.'); return; }

        if (!EVENT_ID_RE.test(ev.id || '')) {
            err('event.id_invalid', `${at}.id`, 'Event id must be lowercase and dotted.',
                'e.g. "device.status.changed". Like the provider id it is immutable once shipped.');
        } else if (seen.has(ev.id)) {
            err('event.id_duplicate', `${at}.id`, `Duplicate event id "${ev.id}".`);
        }
        seen.add(ev.id);

        if (!ev.label || typeof ev.label !== 'string') {
            err('event.label_missing', `${at}.label`, 'Event needs a human-readable label.');
        }

        // ── the output contract (this is the join the old test guarded) ──
        const fieldsOk = Array.isArray(ev.fields) && ev.fields.length > 0
            && ev.fields.every(f => typeof f === 'string' && f);
        if (!fieldsOk) {
            err('event.fields_missing', `${at}.fields`, 'Event must declare a non-empty array of output field names.',
                'Without it the variable picker offers no trigger.output.* paths and every downstream binding resolves to undefined.');
        }
        if (!ev.sample || typeof ev.sample !== 'object' || Array.isArray(ev.sample)) {
            err('event.sample_missing', `${at}.sample`, 'Event must declare a realistic `sample` object.',
                'The builder shows sample values so an author can bind fields without running the automation first.');
        } else if (fieldsOk) {
            for (const f of ev.fields) {
                if (!(f in ev.sample)) {
                    err('event.sample_field_missing', `${at}.sample.${f}`, `Field "${f}" has no sample value.`,
                        'Every declared field needs one — a missing sample renders as a blank row in the variable picker.');
                }
            }
        }

        // ── the runtime tie ──
        if (!ev.source || typeof ev.source !== 'object' || typeof ev.source.kind !== 'string') {
            err('event.source_missing', `${at}.source`, 'Event must declare how it is produced.',
                `Add a source spec, e.g. { kind: "poll_diff", ... }. Known kinds: ${[...KNOWN_SOURCE_KINDS].join(', ')}.`);
        } else if (!KNOWN_SOURCE_KINDS.has(ev.source.kind)) {
            err('event.source_kind_unknown', `${at}.source.kind`, `Unknown source kind "${ev.source.kind}".`,
                `Known kinds: ${[...KNOWN_SOURCE_KINDS].join(', ')}. An event with no producer would be offered and never fire.`);
        } else if (ev.source.kind === 'poll_diff') {
            out.push(...validatePollDiff(ev.source, `${at}.source`));
        }

        // ── tenancy ──
        if (!KNOWN_SCOPES.has(ev.scope)) {
            err('event.scope_invalid', `${at}.scope`, 'Event must declare `scope: "user"` or `scope: "org"`.',
                'Scope decides who an inbound event may fan out to. There is deliberately no default — an unscoped event is dropped rather than broadcast across tenants.');
        } else {
            scopes.add(ev.scope);
        }

        if (ev.deliverability && !['ok', 'connector'].includes(ev.deliverability)) {
            err('event.deliverability_invalid', `${at}.deliverability`, 'deliverability must be "ok" or "connector".');
        }
        if (ev.deliverability === 'connector' && !ev.deliverabilityNote) {
            warn('event.deliverability_note_missing', `${at}.deliverabilityNote`,
                'A connector-gated event should say what is missing.',
                'Without a note the builder falls back to generic wording.');
        }
    });

    if (scopes.size > 1) {
        err('source.scope_conflict', 'events', `Provider "${decl.id}" declares more than one scope (${[...scopes].join(', ')}).`,
            'All events of one provider must share a tenancy scope — fan-out is decided per provider, not per event.');
    }

    if (!decl.hidden && decl.defaultEvent && !listed.some(e => e.id === decl.defaultEvent)) {
        err('source.default_event_unlisted', 'defaultEvent',
            `defaultEvent "${decl.defaultEvent}" is not one of the listed events.`,
            'The trigger form snaps to defaultEvent the moment the provider is picked.');
    }

    return out;
}

function validatePollDiff(src, at) {
    const out = [];
    const err = (code, path, message, hint) => out.push({ code, severity: 'error', path, message, hint });

    if (!src.tool || typeof src.tool !== 'string') {
        err('poll.tool_missing', `${at}.tool`, 'A poll_diff source must name the tool it calls.',
            'Any tool name executeTool() understands, e.g. "mcp_tuya_list_devices".');
    }
    if (!src.requiresIntegration || typeof src.requiresIntegration !== 'string') {
        err('poll.requires_integration_missing', `${at}.requiresIntegration`,
            'A poll_diff source must name the capability the subscriber has to hold.',
            'e.g. "mcp:tuya". It is re-checked on every poll, so revoking the integration stops the polling.');
    }
    if (src.args != null && (typeof src.args !== 'object' || Array.isArray(src.args))) {
        err('poll.args_invalid', `${at}.args`, '`args` must be a plain object.',
            'Arguments are static in v1 — no per-subscription interpolation.');
    }
    if (src.auto) {
        // An auto-derived source infers its list, identity and change fields
        // from the response at poll time, so it cannot declare them up front.
        // Only the two things it genuinely knows are required.
        return out;
    }
    if (typeof src.itemsPath !== 'string') {
        err('poll.items_path_missing', `${at}.itemsPath`, '`itemsPath` must be a string (use "" for a root-level array).');
    }
    if (!src.idPath || typeof src.idPath !== 'string') {
        err('poll.id_path_missing', `${at}.idPath`, 'A poll_diff source needs `idPath` — the stable identity of one item.',
            'Without it we cannot tell "this item changed" from "a different item appeared".');
    }
    if (!Array.isArray(src.changePaths)) {
        err('poll.change_paths_missing', `${at}.changePaths`, '`changePaths` must be an array.',
            'Use [] together with emitOnAppear:true for a pure "new item" event.');
    } else {
        src.changePaths.forEach((cp, i) => {
            const ok = typeof cp === 'string' ? !!cp : (cp && typeof cp === 'object' && typeof cp.path === 'string');
            if (!ok) {
                err('poll.change_path_invalid', `${at}.changePaths[${i}]`,
                    'Each entry must be a path string or { path, keyBy?, pick? }.');
            }
        });
        if (src.changePaths.length === 0 && !src.emitOnAppear && !src.emitOnDisappear) {
            err('poll.nothing_to_detect', `${at}.changePaths`,
                'Nothing would ever fire: no change paths and neither emitOnAppear nor emitOnDisappear.',
                'Declare which fields constitute a change, or opt into appear/disappear events.');
        }
    }
    if (src.firstRun != null && src.firstRun !== 'anchor') {
        err('poll.first_run_invalid', `${at}.firstRun`, 'The only supported firstRun mode is "anchor".',
            'Anchoring records the current state and emits nothing, so activating an automation does not fire once per pre-existing item.');
    }
    if (!src.emit || typeof src.emit !== 'object') {
        err('poll.emit_missing', `${at}.emit`, 'A poll_diff source must declare how it emits.');
    } else {
        if (!['item', 'batch'].includes(src.emit.mode)) {
            err('poll.emit_mode_invalid', `${at}.emit.mode`, 'emit.mode must be "item" or "batch".');
        }
        const map = src.emit.map;
        if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length === 0) {
            err('poll.emit_map_missing', `${at}.emit.map`, 'emit.map must map output field names to paths inside an item.');
        } else if (Object.values(map).some(v => typeof v !== 'string')) {
            err('poll.emit_map_invalid', `${at}.emit.map`, 'Every emit.map value must be a path string.');
        }
    }
    if (src.trackValues && (src.maxTrackedItems ?? 0) > 100) {
        err('poll.track_values_too_many', `${at}.maxTrackedItems`,
            'trackValues:true is limited to maxTrackedItems <= 100.',
            'Previous values are stored in the subscription cursor, which has a hard 32 KB budget.');
    }
    // A contentWatch variant is a partial source spec that engages when the
    // subscription's filter names `when` (see pollDiff.resolveEffectiveSource).
    // Validate the MERGED shape — an override that only makes sense combined
    // with the base (e.g. it drops changePaths) must be caught here, not after
    // the first subscription saves one.
    if (src.contentWatch != null) {
        const cw = src.contentWatch;
        if (typeof cw !== 'object' || Array.isArray(cw)) {
            err('poll.content_watch_invalid', `${at}.contentWatch`, '`contentWatch` must be an object.');
        } else {
            if (!cw.when || typeof cw.when !== 'string') {
                err('poll.content_watch_when_missing', `${at}.contentWatch.when`,
                    '`contentWatch.when` must name the filter key that engages the variant.',
                    'e.g. "spreadsheetId" — the variant polls only for subscriptions that picked one.');
            }
            if (cw.buildArgs != null && typeof cw.buildArgs !== 'function') {
                err('poll.content_watch_buildargs_invalid', `${at}.contentWatch.buildArgs`,
                    '`buildArgs` must be a function (filter) => args.');
            }
            if (cw.argsFromFilter != null
                && (typeof cw.argsFromFilter !== 'object' || Array.isArray(cw.argsFromFilter)
                    || Object.entries(cw.argsFromFilter).some(([a, k]) => !a || typeof k !== 'string'))) {
                err('poll.content_watch_argsfromfilter_invalid', `${at}.contentWatch.argsFromFilter`,
                    '`argsFromFilter` must map argument names to filter keys, e.g. { spreadsheetId: "spreadsheetId" }.');
            }
            if (cw.emitFromFilter != null
                && (typeof cw.emitFromFilter !== 'object' || Array.isArray(cw.emitFromFilter)
                    || Object.entries(cw.emitFromFilter).some(([f, k]) => !f || typeof k !== 'string'))) {
                err('poll.content_watch_emitfromfilter_invalid', `${at}.contentWatch.emitFromFilter`,
                    '`emitFromFilter` must map payload field names to filter keys.');
            }
            const { contentWatch: _cw, argsFromFilter: _af, buildArgs: _ba, emitFromFilter: _ef, ...cwSpec } = cw;
            const { contentWatch: _baseCw, ...base } = src;
            out.push(...validatePollDiff({ ...base, ...cwSpec }, `${at}.contentWatch`));
        }
    }
    return out;
}

module.exports = {
    validateTriggerSource,
    KNOWN_AVAILABILITY,
    KNOWN_SOURCE_KINDS,
    KNOWN_SCOPES,
};
