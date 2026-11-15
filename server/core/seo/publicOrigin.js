// @typecheck strict
/**
 * The public origin of the marketing site, and whether it may be indexed.
 * Split out of routes/publicRender.js; robots.txt, the sitemap, llms.txt and
 * every page's canonical depend on it.
 */

/**
 * The configured public origin of the MARKETING SITE, or '' when unset.
 *
 * `PUBLIC_SITE_URL` is deliberately its own variable rather than a reuse of
 * `PUBLIC_BASE_URL`. The latter means "the externally-reachable base URL of
 * this server" (automation/publicUrl.js) and doubles as the switch that decides
 * whether MS Graph subscriptions get provisioned at all — triggerBus.js skips
 * them when it is unset. Setting that on the cluster purely to satisfy the
 * indexability gate below would silently turn on webhook provisioning for every
 * existing automation, which is not a change an SEO fix should be making.
 *
 * The fallback keeps installs that already set only PUBLIC_BASE_URL working:
 * on a single-host self-host deployment the two origins are the same value.
 */
function configuredOrigin() {
    const configured = process.env.PUBLIC_SITE_URL || process.env.PUBLIC_BASE_URL || '';
    return configured.replace(/\/+$/, '');
}

/**
 * The public origin. Wrong here means wrong canonicals on every page.
 * @param {import('express').Request} req
 */
function resolveOrigin(req) {
    const configured = configuredOrigin();
    if (configured) return configured;
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
}

/**
 * Only index the real site. A preview host or a bare IP that answers on the
 * same image would otherwise compete with beeflow.nl in the index.
 * @param {string} origin
 */
function isIndexableHost(origin) {
    const configured = configuredOrigin();
    if (!configured) return false;               // unknown host ⇒ do not invite crawlers
    return origin === configured || origin === configured.replace('://', '://www.');
}

module.exports = { configuredOrigin, resolveOrigin, isIndexableHost };
