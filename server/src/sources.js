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
// Pages of 1000 read from an album; beyond that only its newest pictures are used.
const MAX_ALBUM_PAGES = 10;
// Partner pictures are sampled from their timeline, then loaded one by one for their camera data.
// That takes ~50 ms per picture, so only about twice what the game needs are loaded.
const MIN_PARTNER_SAMPLE = 30;
const MAX_PARTNER_SAMPLE = 200;
const MAX_PARTNER_MONTHS = 24;
const CONCURRENCY = 8;
// The longest a round waits for its pictures before it starts anyway.
const READY_TIMEOUT_MS = 15_000;

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
    const { albumId, favorites, partners: withPartners } = settings.immich;
    const objective = MODES[settings.mode];
    const needed = settings.rounds * objective.minPool(settings);
    let name = albumId ? (await client.album(albumId).catch(albumGone)).albumName : 'Immich library';

    /** @type {Map<string, any>} */
    const found = new Map();
    const add = (assets) => {
      for (const asset of assets) {
        const image = toImage(asset, settings.immich, client);
        if (image) found.set(image.id, image);
      }
    };
    if (albumId) {
      // Random search only covers the user's own pictures, so a shared album would come up nearly
      // empty. Albums are usually small enough to list.
      for (let page = 1, n = 0; page && n < MAX_ALBUM_PAGES; n++) {
        const { items, next } = await client.search(filter, page);
        add(items);
        page = next;
      }
    } else {
      for (let draw = 0; draw < MAX_DRAWS; draw++) {
        const assets = await client.random(filter);
        add(assets);
        const ready = [...found.values()].filter((i) => objective.isReady(i)).length;
        // A short answer means the filter matched fewer pictures than one draw returns: we have them all.
        if (assets.length < 1000 || ready >= needed * 2) break;
      }
    }
    let images = spreadOut([...found.values()]);

    if (withPartners && !albumId) {
      const partners = await client.partners();
      if (!partners) throw new GameError('To include partner photos, add the partner.read and timeline.read permissions to the Immich API key.');
      if (partners.length) {
        const libraries = [{ images: images.filter((i) => objective.isReady(i)), total: await timelineTotal(client, null, settings.immich) }];
        for (const partner of partners) libraries.push(await partnerLibrary(client, partner.id, settings, needed));
        images = spreadOut(mix(libraries, needed * 2));
        name = `${name} and ${partners.map((p) => p.name).join(', ')}`;
      }
    }
    return {
      set: { id: albumId ?? 'library', name: favorites ? `${name} (favourites)` : name, map: null },
      images,
    };
  }

  /**
   * A round's picture, for sending to players. `reveal` asks for the version shown after the round.
   * @param {any} game
   * @param {any} image
   * @param {{reveal?: boolean}} [opts]
   * @returns {Promise<{file: string} | {buffer: Buffer}>}
   */
  async function file(game, image, { reveal = false } = {}) {
    if (game.settings.source !== 'immich') {
      const file = store.filePath(game.settings.setId, reveal && image.revealFile ? image.revealFile : image.file);
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

  /**
   * Resolves once a round's pictures are fetched (or failed), so its clock doesn't start while
   * players still wait for them. Gives up after READY_TIMEOUT_MS.
   * @returns {Promise<void>}
   */
  async function ready(game, index) {
    const round = game.rounds[index];
    if (game.settings.source !== 'immich' || !round) return;
    let timer;
    const loads = Promise.all(round.images.map((image) => preview(image.id).catch(() => {})));
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, READY_TIMEOUT_MS); });
    await Promise.race([loads, timeout]);
    clearTimeout(timer);
  }

  return { pool, file, prefetch, ready };
}

/** Months of a timeline within the game's date range. */
async function timelineMonthsInRange(client, userId, { favorites, from, to }) {
  const months = await client.timelineMonths({ userId, favorites });
  return months.filter(({ timeBucket: m }) => (!from || m.slice(0, 7) >= from.slice(0, 7)) && (!to || m.slice(0, 7) <= to.slice(0, 7)));
}

async function timelineTotal(client, userId, immichSettings) {
  return (await timelineMonthsInRange(client, userId, immichSettings)).reduce((sum, m) => sum + m.count, 0);
}

/**
 * A random sample of a partner's pictures. Search doesn't cover partners, so this reads random
 * months of their timeline, then loads the camera data of the sampled pictures one by one.
 * @returns {Promise<{images: any[], total: number}>}
 */
async function partnerLibrary(client, userId, settings, needed) {
  const { from, to } = settings.immich;
  const objective = MODES[settings.mode];
  const sample = Math.min(MAX_PARTNER_SAMPLE, Math.max(MIN_PARTNER_SAMPLE, needed * 2));
  const months = await timelineMonthsInRange(client, userId, settings.immich);
  const total = months.reduce((sum, m) => sum + m.count, 0);

  // Many months, picked regardless of size so busy ones (holidays) don't crowd out the rest.
  const picked = shuffle(months).slice(0, MAX_PARTNER_MONTHS).map((m) => m.timeBucket);
  const day = (takenAt) => takenAt.slice(0, 10);
  const pool = (await mapLimit(picked, CONCURRENCY, (month) => client.timelineMonth(month, { userId, favorites: settings.immich.favorites })))
    .flat()
    .filter((a) => a.isImage && !a.isTrashed && (!from || day(a.takenAt) >= from) && (!to || day(a.takenAt) <= to))
    // Immich only knows a place for pictures with a location.
    .filter((a) => settings.mode !== 'location' || a.city);

  const assets = await mapLimit(shuffle(pool).slice(0, sample), CONCURRENCY, (a) => client.asset(a.id).catch(() => null));
  const images = assets
    .filter(Boolean)
    .map((asset) => toImage(asset, settings.immich, client))
    .filter((image) => image && objective.isReady(image) && (!from || day(image.takenAt) >= from) && (!to || day(image.takenAt) <= to));
  return { images: spreadOut(images), total };
}

/**
 * Pictures from several libraries, each making up its share of the pool by how many pictures it
 * holds, so a small sample of a big library isn't drowned out. Never fewer than `atLeast` when
 * there are that many.
 * @param {{images: any[], total: number}[]} libraries
 */
export function mix(libraries, atLeast) {
  const usable = libraries.filter((l) => l.images.length && l.total > 0);
  const sum = usable.reduce((s, l) => s + l.total, 0);
  const available = usable.reduce((s, l) => s + l.images.length, 0);
  // The largest pool every library can fill at its share.
  const balanced = Math.min(...usable.map((l) => (l.images.length * sum) / l.total));
  const size = Math.min(available, Math.max(Math.floor(balanced), atLeast));
  const shuffled = usable.map((l) => shuffle(l.images));
  const taken = usable.map((l, i) => Math.min(shuffled[i].length, Math.round((size * l.total) / sum)));
  // Libraries that run short leave room for the others.
  for (let i = 0; taken.reduce((s, n) => s + n, 0) < size && i < usable.length; i++) {
    const short = size - taken.reduce((s, n) => s + n, 0);
    taken[i] = Math.min(shuffled[i].length, taken[i] + short);
  }
  return shuffled.flatMap((images, i) => images.slice(0, taken[i]));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
