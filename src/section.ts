// src/section.ts
//
// From a site and a few interest words to the part of the site worth watching. This is word
// matching, not understanding: it collects the site's own section links (navigation and body)
// and the path prefixes its sitemap uses, ranks them by how many interest words appear in the
// link text or the path, and leaves the choice to the person. The CLI then verifies the pick
// against the sitemap and the discovery chain.

import { JSDOM, VirtualConsole } from "jsdom";
import {
  discoverFromRobots,
  isArticleShapedPath,
  isPrivateHostname,
  SITEMAP_PATHS,
  urlExists,
} from "./fetch.js";
import { articleShapedEntries, countPathMatches, fetchSitemapSample } from "./sitemap.js";
import type { SourceSampleEntry } from "./types.js";
import { fetchPage, type PageVia } from "./unlocker.js";

/** Paths that are never a section of articles. */
const NOT_A_SECTION =
  /^\/(?:.*\/)?(?:search|log-?in|sign-?in|sign-?up|register|account|subscribe|newsletters?|about(?:-us)?|contact|privacy|cookies?|terms|legal|careers?|jobs?|advertis\w*|help|faq|feeds?|rss|authors?|amp)(?:\/|$)/i;
const FILE_LEAF = /\.[a-z0-9]{1,8}$/i;
const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "to", "in", "on", "or", "with",
  "de", "del", "la", "el", "los", "las", "y", "en", "le", "les", "du", "des",
]);
const SITEMAP_SAMPLE = 2_000;
const TOP = 5;

export type SectionCandidate = {
  url: string;
  path: string;
  score: number;
  matched: string[];
  linkTexts: string[];
  /** Recent sitemap entries under this path; 0 when the site has no usable sitemap. */
  entryCount: number;
  from: ("navigation" | "page body" | "sitemap")[];
};

export type SectionSearch = {
  candidates: SectionCandidate[];
  considered: number;
  interestWords: string[];
  home: { via: PageVia; reason: string | null; links: number };
  sitemap: { url: string; entries: number } | null;
};

/** Lowercase, accents stripped ("fútbol" and "futbol" are the same token), split on anything
 *  that is not a letter or digit. */
export function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Whole-token match, with a trailing "s" folded so "card" meets "cards". */
function sameWord(a: string, b: string): boolean {
  const fold = (word: string) => (word.length > 3 ? word.replace(/s$/, "") : word);
  return a === b || fold(a) === fold(b);
}

function comparableHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/** A path that can be a section: 1 to 3 segments, not article-shaped, no long leaf carrying
 *  both digits and hyphens (an article slug or an id page), no file extension. */
function sectionPath(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 3) return null;
  const leaf = segments.at(-1) ?? "";
  if (isArticleShapedPath(path) || NOT_A_SECTION.test(path) || FILE_LEAF.test(leaf)) return null;
  if (leaf.length >= 8 && /\d/.test(leaf) && /-/.test(leaf)) return null;
  return `/${segments.join("/")}`;
}

/** The first one and two directory segments of each sitemap entry, counted. Digit-only
 *  segments (dates, ids) are not sections. */
function sitemapPrefixes(entries: SourceSampleEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    let segments: string[];
    try {
      segments = decodeURIComponent(new URL(entry.url).pathname).split("/").filter(Boolean);
    } catch {
      continue;
    }
    const directories = segments.slice(0, -1);
    for (let depth = 1; depth <= Math.min(2, directories.length); depth += 1) {
      if (/^\d+$/.test(directories[depth - 1])) break;
      const prefix = `/${directories.slice(0, depth).join("/")}`;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return counts;
}

export async function findSections(siteInput: string, interest: string): Promise<SectionSearch> {
  const site = new URL(siteInput);
  const interestWords = [...new Set(tokens(interest))].filter((word) => !STOPWORDS.has(word));
  const found = new Map<
    string,
    { url: string; path: string; texts: Set<string>; from: Set<SectionCandidate["from"][number]> }
  >();
  const add = (url: URL, path: string, text: string, from: SectionCandidate["from"][number]) => {
    const key = path.toLowerCase();
    const candidate = found.get(key) ?? {
      url: `${url.origin}${path}${from !== "sitemap" && url.pathname.endsWith("/") ? "/" : ""}`,
      path,
      texts: new Set<string>(),
      from: new Set<SectionCandidate["from"][number]>(),
    };
    if (text) candidate.texts.add(text.slice(0, 80));
    candidate.from.add(from);
    found.set(key, candidate);
  };

  const home = await fetchPage("Home", site.toString(), site.hostname);
  let links = 0;
  if (home.html !== null && home.via !== "blocked") {
    const dom = new JSDOM(home.html, { url: home.finalUrl, virtualConsole: new VirtualConsole() });
    try {
      for (const anchor of dom.window.document.querySelectorAll("a[href]")) {
        let url: URL;
        try {
          url = new URL(anchor.getAttribute("href") ?? "", home.finalUrl);
        } catch {
          continue;
        }
        if (!["http:", "https:"].includes(url.protocol) || isPrivateHostname(url.hostname)) continue;
        if (comparableHost(url.hostname) !== comparableHost(site.hostname)) continue;
        const path = sectionPath(url.pathname);
        if (!path) continue;
        links += 1;
        const text = anchor.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const inNavigation = anchor.closest("nav, header, footer, [role='navigation']") !== null;
        add(url, path, text, inNavigation ? "navigation" : "page body");
      }
    } finally {
      dom.window.close();
    }
  }

  // The sitemap, when there is one, shows which path prefixes actually carry recent articles.
  let sitemap: SectionSearch["sitemap"] = null;
  let sample: SourceSampleEntry[] = [];
  const robots = await discoverFromRobots(site.origin, site.hostname);
  let sitemapUrl = robots.sitemapUrl;
  if (!sitemapUrl) {
    for (const path of SITEMAP_PATHS) {
      if (await urlExists(`${site.origin}${path}`)) {
        sitemapUrl = `${site.origin}${path}`;
        break;
      }
    }
  }
  if (sitemapUrl) {
    try {
      sample = articleShapedEntries(await fetchSitemapSample(sitemapUrl, SITEMAP_SAMPLE, site.hostname));
      sitemap = { url: sitemapUrl, entries: sample.length };
      for (const prefix of sitemapPrefixes(sample).keys()) {
        if (sectionPath(prefix)) add(site, prefix, "", "sitemap");
      }
    } catch (error) {
      console.error(`sitemap ${sitemapUrl}: ${(error as Error).message}`);
    }
  }

  const ranked = [...found.values()]
    .map((candidate): SectionCandidate => {
      const words = tokens(`${[...candidate.texts].join(" ")} ${candidate.path}`);
      const matched = interestWords.filter((word) => words.some((w) => sameWord(word, w)));
      return {
        url: candidate.url,
        path: candidate.path,
        score: matched.length,
        matched,
        linkTexts: [...candidate.texts],
        entryCount: sample.length ? countPathMatches(sample, candidate.path) : 0,
        from: [...candidate.from],
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.entryCount - a.entryCount || a.path.length - b.path.length,
    );

  return {
    candidates: ranked.slice(0, TOP),
    considered: found.size,
    interestWords,
    home: { via: home.via, reason: home.reason, links },
    sitemap,
  };
}
