# oparax-source-monitor

Oparax watches sources for one person and alerts them when something new appears. This folder is the part that tracks a source, pulled out of the product to run on its own: given a site and what you care about, it finds the part of the site worth watching, works out how to watch it, polls it cheaply and reads each new article. There is no database, no model call and no account; state is a JSON file per source under `state/`.

## The flow

1. Interest to section. From a site and a few words ("FC Barcelona"), it collects the site's own section links (navigation and page body) and the path prefixes its sitemap uses, and ranks them by how many of your words appear in the link text or the path: lowercased, accents stripped, whole words, with a plural "s" folded on words longer than 4 letters that do not end in "ss" or "ws". It asks you to confirm one. On Mundo Deportivo that is `/futbol/fc-barcelona`, not the home page.
2. Section to mechanism. Discovery tries, in order: sitemaps declared in robots.txt, the well-known sitemap paths, the page itself as a feed, the page's RSS link tag, the home page's RSS link tag, `/feed`, `/rss.xml` and `/feed/rss`, then the page as an HTML listing of article links. A sitemap only wins if it lists current article pages under the section's path (it prints "N of M sampled sitemap entries sit under /path"); otherwise discovery carries on past it. If nothing is found, the product's current, shorter feed or listing check (feed, link tags, feed paths, listing links) gets a last try on the same page.
3. Mechanism to poll. Each poll is a conditional request (ETag and If-Modified-Since); a 304 ends it. Entries already seen are skipped by id or exact URL. A source's first poll returns at most the 10 newest articles and records the rest as seen. Listings and sitemaps are read 40 links at a time. On a source with a backlog, the product waits until the whole backlog is read before returning its first 10; this demo returns the 10 newest it has read so far on each poll so the first run is not empty, and marks the source prefilled once the backlog is done. Articles older than 2 days are recorded but not returned.
4. Poll to article. New articles are fetched 8 at a time. Each gets a title (for a listing, from the page when it loads, since the link text is often the whole card), a date (from the feed or sitemap, else the page's meta tags, JSON-LD or time tag) and its text (article, then main, then the densest paragraph block). The outcome is full, short or unreadable, with the reason: unavailable, teaser, under_120, or furniture (two different articles with the identical body).

## Run it

Node 22.12 or newer and pnpm. `pnpm install`, then one of:

```
pnpm demo --site https://www.mundodeportivo.com --interest "FC Barcelona" [--yes] [--once] [--delay 60]
pnpm demo --url https://www.mundodeportivo.com/futbol/fc-barcelona [--prefix /futbol/fc-barcelona] [--skip-sitemaps] [--once]
pnpm demo --example feed|sitemap|listing|blocked [--once]
```

`--yes` takes the top section without asking. Without `--once` it waits 60 seconds (`--delay`, or `POLL_DELAY_SECONDS`) and polls again, which shows a 304, "already seen", or the next backlog window. `pnpm typecheck` checks the types.

The examples (in `examples.json`): feed is Doctor of Credit (its robots.txt also declares a sitemap, so this example skips sitemaps to reach the feed, and says so); sitemap is Mundo Deportivo's FC Barcelona section, filtered to `/futbol/fc-barcelona`; listing is BBC News, which has no feed discovery can find; blocked is the New York Times business section, which answers a plain fetch with 403.

## The unlocker

Some sites refuse plain fetches. An earlier version of Oparax handled them with Bright Data's Web Unlocker, and that tier is restored here: when a direct fetch fails, answers 401, 403, 429 or 503, or an article page yields under 200 characters of text, the page is requested again through `https://api.brightdata.com/request`. An unlocked body is held to the same 200-character test, so an empty or challenge page that comes back through the unlocker is still reported as blocked. It covers article pages, the polled feed, listing page or sitemap, and the section and home pages during discovery and section search; existence probes such as robots.txt and `/feed` stay direct. Article pages are unlocked only on the source's own site. It is off unless `BRIGHTDATA_API_KEY` and `BRIGHTDATA_ZONE` are both set, in the environment or in a `.env` file (see `.env.example`). Each unlocked fetch costs $0.0015, billed by Bright Data to the key's owner. A run sends at most 10 unlocked requests (`UNLOCKER_MAX_PER_RUN` to change); past that a page reports "blocked; unlocker cap reached". Within one run the same page can be unlocked more than once, all within the cap: the home page in section search and again in discovery's home-page link check, and a listing page in discovery and again on the first poll. With the unlocker off, a refused page is reported as blocked, never as "no new articles".

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
  1 article page blocked or too short and not unlocked (for example: short body (140 < 200 characters); unlocker off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE))
  0 older than 2 days (recorded, not shown); 5 held back by the 10-item first-poll prefill
  10 new articles, newest first (showing 5):

  [full] 2026-10-23T19:40:14.000Z (date from feed)
    AmEx Offers: Virgin Atlantic, Spend $2,500 & Get $200 Statement Credit
    https://www.doctorofcredit.com/amex-offers-virgin-atlantic-spend-2000-get-300-statement-credit/
    text from page:article, fetched direct

  (further articles cut from this README; preview lines removed)
  state: state/www.doctorofcredit.com-5f9faf30b4784c15.json

Waiting 5 s, then polling again with the saved validators...

Poll 2: not_modified
  HTTP 304 Not Modified: nothing changed since the last poll, nothing fetched.
```

`pnpm demo --example sitemap --once`, resolved to sitemap. The first poll meets a 74-link backlog, reads one 40-link window and returns the 10 newest it has read:

```
Example "sitemap": Mundo Deportivo's FC Barcelona section, not the whole paper.

Unlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)

Discovery for https://www.mundodeportivo.com/futbol/fc-barcelona
  - reachable host: www.mundodeportivo.com
  - robots.txt sitemaps: found https://www.mundodeportivo.com/sitemap-news-v7.xml

Scope check for /futbol/fc-barcelona
  74 of 712 sampled sitemap entries sit under /futbol/fc-barcelona (article pages only)
  74 of them dated in the last 30 days or undated

Mechanism: sitemap  https://www.mundodeportivo.com/sitemap-news-v7.xml  (entries filtered to /futbol/fc-barcelona)

Poll 1: ok, first poll of this source
  fetched via direct; 727 entries, 74 in scope, 0 already seen, 0 duplicates
  backlog: 74 new links, reading window 1 of 2; 34 links left, read on the next poll
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

`pnpm demo --example sitemap --delay 5`, on fresh state: Poll 1 reads one window, Poll 2 reads the rest of the backlog and returns the 10 newest not shown before (Poll 1 happened to read window 2 here; the window rotates by the minute):

```
Example "sitemap": Mundo Deportivo's FC Barcelona section, not the whole paper.

Unlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)

Discovery for https://www.mundodeportivo.com/futbol/fc-barcelona
  - reachable host: www.mundodeportivo.com
  - robots.txt sitemaps: found https://www.mundodeportivo.com/sitemap-news-v7.xml

Scope check for /futbol/fc-barcelona
  74 of 712 sampled sitemap entries sit under /futbol/fc-barcelona (article pages only)
  74 of them dated in the last 30 days or undated

Mechanism: sitemap  https://www.mundodeportivo.com/sitemap-news-v7.xml  (entries filtered to /futbol/fc-barcelona)

Poll 1: ok, first poll of this source
  fetched via direct; 727 entries, 74 in scope, 0 already seen, 0 duplicates
  backlog: 74 new links, reading window 2 of 2; 40 links left, read on the next poll
  34 article pages fetched: 33 full, 0 short, 1 under_120 unreadable, 0 undated
  1 article page blocked or too short and not unlocked (for example: short body (36 < 200 characters); unlocker off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE))
  0 older than 2 days (recorded, not shown); 24 held back by the 10-item first-poll prefill
  10 new articles, newest first (showing 5):

  [full] 2026-10-23T03:00:00.000Z (date from sitemap)
    El 1x1 del Barça-Madrid
    https://www.mundodeportivo.com/futbol/fc-barcelona/20261023/1004241904/1x1-barca-madrid.html
    text from page:article, fetched direct

  (further articles cut from this README; preview lines removed)
  state: state/www.mundodeportivo.com-a0474ef83158be2d.json

Waiting 5 s, then polling again with the saved validators...

Poll 2: ok, backlog still being read (prefill continues)
  fetched via direct; 727 entries, 74 in scope, 34 already seen, 0 duplicates
  40 article pages fetched: 39 full, 1 short, 0 unreadable, 0 undated
  0 older than 2 days (recorded, not shown); 54 held back by the 10-item first-poll prefill
  10 new articles, newest first (showing 5):

  [full] 2026-10-23T20:12:21.000Z (date from sitemap)
    Cubarsí da las claves para que la defensa adelantada sea eficaz
    https://www.mundodeportivo.com/futbol/fc-barcelona/20261023/1004242448/cubarsi-da-claves-defensa-adelantada-sea-eficaz.html
    text from page:article, fetched direct

  (further articles cut from this README; preview lines removed)
```

`pnpm demo --example listing --once`, resolved to website (HTML listing); titles come from the article pages:

```
Example "listing": BBC News.

Unlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)

Discovery for https://www.bbc.com/news
  - reachable host: www.bbc.com
  - robots.txt sitemaps: found https://www.bbc.com/sitemaps/https-index-com-mundo-news.xml

Scope check for /news
  0 of 31 sampled sitemap entries sit under /news (article pages only)
  The sitemap does not carry this section's current articles, so discovery continues past it.

Discovery for https://www.bbc.com/news (sitemaps skipped)
  - reachable host: www.bbc.com
  - sitemaps: skipped
  - exact page: HTTP 200 via direct, 387585 characters
  - exact page RSS link tag: none
  - root page RSS link tag: none
  - feed path /feed: no
  - feed path /rss.xml: no
  - feed path /feed/rss: no
  - HTML listing: too few article-shaped links
  - current feed or listing check (feed, link tags, feed paths, listing links): website https://www.bbc.com/news

Mechanism: website (HTML listing)  https://www.bbc.com/news

Poll 1: ok, first poll of this source
  fetched via direct; 62 entries, 62 in scope, 0 already seen, 0 duplicates
  backlog: 62 new links, reading window 1 of 2; 22 links left, read on the next poll
  40 article pages fetched: 15 full, 0 short, 0 unreadable, 24 undated
  1 article page blocked or too short and not unlocked (for example: short body (0 < 200 characters); unlocker off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE))
  0 older than 2 days (recorded, not shown); 5 held back by the 10-item first-poll prefill
  10 new articles, newest first (showing 5):

  [full] 2026-10-23T20:09:45.691Z (date from page tag)
    White House says the US is lifting tariffs on some Canadian goods
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
  0 of 791 sampled sitemap entries sit under /section/business (article pages only)
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

`pnpm demo --site https://www.mundodeportivo.com --interest "FC Barcelona" --yes --once`, from interest to section to sitemap:

```
Looking for the part of https://www.mundodeportivo.com that matches "FC Barcelona"
  interest words: fc, barcelona
  home page: direct, 182 section-shaped links
  sitemap: https://www.mundodeportivo.com/sitemap-news-v7.xml, 712 article entries sampled
  182 candidate sections considered

Candidates (score = interest words found in the link text or the path):
  1. https://www.mundodeportivo.com/futbol/fc-barcelona
     score 2 [fc, barcelona], 74 sitemap entries under it, from page body + sitemap, link text "Barcelona"
  2. https://www.mundodeportivo.com/videos/fc-barcelona
     score 2 [fc, barcelona], 3 sitemap entries under it, from sitemap
  3. https://www.mundodeportivo.com/foodie/barcelona
     score 1 [barcelona], 3 sitemap entries under it, from sitemap
  4. https://www.mundodeportivo.com/futbol/girona-fc
     score 1 [fc], 2 sitemap entries under it, from sitemap

Taking candidate 1 (--yes).

Unlocker: off (set BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE to turn it on)

Discovery for https://www.mundodeportivo.com/futbol/fc-barcelona
  - reachable host: www.mundodeportivo.com
  - robots.txt sitemaps: found https://www.mundodeportivo.com/sitemap-news-v7.xml

Scope check for /futbol/fc-barcelona
  74 of 712 sampled sitemap entries sit under /futbol/fc-barcelona (article pages only)
  74 of them dated in the last 30 days or undated

Mechanism: sitemap  https://www.mundodeportivo.com/sitemap-news-v7.xml  (entries filtered to /futbol/fc-barcelona)

Poll 1: ok, first poll of this source
  fetched via direct; 727 entries, 74 in scope, 0 already seen, 0 duplicates
  backlog: 74 new links, reading window 1 of 2; 34 links left, read on the next poll
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
- Undated pages that loaded fine are fetched again on every poll, not only failures: on BBC News about 25 of each 40 links are undated hub and video pages.
- RSS feeds are read whole on each poll; only listings and sitemaps get the 40-link window.
- An unlocked source document is fetched again on every poll, because unlocked responses carry no ETag or Last-Modified, so each poll is billed; the per-run cap bounds it.
- Article pages are unlocked only on the source's own site; links to other sites are fetched directly or not at all.
- A valid feed or sitemap shorter than 200 characters (an empty one, say) is treated as blocked when the unlocker is off; the threshold was not raised.
- The section search samples sitemap entries in the sitemap's own order, which is recent for news sitemaps but not for every sitemap.
- Every request presents a Chrome user-agent string.
- 15 seconds per hop, up to 20 redirects, 5 MB per page (after gzip is undone); the unlocker gets 45 seconds.
- A section reached through a site-wide feed is not filtered to the section; the run says so.
- A sitemap index is followed to its newest child only, and a 304 on the index is taken to mean nothing changed.
- Node 22.12 or newer and pnpm.

## Provenance

From the Oparax repository, https://github.com/farzanmrz/oparax: `src/fetch.ts` is `lib/sources/discovery.ts`; `src/sitemap.ts`, `src/feed.ts` and `src/article.ts` (from `lib/sources/article-text.ts`) are from `lib/sources/`; `src/listing.ts` and `src/date.ts` are from `lib/collect/`; `src/monitor.ts` is adapted from `lib/collect/poll.ts` and `lib/collect/item.ts`. The unlocker tier in `src/unlocker.ts` comes from an earlier version of the project's poller (August 2026). `src/section.ts` and `src/cli.ts` are new for this demo.
