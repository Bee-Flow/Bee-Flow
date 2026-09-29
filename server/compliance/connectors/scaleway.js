/**
 * Scaleway infrastructure connector — backup freshness and network exposure
 * evidence for the org's Scaleway project (A.8.13/A.8.14 backups, A.8.20/
 * A.8.22 network security). Config-state depth only: resource counts,
 * snapshot ages and firewall-rule booleans — never disk contents, user data
 * or IP inventories.
 *
 * Credential (vault provider 'scaleway', kind 'api_key'): the IAM API
 * *secret key*, read defensively as { token } or { apiKey } and sent as the
 * `X-Auth-Token` header. A read-only key is enough — IAM permission sets
 * `InstancesReadOnly` + `KubernetesReadOnly`, scoped to the project.
 * Without Kubernetes read access the sweep still runs; `clusters` is
 * recorded as null (unknown), never guessed.
 *
 * Endpoints (https://api.scaleway.com — Instance v1 + Kubernetes v1 APIs):
 *   GET /k8s/v1/regions/{region}/clusters?project_id=…&page_size=100
 *   GET /instance/v1/zones/{zone}/servers?project=…&page=…&per_page=100
 *   GET /instance/v1/zones/{zone}/snapshots?project=…&page=…&per_page=100
 *   GET /instance/v1/zones/{zone}/security_groups?project=…&page=…&per_page=100
 *   GET /instance/v1/zones/{zone}/security_groups/{id}/rules?per_page=100
 * Zones are derived from the region ({region}-1..3); a 404 on a zone means
 * "zone absent" and is skipped, not an error. Instance listings read at most
 * 3 pages (300 rows) per zone — `truncated: true` in the summary keeps the
 * cap honest.
 *
 * Summary semantics: `newest_backup_age_days` is the WORST per-server
 * freshness — the age of the stalest "newest snapshot" among servers that
 * have at least one snapshot (coverage gaps are separate:
 * `servers_with_backup` vs `servers`). `open_admin_ports` counts inbound
 * accept rules from 0.0.0.0/0 or ::/0 that reach an admin port
 * (22 SSH, 5432 PostgreSQL, 6379 Redis, 3306 MySQL).
 */

const API_BASE = 'https://api.scaleway.com';
const ADMIN_PORTS = [22, 5432, 6379, 3306];
const REGION_RE = /^[a-z]{2}-[a-z]{3}$/;
const WORLD_RANGES = new Set(['0.0.0.0/0', '::/0', '0.0.0.0', '::']);
const PER_PAGE = 100;
const MAX_PAGES = 3;
const SAMPLE_LIMIT = 10;

async function _api(safeFetch, token, path) {
    const res = await safeFetch(`${API_BASE}${path}`, {
        headers: { 'X-Auth-Token': token, 'User-Agent': 'BeeFlow-ISO-Evidence' },
        signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401) throw new Error('Scaleway API key invalid or expired');
    // 403/404 = permission missing / resource or zone absent — callers decide
    // whether that is fatal (instance evidence) or honest-null (k8s).
    if (res.status === 403 || res.status === 404) return { ok: false, status: res.status, data: null };
    if (!res.ok) throw new Error(`Scaleway API error ${res.status} on ${path.split('?')[0]}`);
    return { ok: true, status: res.status, data: await res.json() };
}

async function _pagedList(safeFetch, token, pathBase, key) {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const sep = pathBase.includes('?') ? '&' : '?';
        const res = await _api(safeFetch, token, `${pathBase}${sep}page=${page}&per_page=${PER_PAGE}`);
        if (!res.ok) return { rows: null, status: res.status, truncated: false };
        const batch = Array.isArray(res.data?.[key]) ? res.data[key] : [];
        rows.push(...batch);
        if (batch.length < PER_PAGE) return { rows, status: res.status, truncated: false };
    }
    return { rows, status: 200, truncated: true };
}

function _ageDays(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

function _isWorldRange(range) {
    const r = String(range || '').trim();
    if (!r) return true; // no restriction recorded = everyone
    return WORLD_RANGES.has(r);
}

function _ruleCoversPort(rule, port) {
    const from = rule?.dest_port_from;
    if (from === null || from === undefined) return true; // all ports
    const to = (rule?.dest_port_to === null || rule?.dest_port_to === undefined) ? from : rule.dest_port_to;
    return port >= Number(from) && port <= Number(to);
}

module.exports = {
    id: 'scaleway',
    titleKey: 'compliance.connector.scaleway.title',
    descKey: 'compliance.connector.scaleway.desc',
    coveredControls: ['A.8.13', 'A.8.14', 'A.8.20', 'A.8.22'],
    checks: ['ISO27001-A.8.13-backups', 'ISO27001-A.8.20-network-exposure'],
    credential: { provider: 'scaleway', kinds: ['api_key'] },
    settingsHint: 'region: "nl-ams", project_id: "..."',

    async collect({ secret, settings, safeFetch }) {
        const token = secret?.token || secret?.apiKey || secret?.api_key || null;
        if (!token) throw new Error('Scaleway connection has no API secret key');
        const region = String(settings?.region || 'nl-ams').trim().toLowerCase();
        if (!REGION_RE.test(region)) throw new Error(`Invalid Scaleway region "${region}" — expected e.g. "nl-ams"`);
        const projectId = settings?.project_id ? String(settings.project_id).trim() : null;
        const projectQs = projectId ? `?project=${encodeURIComponent(projectId)}` : '';

        const zonesProbed = [];
        const servers = [];   // { id, zone, name, state, volumeIds }
        const snapshots = []; // { baseVolumeId, ageDays }
        const groups = [];    // { id, zone, name, inboundDefaultAccept, openAdminRules }
        let truncated = false;

        for (const zone of [1, 2, 3].map(n => `${region}-${n}`)) {
            const sv = await _pagedList(safeFetch, token, `/instance/v1/zones/${zone}/servers${projectQs}`, 'servers');
            if (sv.rows === null) {
                if (sv.status === 404) continue; // zone does not exist for this region/account
                throw new Error(`Scaleway servers list denied (${sv.status}) in ${zone} — the key needs InstancesReadOnly`);
            }
            zonesProbed.push(zone);
            truncated = truncated || sv.truncated;
            for (const s of sv.rows) {
                if (!s?.id) continue;
                servers.push({
                    id: s.id,
                    zone,
                    name: s.name || null,
                    state: s.state || null,
                    volumeIds: Object.values(s.volumes || {}).map(v => v?.id).filter(Boolean),
                });
            }

            const sn = await _pagedList(safeFetch, token, `/instance/v1/zones/${zone}/snapshots${projectQs}`, 'snapshots');
            if (sn.rows === null) throw new Error(`Scaleway snapshots list denied (${sn.status}) in ${zone}`);
            truncated = truncated || sn.truncated;
            for (const snap of sn.rows) {
                snapshots.push({ baseVolumeId: snap?.base_volume?.id || null, ageDays: _ageDays(snap?.creation_date) });
            }

            const sg = await _pagedList(safeFetch, token, `/instance/v1/zones/${zone}/security_groups${projectQs}`, 'security_groups');
            if (sg.rows === null) throw new Error(`Scaleway security groups list denied (${sg.status}) in ${zone}`);
            truncated = truncated || sg.truncated;
            for (const g of sg.rows) {
                if (!g?.id) continue;
                // Rules share the InstancesReadOnly permission — an inaccessible
                // rule set is treated as empty (unreachable when listing worked).
                const rulesRes = await _api(safeFetch, token, `/instance/v1/zones/${zone}/security_groups/${g.id}/rules?per_page=100`);
                const rules = rulesRes.ok && Array.isArray(rulesRes.data?.rules) ? rulesRes.data.rules : [];
                const openAdminRules = [];
                for (const r of rules) {
                    if (String(r?.direction || '').toLowerCase() !== 'inbound') continue;
                    if (String(r?.action || '').toLowerCase() !== 'accept') continue;
                    const proto = String(r?.protocol || 'ANY').toUpperCase();
                    if (proto !== 'TCP' && proto !== 'ANY') continue;
                    if (!_isWorldRange(r?.ip_range)) continue;
                    for (const port of ADMIN_PORTS) {
                        if (_ruleCoversPort(r, port)) {
                            openAdminRules.push({ port, ip_range: String(r?.ip_range || '0.0.0.0/0') });
                        }
                    }
                }
                groups.push({
                    id: g.id,
                    zone,
                    name: g.name || null,
                    inboundDefaultAccept: String(g.inbound_default_policy || '').toLowerCase() === 'accept',
                    openAdminRules,
                });
            }
        }

        // Kubernetes clusters — degrade to null (unknown) without KubernetesReadOnly.
        let clusters = null;
        let clusterRows = [];
        const kubeQs = `?page_size=100${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`;
        const kres = await _api(safeFetch, token, `/k8s/v1/regions/${region}/clusters${kubeQs}`);
        if (kres.ok) {
            clusterRows = Array.isArray(kres.data?.clusters) ? kres.data.clusters : [];
            clusters = Number.isFinite(Number(kres.data?.total_count)) ? Number(kres.data.total_count) : clusterRows.length;
        }

        // Newest snapshot per volume → per-server backup freshness.
        const newestByVolume = new Map();
        for (const snap of snapshots) {
            if (!snap.baseVolumeId || snap.ageDays === null) continue;
            const prev = newestByVolume.get(snap.baseVolumeId);
            if (prev === undefined || snap.ageDays < prev) newestByVolume.set(snap.baseVolumeId, snap.ageDays);
        }
        const assignedVolumes = new Set();
        for (const s of servers) for (const v of s.volumeIds) assignedVolumes.add(v);
        const unassignedSnapshots = snapshots.filter(sn => !sn.baseVolumeId || !assignedVolumes.has(sn.baseVolumeId)).length;

        const out = [];
        let serversWithBackup = 0;
        let worstNewestAge = null;
        for (const s of servers) {
            let newest = null;
            let count = 0;
            for (const v of s.volumeIds) {
                const age = newestByVolume.get(v);
                if (age === undefined) continue;
                if (newest === null || age < newest) newest = age;
            }
            for (const snap of snapshots) {
                if (snap.baseVolumeId && s.volumeIds.includes(snap.baseVolumeId)) count++;
            }
            if (newest !== null) {
                serversWithBackup++;
                if (worstNewestAge === null || newest > worstNewestAge) worstNewestAge = newest;
            }
            out.push({
                subject_id: s.id,
                payload: {
                    type: 'server',
                    zone: s.zone,
                    name: s.name,
                    state: s.state,
                    snapshot_count: count,
                    newest_backup_age_days: newest,
                },
            });
        }
        for (const c of clusterRows) {
            if (!c?.id) continue;
            out.push({
                subject_id: c.id,
                payload: {
                    type: 'k8s_cluster',
                    region,
                    name: c.name || null,
                    status: c.status || null,
                    version: c.version || null,
                },
            });
        }

        const openSamples = [];
        let openAdminPorts = 0;
        let defaultAcceptGroups = 0;
        for (const g of groups) {
            if (g.inboundDefaultAccept) defaultAcceptGroups++;
            for (const rule of g.openAdminRules) {
                openAdminPorts++;
                if (openSamples.length < SAMPLE_LIMIT) {
                    openSamples.push({ security_group_id: g.id, zone: g.zone, port: rule.port, ip_range: rule.ip_range });
                }
            }
        }

        out.push({
            subject_id: 'summary',
            payload: {
                region,
                eu_region: /^(fr|nl|pl)-/.test(region),
                zones_probed: zonesProbed,
                servers: servers.length,
                clusters,
                snapshots: snapshots.length,
                unassigned_snapshots: unassignedSnapshots,
                servers_with_backup: serversWithBackup,
                newest_backup_age_days: worstNewestAge,
                security_groups: groups.length,
                inbound_default_accept_groups: defaultAcceptGroups,
                open_admin_ports: openAdminPorts,
                open_admin_port_samples: openSamples,
                truncated,
            },
        });
        return out;
    },
};
