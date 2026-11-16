const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = (process.env.BASE_URL || "https://huh.xdmovies.wtf").replace(/\/$/, "");

const httpClient = axios.create({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
    Referer: `${BASE_URL}/`
  }
});

// Manifest matching your Render configuration + Series catalog support
const manifest = {
  id: "community.my.addon",
  version: "1.0.0",
  name: "My Library (XDMovies)",
  description: "Custom addon for Stremio and Nuvio",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "my_"],
  catalogs: [
    {
      type: "movie",
      id: "my-movies",
      name: "My Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    },
    {
      type: "series",
      id: "my-series",
      name: "My Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    }
  ]
};

const builder = new addonBuilder(manifest);

// --- Helper: Encode/Decode page URLs into Stremio-safe 'my_' IDs ---
function encodePageId(urlOrPath) {
  const fullUrl = urlOrPath.startsWith("http")
    ? urlOrPath
    : `${BASE_URL}/${urlOrPath.replace(/^\//, "")}`;
  return "my_" + Buffer.from(fullUrl, "utf8").toString("base64url");
}

function decodePageId(stremioId) {
  const raw = stremioId.replace(/^my_/, "");
  return Buffer.from(raw, "base64url").toString("utf8");
}

// --- Helper: Resolve IMDb ID to Title & Year via Cinemeta ---
async function getCinemetaInfo(type, imdbId) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
    const { data } = await axios.get(url, { timeout: 8000 });
    if (data && data.meta) {
      return {
        name: data.meta.name,
        year: data.meta.releaseInfo ? String(data.meta.releaseInfo).slice(0, 4) : null
      };
    }
  } catch (err) {
    console.error(`Cinemeta lookup failed for ${imdbId}:`, err.message);
  }
  return null;
}

// --- Helper: Scrape Catalog / Search List from huh.xdmovies.wtf ---
async function fetchCatalogItems(type, searchQuery = "", skip = 0) {
  const page = Math.floor(Number(skip) / 20) + 1;
  const candidateUrls = searchQuery
    ? [
        `${BASE_URL}/?s=${encodeURIComponent(searchQuery)}`,
        `${BASE_URL}/search?q=${encodeURIComponent(searchQuery)}`,
        `${BASE_URL}/api/search?q=${encodeURIComponent(searchQuery)}`
      ]
    : [
        page > 1 ? `${BASE_URL}/page/${page}` : `${BASE_URL}/`,
        `${BASE_URL}/api/movies?page=${page}`
      ];

  for (const url of candidateUrls) {
    try {
      const { data } = await httpClient.get(url);

      // Case A: Endpoint returns JSON directly
      if (typeof data === "object" && data !== null) {
        const list = Array.isArray(data) ? data : data.results || data.data || data.movies || [];
        if (list.length > 0) {
          return list.map((item) => ({
            id: encodePageId(item.url || item.slug || `/movie/${item.id}`),
            type: item.type === "series" || item.type === "tv" ? "series" : type,
            name: item.title || item.name || "Untitled",
            poster: item.poster || item.image || item.thumbnail || "",
            description: item.description || item.overview || ""
          }));
        }
      }

      // Case B: Endpoint returns HTML
      if (typeof data === "string") {
        const $ = cheerio.load(data);
        const metas = [];
        const seenUrls = new Set();

        // Matches common movie/series cards (articles, grid cards, anchor wrappers)
        $("article, .post, .movie-card, .card, .item, a[href]").each((_, el) => {
          const $el = $(el);
          const linkEl = $el.is("a") ? $el : $el.find("a[href]").first();
          let href = linkEl.attr("href");
          if (!href || href === "#" || href === "/" || href.startsWith("javascript:")) return;

          // Normalize relative URLs
          if (href.startsWith("/")) href = `${BASE_URL}${href}`;
          if (!href.startsWith(BASE_URL)) return;
          if (/\/(category|genre|tag|login|register|contact|about|page)\b/i.test(href)) return;
          if (seenUrls.has(href)) return;

          const imgEl = $el.find("img").first();
          if (!imgEl.length && !$el.is("article, .post, .movie-card, .card, .item")) return;

          let poster =
            imgEl.attr("data-src") ||
            imgEl.attr("data-lazy-src") ||
            imgEl.attr("src") ||
            "";
          if (poster.startsWith("/")) poster = `${BASE_URL}${poster}`;

          const title = (
            $el.find("h2, h3, h4, .title, .entry-title").first().text() ||
            linkEl.attr("title") ||
            imgEl.attr("alt") ||
            linkEl.text()
          )
            .replace(/\s+/g, " ")
            .trim();

          if (!title || title.length < 2) return;

          seenUrls.add(href);
          metas.push({
            id: encodePageId(href),
            type,
            name: title,
            poster
          });
        });

        if (metas.length > 0) return metas;
      }
    } catch (err) {
      // Try next candidate URL pattern
    }
  }

  return [];
}

// --- Helper: Follow Intermediate Redirector/Cloud Links if Present ---
async function resolveIntermediateLink(url, label = "Stream") {
  const resolved = [];
  try {
    const { data } = await httpClient.get(url);
    if (typeof data !== "string") return resolved;

    const $ = cheerio.load(data);

    // Direct video/source tags or direct file links inside intermediate page
    $("a[href], video source[src], video[src]").each((_, el) => {
      const href = $(el).attr("href") || $(el).attr("src");
      if (!href) return;
      if (/\.(mp4|mkv|m3u8|webm)(\?|$)/i.test(href) || /workers\.dev|pixeldrain|hubcloud|r2\.dev/i.test(href)) {
        const qualityMatch = ($(el).text() + " " + href).match(/\b(2160p|4k|1080p|720p|480p)\b/i);
        const quality = qualityMatch ? qualityMatch[1].toUpperCase() : "HD";
        resolved.push({
          name: `XDMovies\n${quality}`,
          title: `${label}\n🔗 ${ ($(el).text() || "Direct Stream").replace(/\s+/g, " ").trim() }`,
          url: href.startsWith("//") ? `https:${href}` : href,
          behaviorHints: { notWebReady: /\.mkv(\?|$)/i.test(href) }
        });
      }
    });

    // Scan raw scripts for .m3u8 or .mp4 URLs
    const rawMatches = data.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|m3u8)(?:\?[^\s"'<>]*)?/gi) || [];
    for (const matchUrl of rawMatches) {
      resolved.push({
        name: "XDMovies\nAuto",
        title: `${label}\n⚡ Extracted Stream`,
        url: matchUrl,
        behaviorHints: { notWebReady: /\.mkv(\?|$)/i.test(matchUrl) }
      });
    }
  } catch (err) {
    console.error(`Intermediate resolve failed for ${url}:`, err.message);
  }
  return resolved;
}

// --- Helper: Scrape Detail Page for Meta & Playable Streams ---
async function scrapePageDetailsAndStreams(pageUrl, season = null, episode = null) {
  const { data } = await httpClient.get(pageUrl);

  // If the page endpoint returns JSON
  if (typeof data === "object" && data !== null) {
    const streams = (data.streams || data.links || []).map((s) => ({
      name: s.quality ? `XDMovies\n${s.quality}` : "XDMovies",
      title: s.title || s.name || "Direct Stream",
      url: s.url
    }));
    return {
      meta: {
        id: encodePageId(pageUrl),
        type: data.type || "movie",
        name: data.title || data.name || "Unknown",
        poster: data.poster || "",
        description: data.description || ""
      },
      streams
    };
  }

  const $ = cheerio.load(data);
  const title = (
    $("h1, .entry-title, .movie-title").first().text() ||
    $('meta[property="og:title"]').attr("content") ||
    "Untitled"
  ).trim();

  let poster =
    $('meta[property="og:image"]').attr("content") ||
    $(".poster img, .entry-content img").first().attr("src") ||
    "";
  if (poster.startsWith("/")) poster = `${BASE_URL}${poster}`;

  const description = (
    $('meta[property="og:description"]').attr("content") ||
    $(".synopsis, .description, .entry-content p").first().text() ||
    ""
  ).trim();

  const streams = [];
  const intermediateLinks = [];
  const seenStreamUrls = new Set();

  const addStream = (streamObj) => {
    if (!streamObj.url || seenStreamUrls.has(streamObj.url)) return;
    seenStreamUrls.add(streamObj.url);
    streams.push(streamObj);
  };

  // 1. Direct <video> and <source> tags
  $("video[src], video source[src]").each((_, el) => {
    let src = $(el).attr("src");
    if (!src) return;
    if (src.startsWith("/")) src = `${BASE_URL}${src}`;
    addStream({
      name: "XDMovies\nDirect",
      title: `${title}\n⚡ HTML5 Video`,
      url: src
    });
  });

  // 2. Direct & Intermediate <a> download/stream buttons
  $("a[href]").each((_, el) => {
    let href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    if (href.startsWith("/")) href = `${BASE_URL}${href}`;

    const btnText = $(el).text().replace(/\s+/g, " ").trim();
    const surroundingText = $(el).parent().text().replace(/\s+/g, " ").trim();
    const combinedText = `${btnText} ${surroundingText}`;

    // Filter by episode if series season/episode is requested
    if (season && episode) {
      const epRegex = new RegExp(`(?:S0?${season}\\s*E0?${episode}|Episode\\s*0?${episode}\\b)`, "i");
      if (/S\d+\s*E\d+|Episode\s*\d+/i.test(combinedText) && !epRegex.test(combinedText)) {
        return;
      }
    }

    const qualityMatch = combinedText.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
    const quality = qualityMatch ? qualityMatch[1].toUpperCase() : "HD";

    // Direct playable file or worker link
    if (/\.(mp4|mkv|m3u8|webm)(\?|$)/i.test(href) || /workers\.dev\/.*\.(mp4|mkv)/i.test(href)) {
      addStream({
        name: `XDMovies\n${quality}`,
        title: `${title}\n${btnText || "Direct Stream"}`,
        url: href,
        behaviorHints: { notWebReady: /\.mkv(\?|$)/i.test(href) }
      });
    } else if (
      /hubcloud|hubdrive|gdflix|filepress|pixeldrain|workers\.dev|\/links\/|\/download\//i.test(href) &&
      intermediateLinks.length < 5
    ) {
      intermediateLinks.push({ url: href, label: `${title} (${btnText || quality})` });
    }
  });

  // 3. Scan inline scripts for direct .m3u8 / .mp4 streams
  const rawMediaUrls = data.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|m3u8)(?:\?[^\s"'<>]*)?/gi) || [];
  for (const mediaUrl of rawMediaUrls) {
    addStream({
      name: "XDMovies\nStream",
      title: `${title}\n⚡ Direct Media Link`,
      url: mediaUrl,
      behaviorHints: { notWebReady: /\.mkv(\?|$)/i.test(mediaUrl) }
    });
  }

  // 4. Resolve intermediate links in parallel if needed
  if (streams.length === 0 && intermediateLinks.length > 0) {
    const nestedResults = await Promise.all(
      intermediateLinks.map((item) => resolveIntermediateLink(item.url, item.label))
    );
    nestedResults.flat().forEach(addStream);
  }

  // 5. Fallback: Embedded iframes (external player fallback)
  if (streams.length === 0) {
    $("iframe[src]").each((_, el) => {
      let src = $(el).attr("src");
      if (!src) return;
      if (src.startsWith("//")) src = `https:${src}`;
      addStream({
        name: "XDMovies\nEmbed",
        title: `${title}\n🌐 Open Web Player`,
        externalUrl: src
      });
    });
  }

  return {
    meta: {
      id: encodePageId(pageUrl),
      type: season ? "series" : "movie",
      name: title,
      poster,
      background: poster,
      description
    },
    streams
  };
}

// ============================================================================
// ADDON HANDLERS
// ============================================================================

// 1. Catalog Handler
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const search = extra && extra.search ? extra.search : "";
  const skip = extra && extra.skip ? Number(extra.skip) : 0;
  const metas = await fetchCatalogItems(type, search, skip);
  return { metas };
});

// 2. Meta Handler (for custom 'my_' catalog items)
builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith("my_")) return { meta: null };
  try {
    const pageUrl = decodePageId(id);
    const { meta } = await scrapePageDetailsAndStreams(pageUrl);
    meta.type = type;
    return { meta };
  } catch (err) {
    console.error("Meta handler error:", err.message);
    return { meta: null };
  }
});

// 3. Stream Handler (supports both 'my_' items and standard IMDb 'tt' IDs)
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const [baseId, season, episode] = id.split(":");

    // Case 1: Clicked from our custom catalog ('my_' prefix)
    if (baseId.startsWith("my_")) {
      const pageUrl = decodePageId(baseId);
      const { streams } = await scrapePageDetailsAndStreams(pageUrl, season, episode);
      return { streams };
    }

    // Case 2: Standard Stremio/Nuvio item ('tt' IMDb prefix)
    if (baseId.startsWith("tt")) {
      const info = await getCinemetaInfo(type, baseId);
      if (!info || !info.name) return { streams: [] };

      const searchResults = await fetchCatalogItems(type, info.name);
      if (searchResults.length === 0) return { streams: [] };

      // Prefer a result matching the release year if available
      const bestMatch =
        (info.year && searchResults.find((item) => item.name.includes(info.year))) ||
        searchResults[0];

      const pageUrl = decodePageId(bestMatch.id);
      const { streams } = await scrapePageDetailsAndStreams(pageUrl, season, episode);
      return { streams };
    }
  } catch (err) {
    console.error("Stream handler error:", err.message);
  }

  return { streams: [] };
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`Addon listening on port ${port} targeting ${BASE_URL}`);
