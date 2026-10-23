// src/monitor.ts
//
// One poll of one source: a conditional request for the feed, listing page or sitemap, the
// entries not seen before, each new article fetched 8 at a time and read for its title, date
// and text. Adapted from Oparax's collector (lib/collect/poll.ts and lib/collect/item.ts),
// with a JSON file per source under state/ in place of the database tables.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { z } from "zod";
import { extractArticleText } from "./article.js";
import { pagePublishedDate, parsePublishedDate, structuredArticles } from "./date.js";
import { parseFeedEntries } from "./feed.js";
import { stripTrackingParameters } from "./fetch.js";
import { parseListingEntries } from "./listing.js";
import { articleShapedEntries, pathMatchesPrefix, sitemapEntriesFromXml } from "./sitemap.js";
import type { SourceSampleEntry } from "./types.js";
import { fetchPage, type PageVia } from "./unlocker.js";

const FRESH_MS = 2 * 86_400_000;
const PREFILL = 10;
const WINDOW = 40;
const BATCH = 8;

export type Mechanism = "rss" | "website" | "sitemap";
export type SourceSpec = { target: string; mechanism: Mechanism; pathPrefix?: string | null };

export function canonicalArticleUrl(raw: string): string {
  const url = new URL(z.url({ protocol: /^https?$/ }).parse(raw));
  url.hash = "";
  url.protocol = "https:";
  stripTrackingParameters(url);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
}

export function articleId(url: string): string {
  return createHash("sha1").update(canonicalArticleUrl(url)).digest("hex");
}

function cleanTitle(value: string): string {
  const title = value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/[•·]\s*\d+\s*(?:min|hour|day|week|month|year)/i.test(title)) return "";
  return title
    .replace(/\s+(?:\||-)\s+[^|]+$/, "")
    .slice(0, 199)
    .trim();
}

function articleTitle(entry: SourceSampleEntry, document?: Document): string {
  const candidates = [entry.title ?? ""];
  if (document) {
    candidates.push(...structuredArticles(document).map((node) => node.headline ?? ""));
    for (const name of ["og:title", "twitter:title"]) {
      candidates.push(
        document
          .querySelector(`meta[property='${name}'], meta[name='${name}']`)
          ?.getAttribute("content") ?? "",
      );
    }
    const heading = [...document.querySelectorAll("h1")].find(
      (element) => !element.closest("[hidden], [aria-hidden='true'], nav, header, footer"),
    );
    candidates.push(heading?.textContent ?? "", document.title);
  }
  return candidates.map(cleanTitle).find((title) => title.length >= 8) ?? "";
}

export type Outcome = "full" | "short" | "unreadable";
export type UnreadableReason = "unavailable" | "teaser" | "under_120" | "furniture";

export type CollectedArticle = {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  publishedAt: string;
  dateSource: "feed" | "sitemap" | "page tag";
  textFrom: string;
  outcome: Outcome;
  unreadableReason: UnreadableReason | null;
  text: string;
  /** The extracted body alone, for the furniture check. Never written to state. */
  body: string;
  fetchVia: PageVia;
  fetchNote: string | null;
};

/** Fetches and reads one article. Null when no date can be found anywhere: an undated page
 *  is not recorded, so it is looked at again on the next poll. */
async function collectArticle(
  entry: SourceSampleEntry,
  entryDateSource: "feed" | "sitemap",
): Promise<CollectedArticle | null> {
  const page = await fetchPage("Article", entry.url, null, {
    minBody: 200,
    measure: (html) => extractArticleText(html, entry.url).body.length,
  });
  const finalUrl = page.finalUrl;
  let html = page.html;
  const fetchNote =
    page.via === "blocked"
      ? `${page.trigger}; ${page.reason}`
      : page.via === "unlocker"
        ? `direct fetch: ${page.trigger}`
        : page.reason;
  if (html === null) console.error(`article ${entry.url}: ${fetchNote ?? "unavailable"}`);
  let dom: JSDOM | undefined;
  try {
    if (html !== null)
      dom = new JSDOM(html, { url: finalUrl, virtualConsole: new VirtualConsole() });
  } catch {
    html = null;
  }
  try {
    const document = dom?.window.document;
    const feedDate = parsePublishedDate(entry.publishedAt);
    const publishedAt = feedDate ?? (document ? pagePublishedDate(document) : null);
    if (!publishedAt) return null;
    const title = articleTitle(entry, document);
    const article =
      html !== null
        ? extractArticleText(html, finalUrl, title)
        : { text: title, body: "", via: "unavailable" };
    const length = article.body
      .replace(/\[quote\]|\[end quote\]/g, "")
      .replace(/\s+/g, " ")
      .trim().length;
    const teaser =
      entry.teaser
        ?.replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim() ?? "";
    const reason: UnreadableReason | null =
      article.via === "unavailable"
        ? "unavailable"
        : length < 400 && teaser.length >= 400
          ? "teaser"
          : length < 120
            ? "under_120"
            : null;
    return {
      id: articleId(finalUrl),
      url: entry.url,
      finalUrl: canonicalArticleUrl(finalUrl),
      title,
      publishedAt,
      dateSource: feedDate ? entryDateSource : "page tag",
      textFrom:
        reason === "teaser"
          ? "feed body"
          : `${page.via === "unlocker" ? "unlocker" : "page"}:${article.via}`,
      outcome: reason ? "unreadable" : length >= 400 ? "full" : "short",
      unreadableReason: reason,
      text: reason === "teaser" ? [title, teaser].filter(Boolean).join("\n\n") : article.text,
      body: article.body,
      fetchVia: page.via,
      fetchNote,
    };
  } finally {
    dom?.window.close();
  }
}

function bodySignature(text: string): string {
  return text
    .replace(/\[quote\]|\[end quote\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function bodyHash(body: string): string {
  const signature = bodySignature(body);
  return signature ? createHash("sha1").update(signature).digest("hex") : "";
}

// ---- State: one JSON file per source, no article text in it ----

const stateSchema = z.object({
  target: z.string(),
  mechanism: z.enum(["rss", "website", "sitemap"]),
  pathPrefix: z.string().nullable(),
  etag: z.string().nullable(),
  last_modified: z.string().nullable(),
  last_fetched_at: z.string().nullable(),
  prefilled: z.boolean(),
  seen: z.record(z.string(), z.object({ url: z.string(), bodyHash: z.string() })),
});
type SourceState = z.infer<typeof stateSchema>;

const STATE_DIR = join(process.cwd(), "state");

/** Keyed by target, mechanism and path prefix, so two sections of one host never share. */
export function statePath(source: SourceSpec): string {
  const key = createHash("sha1")
    .update(`${source.target}\n${source.mechanism}\n${source.pathPrefix ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return join(STATE_DIR, `${new URL(source.target).hostname}-${key}.json`);
}

function emptyState(source: SourceSpec): SourceState {
  return {
    target: source.target,
    mechanism: source.mechanism,
    pathPrefix: source.pathPrefix ?? null,
    etag: null,
    last_modified: null,
    last_fetched_at: null,
    prefilled: false,
    seen: {},
  };
}

function loadState(source: SourceSpec): SourceState {
  const path = statePath(source);
  if (!existsSync(path)) return emptyState(source);
  try {
    return stateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    console.error(`state file ${path} is malformed; starting this source empty`);
    return emptyState(source);
  }
}

function saveState(source: SourceSpec, state: SourceState): void {
  const path = statePath(source);
  mkdirSync(STATE_DIR, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}

// ---- The poll ----

export type PollCounts = {
  /** Entries the feed, listing or sitemap carried. */
  entries: number;
  /** Of those, inside the path prefix (all of them when there is none). */
  inScope: number;
  /** Matched an article already recorded, by id or exact URL. */
  alreadySeen: number;
  /** The same article twice in one poll: two links to it, or a redirect onto another. */
  duplicates: number;
  /** New entries whose pages were fetched this poll. */
  fetched: number;
  /** Fetched, but no date in the entry or on the page; looked at again next poll. */
  undated: number;
  /** Older than 2 days or dated in the future: recorded as seen, not returned. */
  stale: number;
  /** Fresh, but past the 10 newest on a source's first poll: recorded as seen. */
  heldByPrefill: number;
  /** Article pages that refused a plain fetch and could not be unlocked. */
  blockedPages: number;
  full: number;
  short: number;
  unreadable: Partial<Record<UnreadableReason, number>>;
};

export type PollResult = {
  status: "ok" | "not_modified" | "blocked" | "error";
  reason: string | null;
  via: PageVia | null;
  firstPoll: boolean;
  backlog: string | null;
  counts: PollCounts;
  articles: CollectedArticle[];
  statePath: string;
};

/** Polls one source once. Never throws for a source problem: a refused or broken source comes
 *  back as status blocked or error with the reason, and the details go to stderr. */
export async function pollSource(source: SourceSpec, now = new Date()): Promise<PollResult> {
  const state = loadState(source);
  const firstPoll = !state.prefilled;
  const counts: PollCounts = {
    entries: 0,
    inScope: 0,
    alreadySeen: 0,
    duplicates: 0,
    fetched: 0,
    undated: 0,
    stale: 0,
    heldByPrefill: 0,
    blockedPages: 0,
    full: 0,
    short: 0,
    unreadable: {},
  };
  const result = (
    status: PollResult["status"],
    extra: Partial<PollResult> = {},
  ): PollResult => ({
    status,
    reason: null,
    via: null,
    firstPoll,
    backlog: null,
    counts,
    articles: [],
    statePath: statePath(source),
    ...extra,
  });

  // A source's first poll asks for the whole document so the prefill sees everything.
  const headers = new Headers();
  if (!firstPoll) {
    if (state.etag) headers.set("If-None-Match", state.etag);
    if (state.last_modified) headers.set("If-Modified-Since", state.last_modified);
  }
  try {
    const hostname = new URL(source.target).hostname;
    const page = await fetchPage("Collect", source.target, hostname, { headers, minBody: 200 });
    if (page.status === 304 && page.via === "direct") {
      state.last_fetched_at = now.toISOString();
      saveState(source, state);
      return result("not_modified", { via: "direct" });
    }
    if (page.via === "blocked") {
      const reason = `${page.trigger}; ${page.reason}`;
      console.error(`source ${source.target}: blocked (${reason})`);
      return result("blocked", { reason, via: "blocked" });
    }
    if (page.html === null) {
      const reason = page.reason ?? `HTTP ${page.status}`;
      console.error(`source ${source.target}: ${reason}`);
      return result("error", { reason, via: page.via });
    }

    let entries =
      source.mechanism === "rss"
        ? parseFeedEntries(page.html, page.finalUrl)
        : source.mechanism === "website"
          ? parseListingEntries(page.html, page.finalUrl)
          : await sitemapEntriesFromXml(page.html, hostname);
    counts.entries = entries.length;
    const prefix = source.pathPrefix && source.pathPrefix !== "/" ? source.pathPrefix : null;
    if (source.mechanism === "sitemap") {
      // A sitemap also lists the home page, section and tag pages; only articles are polled.
      entries = articleShapedEntries(entries).filter((entry) => {
        try {
          const path = new URL(entry.url).pathname.replace(/\/+$/, "") || "/";
          return path !== "/" && path !== prefix && (!prefix || pathMatchesPrefix(path, prefix));
        } catch {
          return false;
        }
      });
    }
    counts.inScope = entries.length;

    const idByUrl = new Map(Object.entries(state.seen).map(([id, seen]) => [seen.url, id]));
    const seenThisPoll = new Set<string>();
    const candidates = new Map<string, SourceSampleEntry>();
    for (const entry of entries) {
      let id: string;
      try {
        id = articleId(entry.url);
      } catch {
        continue;
      }
      const knownId = state.seen[id] ? id : idByUrl.get(entry.url);
      if (knownId) {
        if (seenThisPoll.has(knownId)) counts.duplicates += 1;
        else counts.alreadySeen += 1;
        seenThisPoll.add(knownId);
      } else if (candidates.has(id)) counts.duplicates += 1;
      else candidates.set(id, entry);
    }

    let fresh = [...candidates.values()];
    if (source.mechanism === "sitemap") {
      // A sitemap can list years of URLs. Its own dates decide which are worth a fetch: older
      // than the freshness window means recorded as seen without fetching, newest first.
      const dated = fresh.map((entry) => ({ entry, at: parsePublishedDate(entry.publishedAt) }));
      for (const { entry, at } of dated) {
        if (at && Date.parse(at) < now.getTime() - FRESH_MS) {
          state.seen[articleId(entry.url)] = { url: entry.url, bodyHash: "" };
          counts.stale += 1;
        }
      }
      fresh = dated
        .filter(({ at }) => !at || Date.parse(at) >= now.getTime() - FRESH_MS)
        .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
        .map(({ entry }) => entry);
    }
    let backlog: string | null = null;
    if (source.mechanism !== "rss" && fresh.length > WINDOW) {
      // Undated pages are not recorded, so rotating windows prevent them blocking later links.
      const windows = Math.ceil(fresh.length / WINDOW);
      const window = Math.floor(now.getTime() / 60_000) % windows;
      backlog = `${fresh.length} new links, reading window ${window + 1} of ${windows}`;
      fresh = fresh.slice(window * WINDOW, window * WINDOW + WINDOW);
    }

    const collected: CollectedArticle[] = [];
    const entryDateSource = source.mechanism === "sitemap" ? "sitemap" : "feed";
    for (let offset = 0; offset < fresh.length; offset += BATCH) {
      const chunk = await Promise.all(
        fresh.slice(offset, offset + BATCH).map(async (entry) => {
          try {
            return await collectArticle(entry, entryDateSource);
          } catch (error) {
            console.error(`article ${entry.url}: ${(error as Error).message}`);
            return null;
          }
        }),
      );
      counts.fetched += chunk.length;
      for (const article of chunk) {
        if (!article) counts.undated += 1;
        else if (seenThisPoll.has(article.id) || state.seen[article.id]) counts.duplicates += 1;
        else {
          seenThisPoll.add(article.id);
          collected.push(article);
        }
      }
    }

    // Furniture: two different articles of one source with the identical body are page
    // furniture (a cookie wall, a subscribe box), not two stories.
    const bodies = new Map<string, Set<string>>();
    const addBody = (hash: string, id: string) => {
      if (!hash) return;
      const ids = bodies.get(hash) ?? new Set<string>();
      ids.add(id);
      bodies.set(hash, ids);
    };
    for (const id of seenThisPoll) addBody(state.seen[id]?.bodyHash ?? "", id);
    for (const article of collected) addBody(bodyHash(article.body), article.id);
    for (const article of collected) {
      if ((bodies.get(bodyHash(article.body))?.size ?? 0) > 1) {
        article.outcome = "unreadable";
        article.unreadableReason = "furniture";
      }
    }

    for (const article of collected) {
      state.seen[article.id] = { url: article.url, bodyHash: bodyHash(article.body) };
      if (article.fetchVia === "blocked") counts.blockedPages += 1;
      if (article.outcome === "unreadable" && article.unreadableReason) {
        counts.unreadable[article.unreadableReason] =
          (counts.unreadable[article.unreadableReason] ?? 0) + 1;
      } else if (article.outcome === "full") counts.full += 1;
      else counts.short += 1;
    }

    const recent = collected
      .filter((article) => {
        const at = Date.parse(article.publishedAt);
        return at >= now.getTime() - FRESH_MS && at <= now.getTime();
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    counts.stale += collected.length - recent.length;
    const returned = firstPoll ? recent.slice(0, PREFILL) : recent;
    counts.heldByPrefill = recent.length - returned.length;

    // Validators are kept only when this poll read everything the document offered.
    const complete = backlog === null && page.via === "direct";
    state.etag = complete ? page.etag : null;
    state.last_modified = complete ? page.lastModified : null;
    state.last_fetched_at = now.toISOString();
    state.prefilled = true;
    saveState(source, state);
    return result("ok", { via: page.via, backlog, articles: returned });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`source ${source.target}: ${reason}`);
    return result("error", { reason });
  }
}
