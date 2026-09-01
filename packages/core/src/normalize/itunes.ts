// iTunes response → normalised observation. The archive stores this normalised
// form permanently; the app dimension captures per-app metadata versioned on
// change, so the ordered track-id list is ~1.5–2.5KB instead of ~2MB.

import type { ITunesResponse, ITunesResult } from "../apple/itunes";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface NormalizedApp {
  id: number;
  bundleId: string | null;
  name: string | null;
  developerId: number | null;
  developerName: string | null;
  primaryGenreId: number | null;
  metadata: {
    title: string | null;
    subtitle: null; // not exposed by the iTunes Search API; comes from other sources
    descriptionHash: string | null;
    version: string | null;
    price: number | null;
    currency: string | null;
    genreIds: string; // JSON
    ratingCount: number | null;
    ratingAvg: number | null;
    screenshotUrlsHash: string | null;
    iconUrl: string | null;
    releaseNotesHash: string | null;
    contentHash: string;
  };
}

function hashOrNull(value: string | undefined): Promise<string | null> {
  return value ? sha256Hex(value) : Promise.resolve(null);
}

interface ContentHashes {
  descriptionHash: string | null;
  releaseNotesHash: string | null;
  screenshotUrlsHash: string | null;
  contentHash: string;
}

async function computeHashes(r: ITunesResult): Promise<ContentHashes> {
  const [descriptionHash, releaseNotesHash, screenshotUrlsHash] =
    await Promise.all([
      hashOrNull(r.description),
      hashOrNull(r.releaseNotes),
      hashOrNull(
        r.screenshotUrls?.length ? JSON.stringify(r.screenshotUrls) : undefined
      ),
    ]);
  // The change-detection hash covers the ASO-relevant surface.
  const contentHash = await sha256Hex(
    JSON.stringify([
      r.trackName ?? null,
      descriptionHash,
      r.version ?? null,
      r.price ?? null,
      r.genreIds ?? null,
      screenshotUrlsHash,
      releaseNotesHash,
      r.artworkUrl512 ?? r.artworkUrl100 ?? null,
    ])
  );
  return { contentHash, descriptionHash, releaseNotesHash, screenshotUrlsHash };
}

export async function normalizeApp(r: ITunesResult): Promise<NormalizedApp> {
  const hashes = await computeHashes(r);
  return {
    bundleId: r.bundleId ?? null,
    developerId: r.artistId ?? null,
    developerName: r.artistName ?? null,
    id: r.trackId,
    metadata: {
      contentHash: hashes.contentHash,
      currency: r.currency ?? null,
      descriptionHash: hashes.descriptionHash,
      genreIds: JSON.stringify(r.genreIds ?? []),
      iconUrl: r.artworkUrl512 ?? r.artworkUrl100 ?? null,
      price: r.price ?? null,
      ratingAvg: r.averageUserRating ?? null,
      ratingCount: r.userRatingCount ?? null,
      releaseNotesHash: hashes.releaseNotesHash,
      screenshotUrlsHash: hashes.screenshotUrlsHash,
      subtitle: null,
      title: r.trackName ?? null,
      version: r.version ?? null,
    },
    name: r.trackName ?? null,
    primaryGenreId: r.primaryGenreId ?? null,
  };
}

export interface RankingObservation {
  resultIds: number[];
  resultCount: number;
}

export function extractRanking(json: ITunesResponse): RankingObservation {
  return {
    resultCount: json.resultCount,
    resultIds: json.results
      .map((r) => r.trackId)
      .filter((id) => typeof id === "number"),
  };
}

/** Validity gates: catch silent garbage before it becomes an "observation". */
export function validateSearchResponse(json: unknown): json is ITunesResponse {
  if (typeof json !== "object" || json === null) {
    return false;
  }
  const j = json as Record<string, unknown>;
  return typeof j.resultCount === "number" && Array.isArray(j.results);
}
