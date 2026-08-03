<script setup lang="ts">
// Preview shown inline in the chat thread (alongside the LLM's text
// response) when the LLM calls one of `manageSpotify`'s read kinds.
// The full View opens on click via the parent thread's standard
// "open in canvas" affordance — Preview just gives a glanceable
// summary so the user knows what data was returned without needing
// to expand the canvas.

import { computed } from "vue";
import { useT } from "./lang";
import type { NormalisedPlaylist, NormalisedTrack, RecentlyPlayedItem, SearchResult } from "./types";

// Exported because `vite-plugin-dts` rolls Preview into
// `dist/vue.d.ts` via the `plugin = { previewComponent: Preview }`
// re-export in `vue.ts`. Without `export`, the inferred component
// type names this interface as a type the public surface can't see
// → TS4023 (same fix bookmarks-plugin's View.vue carries).
export interface Props {
  selectedResult: {
    ok?: boolean;
    data?:
      | NormalisedTrack[]
      | NormalisedPlaylist[]
      | RecentlyPlayedItem[]
      | NormalisedTrack
      | SearchResult
      | null
      | { connected?: boolean; clientIdConfigured?: boolean };
    error?: string;
    message?: string;
  };
}
const props = defineProps<Props>();
const t = useT();

const summary = computed<string>(() => {
  const result = props.selectedResult;
  // `ok` is optional on the props (selectedResult is whatever the
  // last tool call returned) — only treat an explicit `false` as
  // failure. An undefined `ok` typically means "no call yet" or
  // "non-listening kind whose response we don't recognise"; fall
  // through to the generic summary instead of misrendering as an
  // error (Sourcery review on PR #1166).
  if (result.ok === false) return result.message ?? t.value.notConnected;
  const data = result.data;
  if (Array.isArray(data)) return summariseArray(data);
  if (data === null) return t.value.emptyNowPlaying;
  if (data && typeof data === "object" && "connected" in data) {
    return data.connected ? t.value.connected : data.clientIdConfigured ? t.value.notConnected : t.value.notConfigured;
  }
  // SearchResult is a per-category grouped object — no `name`, no
  // `connected`. Tally the totals so the chip reads e.g.
  // "5 tracks · 2 artists".
  if (data && typeof data === "object" && isSearchResult(data)) {
    return summariseSearchResult(data);
  }
  if (data && typeof data === "object" && "name" in data) {
    return (data as NormalisedTrack).name;
  }
  return t.value.previewSummary;
});

function isSearchResult(value: object): value is SearchResult {
  return "tracks" in value || "artists" in value || "albums" in value || "playlists" in value;
}

function summariseSearchResult(result: SearchResult): string {
  const parts: string[] = [];
  if (result.tracks?.length) parts.push(`${result.tracks.length} ${t.value.searchTracks}`);
  if (result.artists?.length) parts.push(`${result.artists.length} ${t.value.searchArtists}`);
  if (result.albums?.length) parts.push(`${result.albums.length} ${t.value.searchAlbums}`);
  if (result.playlists?.length) parts.push(`${result.playlists.length} ${t.value.searchPlaylists}`);
  return parts.length > 0 ? parts.join(" · ") : t.value.searchEmpty;
}

// Different listening kinds carry different element shapes; pick the
// label that matches the array's element type so a 5-playlist result
// doesn't read as "5 tracks" (CodeRabbit review on PR #1166).
function summariseArray(data: NormalisedTrack[] | NormalisedPlaylist[] | RecentlyPlayedItem[]): string {
  const [head] = data;
  if (head === undefined) return t.value.empty;
  if ("trackCount" in head) return `${data.length} ${t.value.tabPlaylists}`;
  if ("playedAt" in head) return `${data.length} ${t.value.tabRecent}`;
  return `${data.length} ${t.value.tracksCount}`;
}
</script>

<template>
  <div class="spotify-preview">
    <span class="spotify-preview-icon" aria-hidden="true">♪</span>
    <span class="spotify-preview-label">{{ t.previewSummary }}</span>
    <span class="spotify-preview-summary">{{ summary }}</span>
  </div>
</template>

<style scoped>
.spotify-preview {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-radius: 9999px;
  background: #f5f5f5;
  font-size: 0.875rem;
}
.spotify-preview-icon {
  color: #1ed760;
  font-weight: 600;
}
.spotify-preview-label {
  font-weight: 500;
}
.spotify-preview-summary {
  color: #6b7280;
  font-size: 0.75rem;
}
</style>
