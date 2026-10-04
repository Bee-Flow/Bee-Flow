/**
 * Builder tools — which catalog tool the model meant, and whether this user
 * may run it: the name read out of whatever key it arrived under, the refusal
 * for a tool this user does not have (or a built-in step type passed where a
 * tool belongs), and the already-built identical call.
 */

/**
 * Reject a tool this user cannot run, and a built-in step TYPE passed where a
 * catalog tool belongs.
 *
 * `_availableToolNames` is the per-request resolved set (org ∩ group ∩ toggle ∩
 * entitlement ∩ credentials, plus MCP / custom / automation / Step tools) — the
 * same answer the RUNNER checks against. Before it existed, this function's
 * first test was "does the catalog know this tool's schema", which is a
 * question about the product, not about the user: it returned true for
 * `gmail_search` on an org with no Gmail, and the step was built, saved,
 * validated clean and finalised, failing only at run time with "you no longer
 * have permission" — pointing the user at an admin who had nothing to toggle.
 *
 * When the set is ABSENT the old permissive behaviour stands. That is not
 * laziness: the MCP surface attaches no catalog (mcpBuilder.loadDraft), and
 * refusing everything there would break a working integration outright. Absent
 * means "we were not told", which is different from "the user does not have
 * it" — the distinction buildCatalogForUser now refuses to blur.
 */
function availableListHint(available) {
    if (!available) return '';
    const names = [...available].slice(0, 40);
    return names.length
        ? `Tools you can use here: ${names.join(', ')}${available.size > names.length ? ', …' : ''}.`
        : 'This user has no integrations connected, so no integration_action step is possible at all.';
}

// Where a tool name lands when it is not in `tool`. Measured 2026-09-12: a
// nextcloud_read_file entry in a batch arrived with no `tool` string and
// was refused with "needs a `tool` name from the catalog" — a message that
// names no candidate — after which the model DROPPED the read step and bound
// the extraction to the file's path. The keys are the ones the fast models
// reach for; `inputs.tool` is the mirror of the data_extraction `inputs`
// wrapper; `app` + `action` is the two-word form ("nextcloud" / "read_file").
const TOOL_NAME_KEYS = ['toolName', 'tool_name', 'toolId', 'tool_id', 'name', 'action', 'operation', 'integration', 'command'];
const toolTokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
// What a tool name can look like at all: catalog names are snake_case, MCP
// names are `mcp_<server>_<tool>` with the tool's own casing kept
// (core/mcpManager.js) — so identifier shape, not lowercase.
const TOOL_IDENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Find the tool name the model meant when `args.tool` is not a usable
 * string. Returns { tool, from, note } — `tool` null when nothing plausible
 * was found, `from` the key it was read from ('toolName', 'inputs.tool',
 * 'app + action', …). A name that is not in the available set is matched by
 * its tokens ("read_file", "nextcloud read file", "Nextcloud: Read file")
 * against the set, and taken only when exactly ONE available tool contains
 * them all.
 *
 * Without a set (the MCP surface attaches none) a candidate is taken only
 * when it has identifier shape AND did not come out of the inputs map (other
 * than `inputs.tool`): measured, builder_add_action({inputs:{name:"Weekly
 * report", path:"/x"}}) minted an integration_action whose tool was the
 * literal string "Weekly report".
 */
function resolveToolName(args, draftWrap) {
    const available = draftWrap && draftWrap._availableToolNames;
    const raw = [];
    const push = (v, from) => {
        if (typeof v === 'string' && v.trim()) raw.push({ v: v.trim(), from });
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const k of ['name', 'id', 'tool']) if (typeof v[k] === 'string' && v[k].trim()) { raw.push({ v: v[k].trim(), from: `${from}.${k}` }); break; }
        }
    };
    push(args.tool, 'tool');
    for (const k of TOOL_NAME_KEYS) push(args[k], k);
    if (args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)) {
        for (const k of ['tool', ...TOOL_NAME_KEYS]) push(args.inputs[k], `inputs.${k}`);
    }
    if (args.spec && typeof args.spec === 'object' && !Array.isArray(args.spec)) push(args.spec.tool, 'spec.tool');
    if (typeof args.app === 'string' && args.app.trim()) {
        const verb = ['action', 'operation', 'op', 'method', 'name'].map(k => args[k]).find(v => typeof v === 'string' && v.trim());
        if (verb) raw.push({ v: `${args.app.trim()} ${verb.trim()}`, from: 'app + action' });
    }
    for (const { v, from } of raw) {
        if (available ? available.has(v) : (TOOL_IDENT_RE.test(v) && (!from.startsWith('inputs.') || from === 'inputs.tool'))) {
            return { tool: v, from, note: from === 'tool' ? null : `the tool name was read from "${from}" — write it as tool:"${v}".` };
        }
        if (!available) continue;
        const cand = toolTokens(v);
        if (!cand) continue;
        if (available.has(cand)) return { tool: cand, from, note: `tool "${v}" read as "${cand}".` };
        const want = cand.split('_').filter(Boolean);
        const hits = [...available].filter(n => { const have = n.split('_'); return want.every(t => have.includes(t)); });
        if (hits.length === 1) return { tool: hits[0], from, note: `tool "${v}" read as "${hits[0]}" — use the exact catalog name.` };
    }
    return { tool: null, from: null, note: null };
}

function unknownToolError(tool, draftWrap, { label = null } = {}) {
    if (!tool || typeof tool !== 'string') {
        const available = draftWrap && draftWrap._availableToolNames;
        return { error: `builder_add_action needs a \`tool\` name from the catalog${label ? ` — the step "${label}" has none` : ''}. Write tool:"<exact name>" at the top level of the step, next to inputs. ${availableListHint(available)}`.trim(),
                 _fixHint: 'Reject reason: the step names no tool. Add tool:"<exact catalog name>" to this step and resend it — the rest of the step was not checked yet.' };
    }
    const available = draftWrap && draftWrap._availableToolNames;
    // No catalog to check against (the MCP surface): a name that is not even
    // identifier-shaped is free text, never a tool — belt and braces behind
    // resolveToolName's own guard, for a `tool` the caller wrote itself.
    if (!available && !TOOL_IDENT_RE.test(tool)) {
        return {
            error: `"${tool}" is not a tool name — tool names are identifiers like nextcloud_read_file.`,
            _fixHint: 'Reject reason: the tool name is free text, not a catalog identifier. Write tool:"<exact catalog name>" and resend the same step.',
        };
    }
    if (available && !available.has(tool)) {
        const { isBuiltinStepType: isStepType } = require('../../builtinStepTools');
        // A step type named as a tool is a different mistake with a different
        // fix, so let the branch below answer it rather than "not connected".
        if (!isStepType(tool)) {
            const { findOwnerOfTool } = require('../../toolRegistry');
            let owner = null;
            try { owner = findOwnerOfTool(tool); } catch (_) { /* registry hiccup — treat as unknown */ }
            const list = availableListHint(available);
            if (owner) {
                return {
                    error: `"${tool}" is a ${owner.label} action, and ${owner.label} is not connected for this user — no step can call it.`,
                    _fixHint: `Do not add this step. Tell the user to connect ${owner.label} first, then build it. ${list}`,
                };
            }
            return {
                error: `There is no tool called "${tool}" available to this user.`,
                _fixHint: `Use an exact name from the catalog, or a built-in step type that needs no integration (http_request, ai_step, condition, loop, notification). ${list}`,
            };
        }
    }
    if (draftWrap && draftWrap._inputSchemasByTool && draftWrap._inputSchemasByTool[tool]) return null;
    const { isBuiltinStepType, builderToolForStepType } = require('../../builtinStepTools');
    if (!isBuiltinStepType(tool)) return null;
    const right = builderToolForStepType(tool);
    // An explicit _fixHint is mandatory: applyToolCall stamps every errored
    // result that lacks one with "invalid input binding", which would send the
    // model off fixing a binding it got right.
    return {
        error: `"${tool}" is a built-in step type, not a catalog tool — builder_add_action only creates integration_action steps.`,
        _fixHint: right
            ? `Call ${right} instead, with the same afterStepId / branch arguments.`
            : `There is no add tool for "${tool}" — pick a real tool name from the catalog instead.`,
    };
}

/**
 * An existing integration_action with the SAME tool and the SAME bound inputs.
 *
 * Nothing used to detect this: only identifier duplicates were checked, so a
 * model that lost track of what it had already built could add a second
 * identical `nextcloud_list_files` and get a clean success. Observed in real
 * builds — the graph ends up listing the same folder twice and writing the
 * same spreadsheet twice, which validates perfectly and is obviously wrong on
 * the canvas.
 *
 * Scoped deliberately narrowly: same TYPE, same TOOL, byte-identical INPUTS,
 * in the same graph. Two genuinely-identical calls are almost always a mistake,
 * and where they are not (the same notification on two branches) the author can
 * vary an input. Label is ignored on purpose — it is cosmetic, so including it
 * would let a renamed copy through.
 */
function findDuplicateAction(graph, tool, inputs) {
    const target = JSON.stringify(inputs || {});
    for (const s of (graph?.steps || [])) {
        if (!s || s.type !== 'integration_action' || s.tool !== tool) continue;
        if (JSON.stringify(s.inputs || {}) === target) return s;
    }
    return null;
}

module.exports = {
    resolveToolName,
    unknownToolError,
    findDuplicateAction,
};
