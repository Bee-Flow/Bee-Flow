/**
 * Tavily Search CLI (reads JSON from stdin, writes JSON to stdout)
 *
 * Usage:
 *   node tavily_search.js < input.json
 *
 * Expected input JSON (minimum):
 *   { "apiKey": "tvly-...", "query": "your search query" }
 *
 * Optional tuning fields:
 *   searchDepth: "basic" | "advanced" | "fast" | "ultra-fast"
 *   maxResults: number (0..20)
 *   chunksPerSource: number (1..3)   // only used when searchDepth === "advanced"
 *   topic: "general" | "news" | "finance"
 *   timeRange: "day"|"week"|"month"|"year"|"d"|"w"|"m"|"y"
 *   startDate: "YYYY-MM-DD"
 *   endDate: "YYYY-MM-DD"
 *   includeAnswer: false | true | "basic" | "advanced"
 *   includeRawContent: false | true | "markdown" | "text"
 *   includeDomains: string[]
 *   excludeDomains: string[]
 *   country: string
 *   autoParameters: boolean
 *   includeUsage: boolean
 *   timeoutMs: number
 *   scoreThreshold: number  // filter results by score
 *   keepTop: number         // after filtering, keep top N
 *   debug: boolean          // include full response
 */

const axios = require("axios");

let inputData = "";
process.stdin.on("data", (chunk) => (inputData += chunk));

process.stdin.on("end", async () => {
  try {
    const inputs = JSON.parse(inputData || "{}");

    // ---- Validate required inputs
    if (!inputs.apiKey) throw new Error("Tavily API Key is required (inputs.apiKey)");
    if (!inputs.query) throw new Error("Search query is required (inputs.query)");

    // ---- Helpers
    const clampInt = (value, min, max, fallback) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(n)));
    };

    const normalizeIncludeAnswer = (val, fallback = false) => {
      // Allowed: false | true | "basic" | "advanced"
      if (val === true || val === false) return val;
      if (typeof val === "string") {
        const s = val.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
        if (s === "basic" || s === "advanced") return s;
      }
      return fallback;
    };

    const normalizeIncludeRawContent = (val, fallback = false) => {
      // Allowed: false | true | "markdown" | "text"
      if (val === true || val === false) return val;
      if (typeof val === "string") {
        const s = val.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
        if (s === "markdown" || s === "text") return s;
      }
      return fallback;
    };

    const pickOneOf = (val, allowed, fallback) => {
      if (typeof val !== "string") return fallback;
      const s = val.trim();
      return allowed.includes(s) ? s : fallback;
    };

    const stripUndefined = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        if (v === null) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        out[k] = v;
      }
      return out;
    };

    // ---- Defaults tuned for quality
    const searchDepth = pickOneOf(
      inputs.searchDepth,
      ["basic", "advanced", "fast", "ultra-fast"],
      "advanced"
    );

    const maxResults = clampInt(inputs.maxResults, 0, 20, 8);

    // Only valid when searchDepth === "advanced"
    const chunksPerSource =
      searchDepth === "advanced" ? clampInt(inputs.chunksPerSource, 1, 3, 3) : undefined;

    const includeAnswer = normalizeIncludeAnswer(inputs.includeAnswer, false);
    const includeRawContent = normalizeIncludeRawContent(inputs.includeRawContent, false);

    const payload = stripUndefined({
      query: inputs.query,

      // Quality levers
      search_depth: searchDepth,
      chunks_per_source: chunksPerSource,
      max_results: maxResults,

      // Intent + freshness
      topic: pickOneOf(inputs.topic, ["general", "news", "finance"], "general"),
      time_range: inputs.timeRange,
      start_date: inputs.startDate,
      end_date: inputs.endDate,

      // Answer / evidence
      include_answer: includeAnswer,
      include_raw_content: includeRawContent,

      // Optional extras
      include_images: !!inputs.includeImages, // default false unless explicitly set
      include_image_descriptions: !!inputs.includeImageDescriptions,
      include_favicon: inputs.includeFavicon ?? true,

      include_domains: inputs.includeDomains,
      exclude_domains: inputs.excludeDomains,
      country: inputs.country,

      auto_parameters: !!inputs.autoParameters,
      include_usage: !!inputs.includeUsage,
    });

    // ---- Execute request (use Authorization header)
    const response = await axios.post("https://api.tavily.com/search", payload, {
      headers: { Authorization: `Bearer ${inputs.apiKey}` },
      timeout: Number.isFinite(Number(inputs.timeoutMs)) ? Number(inputs.timeoutMs) : 30000,
      validateStatus: () => true, // we'll handle non-2xx as errors below
    });

    if (response.status < 200 || response.status >= 300) {
      const body =
        typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      throw new Error(`Tavily API error (${response.status}): ${body}`);
    }

    const data = response.data || {};

    // ---- Post-filter results (big quality win)
    const scoreThreshold = Number.isFinite(Number(inputs.scoreThreshold))
      ? Number(inputs.scoreThreshold)
      : 0.7;

    const keepTop = clampInt(inputs.keepTop, 1, 20, 5);

    const results = Array.isArray(data.results) ? data.results : [];
    const filteredResults = results
      .filter((r) => (typeof r?.score === "number" ? r.score : 0) >= scoreThreshold)
      .slice(0, keepTop);

    // ---- Construct output
    const output = stripUndefined({
      query: data.query ?? inputs.query,
      answer: data.answer ?? null,
      results: filteredResults,
      images: data.images ?? [],
      usage: data.usage ?? null,
      requestId: data.request_id ?? null,
      responseTime: data.response_time ?? null,
      autoParameters: data.auto_parameters ?? null,
      fullResponse: inputs.debug ? data : undefined,
    });

    process.stdout.write(JSON.stringify(output));
  } catch (e) {
    const errorMessage =
      e?.response?.data != null
        ? typeof e.response.data === "string"
          ? e.response.data
          : JSON.stringify(e.response.data)
        : e?.message || String(e);

    process.stderr.write(errorMessage);
    process.exit(1);
  }
});