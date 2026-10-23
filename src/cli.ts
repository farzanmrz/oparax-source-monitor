// src/cli.ts
//
// pnpm demo --site <url> --interest "<words>" [--yes] [--once] [--delay <s>]
// pnpm demo --url <section-url> [--prefix /path] [--skip-sitemaps] [--once] [--delay <s>]
// pnpm demo --example feed|sitemap|listing|blocked [--once] [--delay <s>]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { discoverChangeDetection, discoverFeedOrListing } from "./fetch.js";
import { type PollResult, pollSource, type SourceSpec } from "./monitor.js";
import { findSections } from "./section.js";
import { parsePublishedDate } from "./date.js";
import {
  articleShapedEntries,
  countPathMatches,
  fetchSitemapSample,
  pathMatchesPrefix,
} from "./sitemap.js";
import { isUnlockerConfigured, unlockerUsage } from "./unlocker.js";

const USAGE = `Usage:
  pnpm demo --site <url> --interest "<words>" [--yes] [--once] [--delay <seconds>]
  pnpm demo --url <section-url> [--prefix /path] [--skip-sitemaps] [--once] [--delay <seconds>]
  pnpm demo --example feed|sitemap|listing|blocked [--once] [--delay <seconds>]`;

type Args = Record<string, string | true>;

/** A sitemap tracks a section only if it lists articles under it from the last month. */
const CURRENT_DAYS = 30;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    const name = flag.slice(2);
    const next = argv[i + 1];
    if (["yes", "once", "skip-sitemaps", "help"].includes(name) || !next || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

const exampleSchema = z.record(
  z.string(),
  z.object({
    url: z.string(),
    prefix: z.string().nullable(),
    skipSitemaps: z.boolean(),
    note: z.string(),
  }),
);

function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function normalizedPrefix(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/** Section URL to a monitorable source, printing every discovery step. Null means none. */
async function resolveSource(
  sectionUrl: string,
  prefixArg: string | null,
  skipSitemaps: boolean,
): Promise<SourceSpec | null> {
  const url = new URL(sectionUrl);
  const prefix = normalizedPrefix(prefixArg ?? url.pathname);
  say(`\nDiscovery for ${url}${skipSitemaps ? " (sitemaps skipped)" : ""}`);
  const onStep = (step: string, result: string) => say(`  - ${step}: ${result}`);
  let found = await discoverChangeDetection(url, { skipSitemaps, onStep });

  if (found.mechanism === "sitemap" && found.sitemapUrl) {
    say(`\nScope check for ${prefix}`);
    let sample: Awaited<ReturnType<typeof fetchSitemapSample>> = [];
    try {
      sample = articleShapedEntries(
        await fetchSitemapSample(found.sitemapUrl, 1_000, new URL(found.resolvedUrl).hostname),
      );
    } catch (error) {
      say(`  sitemap could not be read: ${(error as Error).message}`);
    }
    const matches = countPathMatches(sample, prefix);
    // Entries under the prefix that are dated within 30 days, or undated (nothing to judge by).
    const current = sample.filter((entry) => {
      if (!pathMatchesPrefix(new URL(entry.url).pathname, prefix)) return false;
      const date = parsePublishedDate(entry.publishedAt);
      return !date || Date.parse(date) >= Date.now() - CURRENT_DAYS * 86_400_000;
    }).length;
    if (prefix === "/") {
      say(`  site root: all ${sample.length} sampled article entries in the sitemap are in scope`);
    } else {
      say(`  ${matches} of ${sample.length} sampled sitemap entries sit under ${prefix} (article pages only)`);
    }
    if (matches > 0) say(`  ${current} of them dated in the last ${CURRENT_DAYS} days or undated`);
    if (sample.length === 0 || matches === 0 || current === 0) {
      say("  The sitemap does not carry this section's current articles, so discovery continues past it.");
      say(`\nDiscovery for ${url} (sitemaps skipped)`);
      found = await discoverChangeDetection(url, { skipSitemaps: true, onStep });
    } else {
      say(`\nMechanism: sitemap  ${found.sitemapUrl}  (entries filtered to ${prefix})`);
      return {
        target: found.sitemapUrl,
        mechanism: "sitemap",
        pathPrefix: prefix === "/" ? null : prefix,
      };
    }
  }

  if (found.mechanism === "rss" && found.feedUrl) {
    say(`\nMechanism: rss  ${found.feedUrl}`);
    if (prefix !== "/" && !pathMatchesPrefix(new URL(found.feedUrl).pathname, prefix)) {
      say(`  scope: this feed is not under ${prefix}; it is the site's main feed, not filtered to the section.`);
    }
    return { target: found.feedUrl, mechanism: "rss", pathPrefix: null };
  }
  if (found.mechanism === "listing" && found.listingUrl) {
    say(`\nMechanism: website (HTML listing)  ${found.listingUrl}`);
    say(`  ${found.listingSample?.length ?? 0} article-shaped links on the page, for example:`);
    for (const entry of (found.listingSample ?? []).slice(0, 3)) say(`    ${entry.url}`);
    return { target: found.listingUrl, mechanism: "website", pathPrefix: null };
  }
  if (found.exactPageVia !== "blocked") {
    // The product's current feed or listing check reads listings with listing.ts, which also
    // accepts id-style article links (BBC's /news/articles/c0abc123) that the older listing
    // step skips. It reuses the page HTML discovery already fetched.
    const admitted = await discoverFeedOrListing(
      url,
      found.exactPageHtml && found.exactPageFinalUrl
        ? { html: found.exactPageHtml, finalUrl: found.exactPageFinalUrl }
        : undefined,
    );
    onStep(
      "current feed or listing check (feed, link tags, feed paths, listing links)",
      admitted ? `${admitted.kind} ${admitted.target}` : "none",
    );
    if (admitted?.kind === "rss") {
      say(`\nMechanism: rss  ${admitted.target}`);
      return { target: admitted.target, mechanism: "rss", pathPrefix: null };
    }
    if (admitted?.kind === "website") {
      say(`\nMechanism: website (HTML listing)  ${admitted.target}`);
      return { target: admitted.target, mechanism: "website", pathPrefix: null };
    }
  }
  if (found.exactPageVia === "blocked") {
    const refusal = found.exactPageStatus ? `HTTP ${found.exactPageStatus}` : "the request failed";
    say(`\nBlocked: ${url} refused a plain fetch (${refusal}); ${found.exactPageReason}.`);
    say("  No feed, sitemap or listing could be read, so there is nothing to poll.");
    return null;
  }
  say(
    `\nNo source found for ${url}: no sitemap, feed or article listing${
      found.exactPageStatus && found.exactPageStatus >= 300 ? ` (page answered HTTP ${found.exactPageStatus})` : ""
    }.`,
  );
  return null;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}...` : flat;
}

function printPoll(label: string, poll: PollResult): void {
  say(`\n${label}: ${poll.status}${poll.reason ? ` (${poll.reason})` : ""}${poll.firstPoll ? (poll.polledBefore ? ", backlog still being read (prefill continues)" : ", first poll of this source") : ""}`);
  if (poll.status === "not_modified") {
    say("  HTTP 304 Not Modified: nothing changed since the last poll, nothing fetched.");
    return;
  }
  if (poll.status === "blocked") {
    say("  The source refused a plain fetch and could not be unlocked. This is not \"no new articles\".");
    return;
  }
  if (poll.status === "error") return;
  const c = poll.counts;
  say(`  fetched via ${poll.via}; ${c.entries} entries, ${c.inScope} in scope, ${c.alreadySeen} already seen, ${c.duplicates} duplicates`);
  if (poll.backlog) say(`  backlog: ${poll.backlog}`);
  const unreadable = Object.entries(c.unreadable).map(([reason, n]) => `${n} ${reason}`).join(", ");
  say(`  ${c.fetched} article ${c.fetched === 1 ? "page" : "pages"} fetched: ${c.full} full, ${c.short} short, ${unreadable || "0"} unreadable, ${c.undated} undated`);
  if (c.blockedPages) {
    say(
      `  ${c.blockedPages} article ${c.blockedPages === 1 ? "page" : "pages"} blocked or too short and not unlocked${
        poll.blockedReason ? ` (for example: ${poll.blockedReason})` : ""
      }`,
    );
  }
  say(`  ${c.stale} older than 2 days (recorded, not shown); ${c.heldByPrefill} held back by the 10-item first-poll prefill`);
  if (poll.articles.length === 0) {
    if (c.blockedPages > 0) {
      say("  No article could be read: the pages refused a plain fetch. This is not \"no new articles\".");
    } else {
      say(c.fetched === 0 && c.alreadySeen > 0 ? "  No new articles: everything listed was already seen." : "  No new articles to show.");
    }
    return;
  }
  say(`  ${poll.articles.length} new article${poll.articles.length === 1 ? "" : "s"}, newest first${poll.articles.length > 5 ? " (showing 5)" : ""}:`);
  for (const article of poll.articles.slice(0, 5)) {
    const reason = article.unreadableReason ? ` (${article.unreadableReason})` : "";
    say(`\n  [${article.outcome}${reason}] ${article.publishedAt} (date from ${article.dateSource})`);
    say(`    ${article.title || "(no title)"}`);
    say(`    ${article.url}`);
    say(`    text from ${article.textFrom}, fetched ${article.fetchVia}${article.fetchNote ? ` (${article.fetchNote})` : ""}`);
    if (article.text) say(`    "${preview(article.text.slice(article.title.length).trim() || article.text)}"`);
    else say("    (read in an earlier poll; no preview kept)");
  }
}

async function pickSection(site: string, interest: string, yes: boolean): Promise<string> {
  say(`Looking for the part of ${site} that matches "${interest}"`);
  const search = await findSections(site, interest);
  say(`  interest words: ${search.interestWords.join(", ")}`);
  say(
    `  home page: ${search.home.via}${search.home.reason ? ` (${search.home.reason})` : ""}, ${search.home.links} section-shaped links`,
  );
  say(
    search.sitemap
      ? `  sitemap: ${search.sitemap.url}, ${search.sitemap.entries} article entries sampled`
      : "  sitemap: none found",
  );
  say(`  ${search.considered} candidate sections considered`);
  if (search.candidates.length === 0) {
    say(`\nNo section matched those words. Tracking the site from its home page instead.`);
    return site;
  }
  say("\nCandidates (score = interest words found in the link text or the path):");
  search.candidates.forEach((c, i) => {
    say(`  ${i + 1}. ${c.url}`);
    say(
      `     score ${c.score} [${c.matched.join(", ")}], ${c.entryCount} sitemap entries under it, from ${c.from.join(" + ")}${
        c.linkTexts.length ? `, link text "${c.linkTexts.slice(0, 2).join('" / "')}"` : ""
      }`,
    );
  });
  let choice = 1;
  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nTrack which one? [1-${search.candidates.length}, Enter for 1] `)).trim();
    rl.close();
    const n = Number(answer || "1");
    if (Number.isInteger(n) && n >= 1 && n <= search.candidates.length) choice = n;
  } else {
    say(`\nTaking candidate 1${yes ? " (--yes)" : " (stdin is not a terminal)"}.`);
  }
  return search.candidates[choice - 1].url;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.site && !args.url && !args.example)) {
    say(USAGE);
    return;
  }
  let sectionUrl: string;
  let prefix: string | null = typeof args.prefix === "string" ? args.prefix : null;
  let skipSitemaps = args["skip-sitemaps"] === true;

  if (typeof args.example === "string") {
    const examples = exampleSchema.parse(
      JSON.parse(readFileSync(join(process.cwd(), "examples.json"), "utf8")),
    );
    const example = examples[args.example];
    if (!example) {
      say(`Unknown example "${args.example}". Choose one of: ${Object.keys(examples).join(", ")}`);
      return;
    }
    say(`Example "${args.example}": ${example.note}`);
    sectionUrl = example.url;
    prefix = example.prefix;
    skipSitemaps = example.skipSitemaps;
    if (skipSitemaps) say("  This example skips sitemaps so the steps after them run (set in examples.json).");
  } else if (typeof args.site === "string") {
    if (typeof args.interest !== "string") {
      say(`--site needs --interest "<words>"\n\n${USAGE}`);
      return;
    }
    sectionUrl = await pickSection(args.site, args.interest, args.yes === true);
  } else if (typeof args.url === "string") {
    sectionUrl = args.url;
  } else {
    say(USAGE);
    return;
  }

  say(
    isUnlockerConfigured()
      ? `\nUnlocker: on (Bright Data), at most ${unlockerUsage().cap} unlocked fetches this run`
      : "\nUnlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)",
  );
  const source = await resolveSource(sectionUrl, prefix, skipSitemaps);
  if (!source) {
    finish();
    return;
  }

  const first = await pollSource(source);
  printPoll("Poll 1", first);
  say(`  state: ${first.statePath}`);
  if (args.once !== true && first.status !== "blocked" && first.status !== "error") {
    const fromEnv = Number(process.env.POLL_DELAY_SECONDS);
    const delay =
      typeof args.delay === "string" && Number(args.delay) >= 0
        ? Number(args.delay)
        : Number.isFinite(fromEnv) && process.env.POLL_DELAY_SECONDS?.trim()
          ? fromEnv
          : 60;
    say(`\nWaiting ${delay} s, then polling again with the saved validators...`);
    await sleep(delay * 1_000);
    printPoll("Poll 2", await pollSource(source));
  }
  finish();
}

function finish(): void {
  const usage = unlockerUsage();
  if (isUnlockerConfigured()) say(`\nUnlocker requests this run: ${usage.used} of ${usage.cap}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
