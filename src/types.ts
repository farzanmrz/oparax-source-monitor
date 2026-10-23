/** The one shared shape both sitemap.ts and feed.ts produce. `countPathMatches`, section
 *  selection and the monitor consume it uniformly regardless of which discovery path found
 *  the sample. `teaser` is absent on the sitemap-only path (no summary text exists there);
 *  present when the entry came from feed.ts's RSS parsing. */
export type SourceSampleEntry = {
  url: string;
  publishedAt?: string;
  title?: string;
  keywords?: string;
  teaser?: string;
  image?: string;
};
