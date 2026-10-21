import crypto from 'node:crypto';
import { haversineKm, scaleForLocations, robustSpread, score, MAX_SCORE } from './scoring.js';
import { GameError } from './errors.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SLOT = 15 * 60 * 1000;
const TAKEN_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Photo times are wall-clock times where the photo was taken, stored as "YYYY-MM-DDTHH:mm"
 * without a timezone. They are compared as if they were UTC so every player sees the same clock.
 */
export function parseTakenAt(value) {
  if (typeof value !== 'string' || !TAKEN_AT_RE.test(value)) return null;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

export const isLocated = (image) => Number.isFinite(image.lat) && Number.isFinite(image.lng);
export const isDated = (image) => parseTakenAt(image.takenAt) !== null;
const timeOf = (image) => /** @type {number} */ (parseTakenAt(image.takenAt));

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const random = () => crypto.randomInt(2 ** 47) / 2 ** 47;

// Libraries come in bursts: a holiday or a day at home leaves hundreds of pictures of one place
// and time. Rounds are drawn so that bursts come up less often than their size, though not never.
// How strongly crowded pictures are held back: 0 draws every picture equally, 1 every burst equally.
const BURST_DAMPING = 0.6;
// How much a drawn picture holds back the pictures near it for the rest of the game.
const REPULSION = 0.8;
// Crowding is measured against at most this many pictures, so big albums stay quick.
const DENSITY_SAMPLE = 2000;
// Distances at which two pictures count as mostly unrelated.
const NEARBY_KM = 25;
const NEARBY_HOURS = 14 * 24;
const NEARBY_SHARE_OF_MAP = 0.05;

/**
 * `count` pictures from the pool, favouring ones from places or times the pool has few pictures
 * of and ones unlike those already drawn. Pictures not played before (e.g. in a rematch) come first.
 * @param {any[]} pool
 * @param {number} count
 * @param {Set<string>} played
 * @param {[(a: any, b: any) => number, number]} spread distance between pictures, and what counts as near
 */
export function diverseDraw(pool, count, played, [distance, nearby]) {
  const near = (a, b) => Math.exp(-distance(a, b) / nearby);
  const reference = new Set(pool.length > DENSITY_SAMPLE ? shuffle(pool).slice(0, DENSITY_SAMPLE) : pool);
  const weights = pool.map((a) => {
    let crowd = 1;
    for (const b of reference) if (b !== a) crowd += near(a, b);
    return crowd ** -BURST_DAMPING;
  });
  let left = pool.map((_, i) => i);
  const drawn = [];
  while (drawn.length < count && left.length) {
    const fresh = left.filter((i) => !played.has(pool[i].id));
    const from = fresh.length ? fresh : left;
    let r = random() * from.reduce((sum, i) => sum + weights[i], 0);
    const pick = from.find((i) => (r -= weights[i]) < 0) ?? from[from.length - 1];
    left = left.filter((i) => i !== pick);
    drawn.push(pool[pick]);
    for (const i of left) weights[i] *= 1 - REPULSION * near(pool[pick], pool[i]);
  }
  return drawn;
}

const contributors = (images) => [...new Set(images.map((i) => i.contributorId).filter(Boolean))];

/**
 * Shared by the modes that show one picture per round.
 * @param {(ctx: any) => [(a: any, b: any) => number, number]} spread
 */
const singlePicture = (spread) => ({
  minPool: () => 1,
  drawRounds: (pool, count, ctx, played) => diverseDraw(pool, count, played, spread(ctx)).map((image) => [image]),
  // Whoever contributed the picture knows the answer and sits the round out.
  sitOut: (images) => contributors(images),
});

// ---------- location ----------
// On a custom map (floor plan etc.) coordinates are image pixels: lat = y, lng = x.
function mapDistance(map) {
  return (a, b) => {
    const px = Math.hypot(a.lat - b.lat, a.lng - b.lng);
    // km when the real width is known, otherwise percent of the map width
    return map.metersWide ? (px * map.metersWide) / map.width / 1000 : (px / map.width) * 100;
  };
}

/** @returns {[(a: any, b: any) => number, number]} */
function locationSpread({ set }) {
  if (!set.map) return [haversineKm, NEARBY_KM];
  // mapDistance is in km when the real width is known, otherwise in percent of the map width.
  const width = set.map.metersWide ? set.map.metersWide / 1000 : 100;
  return [mapDistance(set.map), NEARBY_SHARE_OF_MAP * width];
}

const location = {
  ...singlePicture(locationSpread),
  isReady: isLocated,
  defaultScale(pool, { set }) {
    if (!set.map) return scaleForLocations(pool);
    const floor = set.map.metersWide ? 0.01 : 5;
    return Math.max(floor, robustSpread(pool, mapDistance(set.map)));
  },
  setup: (pool, { set, code }) => ({
    map: set.map
      ? { url: `/api/games/${code}/map`, width: set.map.width, height: set.map.height, metersWide: set.map.metersWide ?? null }
      : null,
  }),
  parseGuess({ lat, lng }, { setup }) {
    lat = Number(lat);
    lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new GameError('That is not a valid map position.');
    if (setup.map) {
      if (lat < 0 || lng < 0 || lat > setup.map.height || lng > setup.map.width) {
        throw new GameError('Place your pin on the map.');
      }
      return { lat, lng };
    }
    if (Math.abs(lat) > 90) throw new GameError('That is not a valid map position.');
    // Leaflet allows panning across the antimeridian; normalise to [-180, 180).
    if (lng < -180 || lng >= 180) lng = ((((lng + 180) % 360) + 360) % 360) - 180;
    return { lat, lng };
  },
  distance: (guess, [image], { setup }) => (setup.map ? mapDistance(setup.map)(guess, image) : haversineKm(guess, image)),
  score: (distance, scale, { setup }) => score(distance, scale, setup.map && !setup.map.metersWide ? 0.5 : 0.025),
  answer: ([image]) => ({ lat: image.lat, lng: image.lng, caption: image.caption }),
};

// ---------- date ----------
export const PRECISIONS = ['minute', 'day', 'month', 'year'];
const PERIOD_HOURS = { day: 24, month: 730.5, year: 8766 };
const periodIndex = (ms, precision) => {
  const d = new Date(ms);
  if (precision === 'year') return d.getUTCFullYear();
  if (precision === 'month') return d.getUTCFullYear() * 12 + d.getUTCMonth();
  return Math.floor(ms / DAY);
};
const periodStart = (index, precision) => {
  if (precision === 'year') return Date.UTC(index, 0, 1);
  if (precision === 'month') return Date.UTC(Math.floor(index / 12), index % 12, 1);
  return index * DAY;
};
// Minimum width of the timeline, so a tight set doesn't produce a giveaway-narrow slider.
const MIN_ROOM = { minute: 30 * DAY, day: 30 * DAY, month: 365 * DAY, year: 10 * 365 * DAY };

const hoursApart = (a, b) => Math.abs(timeOf(a) - timeOf(b)) / HOUR;
/** @type {[(a: any, b: any) => number, number]} */
const timeSpread = [hoursApart, NEARBY_HOURS];

const date = {
  ...singlePicture(() => timeSpread),
  isReady: isDated,
  // scale unit: hours
  defaultScale(pool, { settings }) {
    const precision = settings.precision;
    const floor = precision === 'minute' ? 24 : 5 * PERIOD_HOURS[precision];
    return Math.max(floor, robustSpread(pool, hoursApart));
  },
  /**
   * The timeline players pick from. Its ends are padded by a random amount so they don't
   * reveal when the earliest or latest picture was taken, and it never extends past today.
   * `end` is exclusive: the start of the period after the last selectable one.
   */
  setup(pool, { settings, now }) {
    const precision = settings.precision;
    const unit = precision === 'minute' ? 'day' : precision;
    const times = pool.map(timeOf);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const room = Math.max(max - min, MIN_ROOM[precision]);
    const pad = () => room * (0.15 + (crypto.randomInt(1000) / 1000) * 0.35);
    const last = Math.min(periodIndex(now, unit), periodIndex(max + pad(), unit));
    const end = periodStart(Math.max(last, periodIndex(max, unit)) + 1, unit);
    const start = periodStart(periodIndex(min - pad(), unit), unit);
    return { precision, range: { start, end } };
  },
  parseGuess({ time }, { setup }) {
    time = Number(time);
    const { start, end } = setup.range;
    if (!Number.isFinite(time) || time < start || time >= end) throw new GameError('Pick a date within the timeline.');
    const p = setup.precision;
    return { time: p === 'minute' ? Math.floor(time / SLOT) * SLOT : periodStart(periodIndex(time, p), p) };
  },
  distance(guess, [image], { setup }) {
    const p = setup.precision;
    if (p === 'minute') return Math.abs(guess.time - timeOf(image)) / HOUR;
    return Math.abs(periodIndex(guess.time, p) - periodIndex(timeOf(image), p)) * PERIOD_HOURS[p];
  },
  score: (distance, scale) => score(distance, scale, 0.25),
  answer: ([image]) => ({ time: timeOf(image), caption: image.caption }),
};

// ---------- order ----------
export const ORDER_SIZES = [3, 4, 5, 6];
const pairs = (n) => (n * (n - 1)) / 2;

const order = {
  isReady: isDated,
  minPool: (settings) => settings.orderSize,
  defaultScale: () => 1,
  setup: (pool, { settings }) => ({ size: settings.orderSize }),
  drawRounds(pool, count, { settings }, played) {
    const size = settings.orderSize;
    const drawn = diverseDraw(pool, count * size, played, timeSpread);
    const rounds = [];
    for (let i = 0; i + size <= drawn.length; i += size) rounds.push(drawn.slice(i, i + size));
    return rounds;
  },
  // Contributors know only their own pictures' dates, so everyone plays every round.
  sitOut: () => [],
  parseGuess({ order: guess }, { setup }) {
    const n = setup.size;
    const valid = Array.isArray(guess) && guess.length === n &&
      [...guess].sort((a, b) => a - b).every((v, i) => v === i);
    if (!valid) throw new GameError('Put every picture in a position.');
    return { order: guess.map(Number) };
  },
  /** Pairs of pictures put in the wrong order. Pictures taken at the same time can go either way. */
  distance(guess, images) {
    const t = guess.order.map((slot) => timeOf(images[slot]));
    let wrong = 0;
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if (t[i] > t[j]) wrong += 1;
    return wrong;
  },
  score: (distance, scale, { setup }) => Math.round(MAX_SCORE * (1 - distance / pairs(setup.size))),
  answer: (images) => ({
    order: images.map((_, slot) => slot).sort((a, b) => timeOf(images[a]) - timeOf(images[b])),
    pictures: images.map((i) => ({ time: timeOf(i), caption: i.caption })),
  }),
};

/**
 * What the game engine needs from a mode.
 * @typedef {object} Objective
 * @property {(image: any) => boolean} isReady whether a picture has what this mode asks about
 * @property {(settings: any) => number} minPool pictures needed for one round
 * @property {(pool: any[], ctx: any) => number} defaultScale
 * @property {(pool: any[], ctx: any) => any} setup public per-game data for the guessing UI
 * @property {(pool: any[], count: number, ctx: any, played: Set<string>) => any[][]} drawRounds
 * @property {(images: any[]) => string[]} sitOut players who know this round's answer
 * @property {(payload: any, ctx: any) => any} parseGuess validates and normalises a guess
 * @property {(guess: any, images: any[], ctx: any) => number} distance
 * @property {(distance: number, scale: number, ctx: any) => number} score 0–5000
 * @property {(images: any[], ctx?: any) => any} answer revealed after the round
 */

/** @type {Record<string, Objective>} */
export const MODES = { location, date, order };
