// The HTML -> Markdown converter is server/utils/htmlToMarkdown.js, copied into
// this folder by scripts/gen-shared-mirror.mjs (npm run gen:shared): a component
// runs from its own directory and cannot require server/. Do not edit
// htmlToMarkdown.js or ssrfGuard.js here; change the server source and regenerate.
const { htmlToMarkdown, cleanMarkdown } = require('./htmlToMarkdown');
const { safeGet } = require('./safeGet');

/**
 * Fetch a URL and convert to Markdown (convenience function).
 *
 * @param {string} url - URL to fetch
 * @param {Object} [options] - Options
 * @param {number} [options.timeout=15000] - Request timeout
 * @param {string} [options.userAgent] - Custom user agent
 * @param {boolean} [options.includeLinks=true] - Include links
 * @param {boolean} [options.includeImages=false] - Include images
 * @returns {Promise<{ markdown: string, title: string, url: string, resolvedUrl: string, success: boolean }>}
 */
async function fetchAndConvert(url, options = {}) {
    const timeout = options.timeout || 15000;
    const userAgent = options.userAgent || 'Mozilla/5.0 (compatible; BeeFlowBot/1.0; +https://beeflow.nl)';

    // safeGet, not axios.get: the URL is caller-supplied (an agent tool), and
    // every hop, redirects included, must stay off internal addresses.
    const { response, url: resolvedUrl } = await safeGet(url, {
        timeout,
        headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        },
        maxRedirects: 5,
        responseType: 'text',
    });

    const html = response.data;
    const { markdown, title } = htmlToMarkdown(html, resolvedUrl, options);

    return {
        markdown: markdown || 'No content could be extracted from the page.',
        title,
        url,
        resolvedUrl,
        success: true,
    };
}

// If run directly as CLI (backwards compat with existing tool usage)
if (require.main === module) {
    const fs = require('fs');
    (async () => {
        const inputs = JSON.parse(fs.readFileSync(0, 'utf-8'));
        if (!inputs.url) throw new Error("'url' input is required");
        const result = await fetchAndConvert(inputs.url, inputs);
        console.log(JSON.stringify(result));
    })().catch(e => {
        console.log(JSON.stringify({
            markdown: '', title: '', url: '', success: false, error: e.message,
        }));
        process.exit(1);
    });
}

module.exports = { htmlToMarkdown, fetchAndConvert, cleanMarkdown };
