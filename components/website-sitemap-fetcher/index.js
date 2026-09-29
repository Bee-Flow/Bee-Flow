const fs = require('fs');
const axios = require('axios');
const { parseString } = require('xml2js');
const { URL } = require('url');

async function fetchUrl(url, timeout, userAgent) {
  try {
    const response = await axios.get(url, {
      timeout,
      headers: userAgent ? { 'User-Agent': userAgent } : undefined,
      // helpful defaults
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400
    });
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }
}

async function parseSitemap(xml, baseUrl) {
  return new Promise((resolve, reject) => {
    parseString(xml, (err, result) => {
      if (err) return reject(err);

      const urls = [];
      const sitemaps = [];

      // <urlset><url><loc>...</loc></url></urlset>
      if (result.urlset && Array.isArray(result.urlset.url)) {
        result.urlset.url.forEach(u => {
          if (u.loc && u.loc[0]) {
            urls.push(new URL(u.loc[0], baseUrl).href);
          }
        });
      }

      // <sitemapindex><sitemap><loc>...</loc></sitemap></sitemapindex>
      if (result.sitemapindex && Array.isArray(result.sitemapindex.sitemap)) {
        result.sitemapindex.sitemap.forEach(sm => {
          if (sm.loc && sm.loc[0]) {
            sitemaps.push(new URL(sm.loc[0], baseUrl).href);
          }
        });
      }

      resolve({ urls, sitemaps });
    });
  });
}

async function processSitemap(
  url,
  timeout,
  userAgent,
  maxUrls,
  visitedSitemaps = new Set(),
  allUrls = new Set()
) {
  if (visitedSitemaps.has(url) || allUrls.size >= maxUrls) return;

  visitedSitemaps.add(url);

  try {
    const xml = await fetchUrl(url, timeout, userAgent);
    const { urls, sitemaps } = await parseSitemap(xml, url);

    // ✅ Enforce maxUrls while adding page URLs
    for (const u of urls) {
      if (allUrls.size >= maxUrls) return; // stop immediately when limit hit
      allUrls.add(u);
    }

    // ✅ Enforce maxUrls while traversing nested sitemaps
    for (const sitemapUrl of sitemaps) {
      if (allUrls.size >= maxUrls) break;
      await processSitemap(
        sitemapUrl,
        timeout,
        userAgent,
        maxUrls,
        visitedSitemaps,
        allUrls
      );
    }
  } catch (error) {
    // Silently handle errors for individual sitemaps
  }
}

async function main() {
  const inputs = JSON.parse(fs.readFileSync(0, 'utf-8'));

  if (!inputs.url) {
    throw new Error("'url' is required");
  }

  const baseUrl = new URL(inputs.url).origin;

  // Use a Set to avoid duplicate sitemap URLs (your original used an array and pushed duplicates)
  const sitemapUrls = new Set([
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/sitemap1.xml`
  ]);

  const maxUrls = Number.isFinite(inputs.maxUrls) ? inputs.maxUrls : 1000;
  const timeout = inputs.timeout || 10000;
  const userAgent = inputs.userAgent || 'Mozilla/5.0 (compatible; SitemapFetcher/1.0)';

  const allUrls = new Set();
  const visitedSitemaps = new Set();
  const warnings = [];
  const errors = [];

  // First try to fetch robots.txt for sitemap locations
  try {
    const robotsTxt = await fetchUrl(`${baseUrl}/robots.txt`, timeout, userAgent);

    // Match lines like: Sitemap: https://example.com/sitemap.xml
    // Handles multiple and different casing.
    const sitemapMatches = robotsTxt.match(/^sitemap:\s*(.+)$/gim);

    if (sitemapMatches) {
      sitemapMatches.forEach(line => {
        const smUrl = line.replace(/^sitemap:\s*/i, '').trim();
        if (smUrl) {
          try {
            sitemapUrls.add(new URL(smUrl, baseUrl).href);
          } catch {
            // ignore malformed
          }
        }
      });
    }
  } catch (error) {
    warnings.push({
      sitemapUrl: `${baseUrl}/robots.txt`,
      message: `Failed to fetch robots.txt: ${error.message}`
    });
  }

  // Process all discovered sitemaps
  for (const sitemapUrl of sitemapUrls) {
    if (allUrls.size >= maxUrls) break;
    await processSitemap(
      sitemapUrl,
      timeout,
      userAgent,
      maxUrls,
      visitedSitemaps,
      allUrls
    );
  }

  const result = {
    sitemapUrls: Array.from(visitedSitemaps),
    pageUrls: Array.from(allUrls), // will never exceed maxUrls due to guarded add
    warnings,
    errors,
    success: true
  };

  console.log(JSON.stringify(result));
}

main().catch(e => {
  const errorResult = {
    success: false,
    error: e.message,
    sitemapUrls: [],
    pageUrls: [],
    warnings: [],
    errors: [{ message: e.message }]
  };
  console.log(JSON.stringify(errorResult));
  process.exit(1);
});
