import crypto from 'node:crypto';
import { GameError } from './errors.js';
import { ImmichError } from './immich.js';
import { MODES } from './modes.js';
import { processImage } from './images.js';

/** @typedef {import('./game.js').Pool} Pool */

// Previews held in memory so every player of a round gets the same fetch; ~0.5 MB each.
const CACHE_SIZE = 80;
// More random draws when the first one has too few usable pictures (e.g. few geotagged ones).
const MAX_DRAWS = 3;

/**
 * Where a game's pictures come from: a picture set on disk, or an Immich server.
 * Games only ever see the pool of picture records; files are fetched through here.
 * @param {{store: import('./sets.js').SetStore, immich: import('./immich.js').ImmichConfig}} deps
 */
export function createSources({ store, immich }) {
  /** @type {Map<string, Promise<Buffer>>} */
  const previews = new Map();

  function immichClient() {
    const client = immich.client();
    if (!client) throw new GameError('Immich is not connected. Connect it on the Picture sets page.');
    return client;
  }

  /** @returns {Promise<Pool>} */
  async function pool(settings) {
    if (settings.source !== 'immich') {
      const set = store.get(settings.setId);
      if (!set) throw new GameError('The picture set for this game was deleted.');
      return { set, images: set.images };
    }
    const client = immichClient();
    const filter = immichFilter(settings.immich);
    const { albumId, favorites } = settings.immich;
    const name = albumId ? (await client.album(albumId).catch(albumGone)).albumName : 'Immich library';

    const objective = MODES[settings.mode];
    const needed = settings.rounds * objective.minPool(settings);
    /** @type {Map<string, any>} */
    const found = new Map();
    for (let draw = 0; draw < MAX_DRAWS; draw++) {
      const assets = await client.random(filter);
      for (const asset of assets) {
        const image = toImage(asset, settings.immich, client);
        if (image) found.set(image.id, image);
      }
      const ready = [...found.values()].filter((i) => objective.isReady(i)).length;
      // A short answer means the filter matched fewer pictures than one draw returns: we have them all.
      if (assets.length < 1000 || ready >= needed * 2) break;
    }
    return {
      set: { id: albumId ?? 'library', name: favorites ? `${name} (favourites)` : name, map: null },
      images: spreadOut([...found.values()]),
    };
  }

  /**
   * A round's picture, for sending to players.
   * @returns {Promise<{file: string} | {buffer: Buffer}>}
   */
  async function file(game, image) {
    if (game.settings.source !== 'immich') {
      const file = store.filePath(game.settings.setId, image.file);
      if (!file) throw new GameError('Picture not found.');
      return { file };
    }
    return { buffer: await preview(image.id) };
  }

  function preview(assetId) {
    let pending = previews.get(assetId);
    if (pending) {
      previews.delete(assetId); // re-insert: most recently used last
    } else {
      // Immich previews carry no camera data, but re-encoding guarantees it like for uploads.
      pending = immichClient().preview(assetId).then(async (data) => (await processImage(data)).buffer);
      pending.catch(() => previews.delete(assetId));
    }
    previews.set(assetId, pending);
    while (previews.size > CACHE_SIZE) previews.delete(previews.keys().next().value);
    return pending;
  }

  /** Fetches the current and the next round's pictures ahead, so nobody waits when a round starts. */
  function prefetch(game) {
    if (game.settings.source !== 'immich' || game.roundIndex < 0) return;
    for (const round of game.rounds.slice(game.roundIndex, game.roundIndex + 2)) {
      for (const image of round.images) {
        if (!previews.has(image.id)) preview(image.id).catch(() => {});
      }
    }
  }

  return { pool, file, prefetch };
}

function albumGone(err) {
  if (err instanceof ImmichError && err.status === 404) throw new GameError('That Immich album no longer exists.');
  throw err;
}

/** Search filter for the game's Immich settings. */
export function immichFilter({ albumId, favorites, from, to }) {
  return {
    ...(albumId ? { albumIds: [albumId] } : {}),
    ...(favorites ? { isFavorite: true } : {}),
    ...(from ? { takenAfter: `${from}T00:00:00.000Z` } : {}),
    ...(to ? { takenBefore: `${to}T23:59:59.999Z` } : {}),
  };
}

/**
 * An Immich asset as a picture record. Immich's localDateTime is the wall-clock time where the
 * photo was taken, which is exactly what date mode compares.
 */
export function toImage(asset, { cameraOnly }, client) {
  const exif = asset.exifInfo ?? {};
  // Screenshots, messenger copies and scans have no camera make; their dates are often just file dates.
  if (cameraOnly && !exif.make) return null;
  const lat = Number(exif.latitude);
  const lng = Number(exif.longitude);
  const located = exif.latitude != null && exif.longitude != null && Number.isFinite(lat) && Number.isFinite(lng) &&
    !(lat === 0 && lng === 0);
  const takenAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(asset.localDateTime ?? '') ? asset.localDateTime.slice(0, 16) : null;
  const place = [exif.city, exif.country].filter(Boolean).join(', ');
  return {
    id: asset.id,
    lat: located ? lat : null,
    lng: located ? lng : null,
    takenAt,
    caption: (exif.description ?? '').trim().slice(0, 200) || place,
    link: client.link(asset.id),
  };
}

/**
 * Libraries are full of bursts: many shots of one moment. Keep one picture per hour so a game
 * doesn't show near-identical pictures in different rounds.
 */
export function spreadOut(images) {
  const seen = new Set();
  const kept = [];
  for (const image of shuffle(images)) {
    const key = image.takenAt ? image.takenAt.slice(0, 13) : image.id;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(image);
  }
  return kept;
}

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
