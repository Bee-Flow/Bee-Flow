// @typecheck
/**
 * networks — who runs an address, and is it a global network's edge?
 *
 * GLOBAL NETWORKS. An address in one of these ASNs is an anycast edge: the
 * connection ends at the nearest point of presence and the service behind it
 * is somewhere the socket cannot see. Such a call is `via_network`, never
 * "in the country the database registers the prefix to" (DB-IP puts all of
 * Cloudflare in Toronto). Deliberately NOT on the ASN alone: Google Cloud
 * (396982), Amazon (16509) and Microsoft (8075) also host ordinary customer
 * VMs whose country is real. Those count as an edge only when the response
 * says so (edgeLocation.js: x-amz-cf-pop, x-azure-ref, x-msedge-ref).
 *
 * OPERATORS. The friendly company name on a row. The labels are exactly the
 * ones the ledger has always written (Cloudflare, Google, Microsoft, Amazon
 * AWS, Fastly, Akamai, OpenAI, Anthropic), because SCC attestations and the
 * alias table in compliance/lib/observedOperators.js match on those strings.
 * utils/ipOperators.js stays in front as the override (OpenAI's Cloudflare
 * prefixes are "OpenAI", not "Cloudflare"). An ASN not listed here gives no
 * operator at all, only its `as_org`: otherwise every hosting company would
 * turn up as a new supplier in the ISO A.5.20 and DORA registers.
 */

'use strict';

const { operatorForIp } = require('../../../utils/ipOperators');

/** @type {Map<number, string>} ASN → network, for ASNs that are an edge on their own. */
const GLOBAL_NETWORK_ASNS = new Map([
    [13335, 'Cloudflare'], [209242, 'Cloudflare'],
    [54113, 'Fastly'],
    [20940, 'Akamai'], [16625, 'Akamai'],
    [15169, 'Google'], // Google Front End; Google Cloud VMs are 396982 and not listed
]);

/** @type {Map<number, string>} ASN → operator label (existing labels only). */
const OPERATOR_BY_ASN = new Map([
    [15169, 'Google'], [396982, 'Google'], [36040, 'Google'], [19527, 'Google'], [139070, 'Google'],
    [8075, 'Microsoft'], [8068, 'Microsoft'], [8069, 'Microsoft'], [8070, 'Microsoft'], [12076, 'Microsoft'],
    [13335, 'Cloudflare'], [209242, 'Cloudflare'],
    [16509, 'Amazon AWS'], [14618, 'Amazon AWS'], [7224, 'Amazon AWS'], [8987, 'Amazon AWS'],
    [54113, 'Fastly'],
    [20940, 'Akamai'], [16625, 'Akamai'], [21342, 'Akamai'], [12222, 'Akamai'], [35994, 'Akamai'],
    [399358, 'Anthropic'],
]);

/** The global network an ASN belongs to, or null. */
function globalNetworkForAsn(asn) {
    return (Number.isInteger(asn) && GLOBAL_NETWORK_ASNS.get(asn)) || null;
}

/** Operator label for an address: the CIDR override first, then the ASN. null when neither knows. */
function operatorFor(ip, asn) {
    return operatorForIp(ip) || (Number.isInteger(asn) && OPERATOR_BY_ASN.get(asn)) || null;
}

module.exports = { GLOBAL_NETWORK_ASNS, OPERATOR_BY_ASN, globalNetworkForAsn, operatorFor };
