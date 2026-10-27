// @typecheck
const datatableStore = require('../../../../stores/datatableStore');
const { perUserRateLimit } = require('../../../../utils/perUserRateLimit');
const reading = require('./reading');
const { deps, rejected, callerApi } = require('./linkBrowse');
const { wireRef } = require('./linkRef');
const { fallback } = require('../../../../utils/bestEffort');

/** The per-user bucket every storage-reaching call spends (see the header). */
const storageLimiter = perUserRateLimit({ windowMs: 60_000, max: 30 });

/**
 * Spend one unit of `storageLimiter` off the middleware path — for link and
 * relink, which reach the storage from an engine function rather than a
 * route of the spreadsheets router. The limiter is Express-shaped, so it is
 * handed the one thing it reads (a session with the user's id) and a
 * response whose only verb that fires is the 429; that becomes a refusal
 * the route answers like any other.
 */
function spendStorageBudget(principal) {
    const userId = (principal && principal.userId) || null;
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        const req = { session: { user: { id: userId } }, ip: 'engine' };
        let retryAfter = 60;
        const res = {
            set: (name, value) => { if (String(name).toLowerCase() === 'retry-after') retryAfter = Number(value) || retryAfter; return res; },
            status: () => res,
            json: (body) => {
                const e = Object.assign(rejected(429, 'rate_limited', (body && body.error) || 'Too many storage calls — try again in a minute.'), { retryAfter });
                reject(e);
                return res;
            },
        };
        try {
            storageLimiter(req, res, () => resolve());
        } catch (e) {
            reject(e);
        }
    }));
}

/** The tab the request names, or the first visible one; a csv has exactly one. */
function pickTab(tabs, sheet, format, ref) {
    if (!tabs.length) throw rejected(404, 'sheet_missing', 'The spreadsheet has no worksheets.', { ref: wireRef(ref.provider, ref) });
    if (format === 'csv' || sheet === undefined || sheet === null || sheet === '') return tabs.find(t => !t.hidden) || tabs[0];
    const name = String(sheet);
    const found = tabs.find(t => t.name === name);
    if (!found) {
        throw rejected(404, 'sheet_missing', `The spreadsheet has no worksheet called "${name}" (it has: ${tabs.map(t => t.name).slice(0, 10).join(', ')}).`, { ref: wireRef(ref.provider, ref, name) });
    }
    return found;
}

/**
 * Make the caller the mirror's linker, after proving they can reach the
 * file — re-pointed at another file or sheet when the body says so
 * (`{ file:{ provider, fileId, driveId?, path? }, sheet?, sharedWriteOptIn? }`).
 * Ownership, permission and the write mode are decided afresh. A
 * shared-file opt-in only survives for the SAME linker on the SAME file; a
 * new linker (whose credentials will do the writing) or a re-pointed file
 * starts read-only until the caller ticks `sharedWriteOptIn: true` in the
 * body — the consent is per file and per person, never inherited.
 */
async function relink(datatable, principal, session, body = {}) {
    const source = datatable.source || {};
    const target = body && body.file && typeof body.file === 'object' ? body.file : null;
    const provider = (target && target.provider) || source.provider;
    const ctx = await callerApi(session, principal, provider);
    // The gates are free; the probe (and a re-pointed file's tab list) is not.
    await spendStorageBudget(principal);
    const ref = target
        ? reading.fileRefOf(provider, { fileId: target.fileId, driveId: target.driveId, path: target.path })
        : reading.fileRefOf(provider, { fileId: source.file && source.file.id, driveId: source.file && source.file.driveId, path: source.file && source.file.path });
    const probe = await ctx.api.probe(ref);
    if (!probe.format) {
        throw rejected(415, 'format_unsupported', `"${probe.name}" is not a spreadsheet Bee Flow can read.`, { ref: wireRef(provider, ref) });
    }
    const viaCells = await reading.cellsAvailable(ctx.api, probe);
    let sheet = source.sheet || { id: null, name: null, index: 0 };
    if (target || (body && body.sheet !== undefined)) {
        const tabs = await reading.listSheetsOf(ctx.api, probe, { viaCells });
        const wanted = body && body.sheet !== undefined && body.sheet !== null ? body.sheet : (target ? null : sheet.name);
        const chosen = pickTab(tabs, wanted, probe.format, ref);
        sheet = { id: chosen.id ?? null, name: chosen.name || null, index: Number.isInteger(chosen.index) ? chosen.index : 0 };
    }
    // The opt-in is per file AND per linker: kept only when the same account
    // re-reads the same file; otherwise the caller ticks it again.
    const keptOptIn = !target
        && principal.userId === source.linkedByUserId
        && !!(source.write && source.write.sharedOptIn);
    const write = reading.writeModeFor({
        provider, format: probe.format, owned: probe.owned, writable: probe.writable,
        workbook: viaCells && probe.format !== 'gsheet',
        sharedOptIn: keptOptIn || (body && body.sharedWriteOptIn === true),
    });
    const d = deps();
    const org = principal.orgId ? await d.userStore.getOrganization(principal.orgId).catch((e) => fallback('core/dataEngine/sources/spreadsheetFile/linkRelink:relink', e, null)) : null;
    const ncInstanceId = provider === 'nextcloud_files'
        ? (org ? (org.nc_instance_id || org.ncInstanceId || source.ncInstanceId || null) : (source.ncInstanceId || null))
        : null;
    const repointed = !!target || (sheet.name || null) !== ((source.sheet && source.sheet.name) || null);
    const updated = await datatableStore.setSource(datatable.id, datatable.scope, {
        ...source,
        provider,
        format: probe.format,
        file: {
            id: probe.file.fileId || null,
            driveId: probe.file.driveId || null,
            path: probe.path || probe.file.path || null,
            name: probe.name || null,
            webUrl: probe.webUrl || null,
        },
        sheet,
        owned: !!probe.owned,
        write,
        ncInstanceId,
        // A re-pointed mirror keeps its columns and identity by header hash;
        // a csv sniff belongs to the file it came from.
        ...(repointed && probe.format !== 'csv' ? { csv: null } : {}),
        linkedByUserId: principal.userId,
        linkedAt: new Date().toISOString(),
    });
    require('./linkerAuth').forget(source.linkedByUserId);
    if (principal.userId !== source.linkedByUserId) require('./linkerAuth').forget(principal.userId);
    await datatableStore.markSourceStale(datatable.id, 'relink');
    return updated;
}

module.exports = { storageLimiter, spendStorageBudget, pickTab, relink };
