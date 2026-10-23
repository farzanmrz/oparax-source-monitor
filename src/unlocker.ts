// src/unlocker.ts
//
// The page fetch every other module goes through: a plain direct fetch first (Tier 1), then
// Bright Data's Web Unlocker (Tier 2) when the direct fetch fails or comes back blocked or
// suspiciously short. Restored from Oparax's earlier poller, which ran this same two-step chain
// for article bodies; here it also covers listing, sitemap and discovery page fetches. The
// unlocker is off unless BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE are both set, and a blocked
// page is reported as blocked, never as an empty result.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchSafeSourceWithFinalUrl,
  isPublicHttpUrl,
  isSafeDiscoveredUrl,
  readHtmlWithinLimit,
} from "./fetch.js";

const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";

/** Bright Data's Web Unlocker does block-bypass/challenge-solving server-side and routinely
 *  takes longer than the 15s direct-fetch budget. This tier exists specifically for hostile
 *  sites, so it gets its own longer budget. */
const UNLOCKER_TIMEOUT_MS = 45_000;

/** Direct responses that mean "this site refused a plain fetch", worth one unlocked retry. */
const BLOCKED_STATUSES = new Set([401, 403, 429, 503]);

const UNLOCKER_OFF = "unlocker off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE)";
const UNLOCKER_CAP_REACHED = "blocked; unlocker cap reached";

/** Loads KEY=VALUE lines from ./.env when the file exists. Variables already set in the
 *  environment win, so a one-off `BRIGHTDATA_API_KEY=... pnpm demo` overrides the file. */
function loadDotEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith("#")) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadDotEnv();

/** True when both Bright Data variables are set. Without them nothing is ever sent to it. */
export function isUnlockerConfigured(): boolean {
  return Boolean(process.env.BRIGHTDATA_API_KEY?.trim() && process.env.BRIGHTDATA_ZONE?.trim());
}

function unlockerCap(): number {
  const parsed = Number(process.env.UNLOCKER_MAX_PER_RUN);
  return Number.isInteger(parsed) && parsed >= 0 && process.env.UNLOCKER_MAX_PER_RUN?.trim()
    ? parsed
    : 10;
}

let unlockerCalls = 0;

/** How many unlocker requests this run has sent, and the cap they count against. */
export function unlockerUsage(): { used: number; cap: number } {
  return { used: unlockerCalls, cap: unlockerCap() };
}

/** Web Unlocker API contract: POST https://api.brightdata.com/request, Bearer auth, JSON body
 *  { zone, url, format: "raw" }, response body is the raw target-site HTML (not JSON). Each
 *  successful request is billed by Bright Data to the key's owner. */
export async function fetchViaUnlocker(url: string): Promise<string> {
  const apiKey = process.env.BRIGHTDATA_API_KEY?.trim();
  const zone = process.env.BRIGHTDATA_ZONE?.trim();
  if (!apiKey || !zone) throw new Error(UNLOCKER_OFF);
  const res = await fetch(BRIGHTDATA_REQUEST_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ zone, url, format: "raw" }),
    signal: AbortSignal.timeout(UNLOCKER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
    throw new Error(`Unlocker ${res.status}: ${text.slice(0, 200)}`);
  }
  return readHtmlWithinLimit(res, url);
}

export type PageVia = "direct" | "unlocker" | "blocked";

export type PageResult = {
  /** The page body. Null when nothing usable came back. A "blocked" result can still carry
   *  the short direct body that triggered the escalation, which beats nothing. */
  html: string | null;
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  via: PageVia;
  /** Why the page is blocked or unavailable; null for a good direct or unlocked page. */
  reason: string | null;
  /** What made the direct fetch escalate (a status, an error, a short body); null otherwise. */
  trigger: string | null;
};

export type PageOptions = {
  /** Sent on the direct fetch only, for conditional requests. A 304 is returned untouched. */
  headers?: HeadersInit;
  /** Escalate when the body measures under this many characters (200 in the earlier poller:
   *  a "please enable JS" stub or a challenge page, the "curtain, not wall" case). */
  minBody?: number;
  /** How to measure the body for `minBody`. Defaults to the raw HTML length; article fetches
   *  measure the extracted text instead, as the earlier poller did. */
  measure?: (html: string) => number;
};

/** Fetches one page: direct first, the unlocker when the direct fetch throws, answers
 *  401/403/429/503, or (with `minBody`) comes back too short. Never throws. */
export async function fetchPage(
  endpoint: string,
  url: string,
  expectedHostname: string | null,
  options: PageOptions = {},
): Promise<PageResult> {
  let directHtml: string | null = null;
  let escalation: string;
  let base: Omit<PageResult, "html" | "via" | "reason" | "trigger"> = {
    finalUrl: url,
    status: null,
    contentType: null,
    etag: null,
    lastModified: null,
  };
  try {
    const fetched = await fetchSafeSourceWithFinalUrl(
      endpoint,
      url,
      expectedHostname,
      undefined,
      options.headers,
    );
    base = {
      finalUrl: fetched.finalUrl,
      status: fetched.res.status,
      contentType: fetched.res.headers.get("content-type"),
      etag: fetched.etag,
      lastModified: fetched.lastModified,
    };
    const status = fetched.res.status;
    if (status === 304) return { ...base, html: null, via: "direct", reason: null, trigger: null };
    if (BLOCKED_STATUSES.has(status)) {
      await fetched.res.body?.cancel();
      escalation = `HTTP ${status}`;
    } else if (status < 200 || status >= 300) {
      await fetched.res.body?.cancel();
      return { ...base, html: null, via: "direct", reason: `HTTP ${status}`, trigger: null };
    } else {
      directHtml = await readHtmlWithinLimit(fetched.res, url);
      const size = options.minBody ? (options.measure ?? ((h) => h.length))(directHtml) : 0;
      if (!options.minBody || size >= options.minBody) {
        return { ...base, html: directHtml, via: "direct", reason: null, trigger: null };
      }
      escalation = `short body (${size} < ${options.minBody} characters)`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An unsafe address or a host that does not exist is not something an unlocker fixes.
    if (/unsafe|ENOTFOUND|too large/i.test(message)) {
      return { ...base, html: null, via: "direct", reason: message, trigger: null };
    }
    escalation = message;
  }

  const blocked = (reason: string): PageResult => ({
    ...base,
    html: directHtml,
    via: "blocked",
    reason,
    trigger: escalation,
  });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return blocked("invalid URL");
  }
  const safe =
    expectedHostname === null ? isPublicHttpUrl(parsed) : isSafeDiscoveredUrl(url, expectedHostname);
  if (!safe) return blocked("URL not eligible for the unlocker");
  if (!isUnlockerConfigured()) return blocked(UNLOCKER_OFF);
  if (unlockerCalls >= unlockerCap()) return blocked(UNLOCKER_CAP_REACHED);
  unlockerCalls += 1;
  try {
    const html = await fetchViaUnlocker(url);
    return {
      finalUrl: url,
      status: 200,
      contentType: null,
      etag: null,
      lastModified: null,
      html,
      via: "unlocker",
      reason: null,
      trigger: escalation,
    };
  } catch (error) {
    return blocked(`unlocker failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
