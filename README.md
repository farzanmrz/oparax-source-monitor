# oparax-source-monitor

Oparax watches sources for one person and alerts them when something new appears. This folder is the part that tracks a source, pulled out of the product to run on its own: given a site and what you care about, it finds the part of the site worth watching, works out how to watch it, polls it cheaply and reads each new article. There is no database, no model call and no account; state is a JSON file per source under `state/`.

## The flow

1. Interest to section. From a site and a few words ("FC Barcelona"), it collects the site's own section links (navigation and page body) and the path prefixes its sitemap uses, ranks them by how many of your words appear in the link text or the path (lowercased, accents stripped, whole words), and asks you to confirm one. On Mundo Deportivo that is `/futbol/fc-barcelona`, not the home page.
2. Section to mechanism. Discovery tries, in order: sitemaps declared in robots.txt, the well-known sitemap paths, the page itself as a feed, the page's RSS link tag, the home page's RSS link tag, `/feed`, `/rss.xml` and `/feed/rss`, then the page as an HTML listing of article links. A sitemap only wins if it lists current article pages under the section's path (it prints "N of M recent sitemap entries sit under /path"); otherwise discovery carries on past it. If nothing is found, the product's current, shorter admission (feed, link tags, feed paths, listing links) gets a last try.
3. Mechanism to poll. Each poll is a conditional request (ETag and If-Modified-Since); a 304 ends it. Entries already seen are skipped by id or exact URL. A source's first poll returns at most the 10 newest articles and records the rest as seen. Articles older than 2 days are recorded but not returned. Large website and sitemap backlogs are read 40 links at a time in a rotating window.
4. Poll to article. New articles are fetched 8 at a time. Each gets a title and a date (from the feed or sitemap, else the page's meta tags, JSON-LD or time tag) and its text (article, then main, then the densest paragraph block). The outcome is full, short or unreadable, with the reason: unavailable, teaser, under_120, or furniture (two different articles with the identical body).

## Run it

Node 22.12 or later and pnpm. `pnpm install`, then one of:

```
pnpm demo --site https://www.mundodeportivo.com --interest "FC Barcelona" [--yes] [--once] [--delay 60]
pnpm demo --url https://www.mundodeportivo.com/futbol/fc-barcelona [--prefix /futbol/fc-barcelona] [--skip-sitemaps] [--once]
pnpm demo --example feed|sitemap|listing|blocked [--once]
```

`--yes` takes the top section without asking. Without `--once` it waits 60 seconds (`--delay`, or `POLL_DELAY_SECONDS`) and polls again to show a 304 or "already seen". `pnpm typecheck` checks the types.

The examples (in `examples.json`): feed is Doctor of Credit (its robots.txt also declares a sitemap, so this example skips sitemaps to reach the feed, and says so); sitemap is Mundo Deportivo's FC Barcelona section, filtered to `/futbol/fc-barcelona`; listing is BBC News, which has no feed discovery can find; blocked is the New York Times business section, which answers a plain fetch with 403.

## The unlocker

Some sites refuse plain fetches. An earlier version of Oparax handled them with Bright Data's Web Unlocker, and that tier is restored here: when a direct fetch fails, answers 401, 403, 429 or 503, or an article page yields under 200 characters of text, the page is requested again through `https://api.brightdata.com/request`. It covers article pages, listing pages, sitemaps and the section page during discovery (existence probes such as `/feed` stay direct). It is off unless `BRIGHTDATA_API_KEY` and `BRIGHTDATA_ZONE` are both set, in the environment or in a `.env` file (see `.env.example`). Each unlocked fetch costs $0.0015, billed by Bright Data to the key's owner. A run sends at most 10 unlocked requests (`UNLOCKER_MAX_PER_RUN` to change); past that a page reports "blocked; unlocker cap reached". With the unlocker off, a refused page is reported as blocked, never as "no new articles".

## Real runs (October 23, 2026)

`pnpm demo --example feed --delay 5`, Doctor of Credit, resolved to rss:

```
Example "feed": Doctor of Credit, one of Points Wire's sources. Its robots.txt also declares a sitemap, which discovery would pick first; this example skips sitemaps to show the feed path.
  This example skips sitemaps so the steps after them run (set in examples.json).

Unlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)

Discovery for https://www.doctorofcredit.com/ (sitemaps skipped)
  - reachable host: www.doctorofcredit.com
  - sitemaps: skipped
  - exact page: HTTP 200 via direct, 182202 characters
  - exact page RSS link tag: found https://www.doctorofcredit.com/feed/

Mechanism: rss  https://www.doctorofcredit.com/feed/

Poll 1: ok, first poll of this source
  fetched via direct; 15 entries, 15 in scope, 0 already seen, 0 duplicates
  15 article pages fetched: 12 full, 1 short, 2 teaser unreadable, 0 undated
  1 article pages blocked or too short and not unlocked
  0 older than 2 days (recorded, not shown); 5 held back by the 10-item first-poll prefill
  10 new articles, newest first (showing 5):

  [full] 2026-10-23T19:40:14.000Z (date from feed)
    AmEx Offers: Virgin Atlantic, Spend $2,500 &#038; Get $200 Statement Credit
    https://www.doctorofcredit.com/amex-offers-virgin-atlantic-spend-2000-get-300-statement-credit/
    text from page:article, fetched direct

  (further articles cut from this README; preview lines removed)
  state: state/www.doctorofcredit.com-5f9faf30b4784c15.json

Waiting 5 s, then polling again with the saved validators...

Poll 2: not_modified
  HTTP 304 Not Modified: nothing changed since the last poll, nothing fetched.
```

`pnpm demo --example sitemap --once`, resolved to sitemap:

```
Example "sitemap": Mundo Deportivo's FC Barcelona section, not the whole paper.

Unlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)

Discovery for https://www.mundodeportivo.com/futbol/fc-barcelona
  - reachable host: www.mundodeportivo.com
  - robots.txt sitemaps: found https://www.mundodeportivo.com/sitemap-news-v7.xml

Scope check for /futbol/fc-barcelona
  74 of 713 recent sitemap entries sit under /futbol/fc-barcelona (article pages only)
  74 of them dated in the last 30 days or undated

Mechanism: sitemap  https://www.mundodeportivo.com/sitemap-news-v7.xml  (entries filtered to /futbol/fc-barcelona)

Poll 1: ok, first poll of this source
  fetched via direct; 728 entries, 74 in scope, 0 already seen, 0 duplicates
  backlog: 74 new links, reading window 1 of 2
  40 article pages fetched: 39 full, 1 short, 0 unreadable, 0 undated
  0 older than 2 days (recorded, not shown); 30 held back by the 10-item first-poll prefill
  10 new articles, newest first (showing 5):

  [full] 2026-10-23T20:12:21.000Z (date from sitemap)
    Cubarsí da las claves para que la defensa adelantada sea eficaz
    https://www.mundodeportivo.com/futbol/fc-barcelona/20261023/1004242448/cubarsi-da-claves-defensa-adelantada-sea-eficaz.html
    text from page:article, fetched direct

  (further articles cut from this README; preview lines removed)
  state: state/www.mundodeportivo.com-a0474ef83158be2d.json
```

`pnpm demo --example listing --once`, resolved to website (HTML listing):

```
Example "listing": BBC News.

Unlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)

Discovery for https://www.bbc.com/news
  - reachable host: www.bbc.com
  - robots.txt sitemaps: found https://www.bbc.com/sitemaps/https-index-com-mundo-news.xml

Scope check for /news
  0 of 31 recent sitemap entries sit under /news (article pages only)
  The sitemap does not carry this section's current articles, so discovery continues past it.

Discovery for https://www.bbc.com/news (sitemaps skipped)
  - reachable host: www.bbc.com
  - sitemaps: skipped
  - exact page: HTTP 200 via direct, 387728 characters
  - exact page RSS link tag: none
  - root page RSS link tag: none
  - feed path /feed: no
  - feed path /rss.xml: no
  - feed path /feed/rss: no
  - HTML listing: too few article-shaped links
  - current admission (feed, link tags, feed paths, listing links): website https://www.bbc.com/news

Mechanism: website (HTML listing)  https://www.bbc.com/news

Poll 1: ok, first poll of this source
  fetched via direct; 62 entries, 62 in scope, 0 already seen, 0 duplicates
  backlog: 62 new links, reading window 1 of 2
  40 article pages fetched: 15 full, 0 short, 0 unreadable, 25 undated
  0 older than 2 days (recorded, not shown); 5 held back by the 10-item first-poll prefill
  10 new articles, newest first (showing 5):

  [full] 2026-10-23T20:09:45.691Z (date from page tag)
    White House says the US is lifting tariffs on some Canadian goods Susan Collins, a Republican in a tight race to keep her senate seat in next month's elections, said she had been working with the Whi
    https://www.bbc.com/news/articles/c60qk573yzz8o
    text from page:article, fetched direct

  (further articles cut from this README; preview lines removed)
  state: state/www.bbc.com-4de0aa10d3e1210c.json
```

`pnpm demo --example blocked --once`, no key, resolved to nothing (blocked):

```
Example "blocked": The New York Times business section, which refuses plain fetches.

Unlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)

Discovery for https://www.nytimes.com/section/business
  - reachable host: www.nytimes.com
  - robots.txt sitemaps: found https://www.nytimes.com/sitemaps/new/news.xml.gz

Scope check for /section/business
  0 of 793 recent sitemap entries sit under /section/business (article pages only)
  The sitemap does not carry this section's current articles, so discovery continues past it.

Discovery for https://www.nytimes.com/section/business (sitemaps skipped)
  - reachable host: www.nytimes.com
  - sitemaps: skipped
  - exact page: blocked (HTTP 403; unlocker off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE))
  - exact page RSS link tag: none
  - root page RSS link tag: none
  - feed path /feed: no
  - feed path /rss.xml: no
  - feed path /feed/rss: no
  - HTML listing: no page HTML

Blocked: https://www.nytimes.com/section/business refused a plain fetch (HTTP 403); unlocker off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE).
  No feed, sitemap or listing could be read, so there is nothing to poll.
```

The same with `BRIGHTDATA_API_KEY=invalid BRIGHTDATA_ZONE=test`, to show the unlocker wiring and a refusal from the API:

```
Example "blocked": The New York Times business section, which refuses plain fetches.

Unlocker: on (Bright Data), at most 10 unlocked fetches this run

Discovery for https://www.nytimes.com/section/business
  - reachable host: www.nytimes.com
  - robots.txt sitemaps: found https://www.nytimes.com/sitemaps/new/news.xml.gz

Scope check for /section/business
  0 of 793 recent sitemap entries sit under /section/business (article pages only)
  The sitemap does not carry this section's current articles, so discovery continues past it.

Discovery for https://www.nytimes.com/section/business (sitemaps skipped)
  - reachable host: www.nytimes.com
  - sitemaps: skipped
  - exact page: blocked (HTTP 403; unlocker failed: Unlocker 401: Invalid token)
  - exact page RSS link tag: none
  - root page RSS link tag: none
  - feed path /feed: no
  - feed path /rss.xml: no
  - feed path /feed/rss: no
  - HTML listing: no page HTML

Blocked: https://www.nytimes.com/section/business refused a plain fetch (HTTP 403); unlocker failed: Unlocker 401: Invalid token.
  No feed, sitemap or listing could be read, so there is nothing to poll.

Unlocker requests this run: 2 of 10
```

## What it does not do

- No llms.txt handling.
- No robots.txt-based refusal: robots.txt is read only to find sitemap URLs.
- No x402 or paywall handling.
- No JavaScript rendering, so pages that need a browser to run a challenge (Reddit's, for one) fail.
- The interest step is word matching plus verification. The product uses a scored candidate table and a model to pick sources; this does not.
- The production app today stops at the direct fetch and does not use the unlocker.

## Limits

- State is kept per source (target, mechanism and path prefix), and the seen set is never pruned.
- An article fetch that fails for a passing reason is recorded as unavailable and not retried (when the feed or sitemap gave it a date; an undated failure is tried again next poll).
- Every request presents a Chrome user-agent string.
- 15 seconds per hop, up to 20 redirects, 5 MB per page; the unlocker gets 45 seconds.
- A section reached through a site-wide feed is not filtered to the section; the run says so.
- A sitemap index is followed to its newest child only, and a 304 on the index is taken to mean nothing changed.
- Node 22.12 or later and pnpm.

## Provenance

From the Oparax repository: `src/fetch.ts` is `lib/sources/discovery.ts`; `src/sitemap.ts`, `src/feed.ts`, `src/article.ts` (from `article-text.ts`) are from `lib/sources/`; `src/listing.ts` and `src/date.ts` are from `lib/collect/`; `src/monitor.ts` is adapted from `lib/collect/poll.ts` and `lib/collect/item.ts`. The unlocker tier in `src/unlocker.ts` comes from the archived poller at git tag `archive/legacy-drafting`. `src/section.ts` and `src/cli.ts` are new for this demo.
