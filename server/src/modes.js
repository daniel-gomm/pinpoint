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

/** Shuffled pool with pictures not played before (e.g. in a rematch) first. */
function prioritise(pool, played) {
  return [...shuffle(pool.filter((i) => !played.has(i.id))), ...shuffle(pool.filter((i) => played.has(i.id)))];
}

const contributors = (images) => [...new Set(images.map((i) => i.contributorId).filter(Boolean))];

/** Shared by the modes that show one picture per round. */
const singlePicture = {
  minPool: () => 1,
  drawRounds: (pool, count, settings, played) => prioritise(pool, played).slice(0, count).map((image) => [image]),
  // Whoever contributed the picture knows the answer and sits the round out.
  sitOut: (images) => contributors(images),
};

// ---------- location ----------
// On a custom map (floor plan etc.) coordinates are image pixels: lat = y, lng = x.
function mapDistance(map) {
  return (a, b) => {
    const px = Math.hypot(a.lat - b.lat, a.lng - b.lng);
    // km when the real width is known, otherwise percent of the map width
    return map.metersWide ? (px * map.metersWide) / map.width / 1000 : (px / map.width) * 100;
  };
}

const location = {
  ...singlePicture,
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

const date = {
  ...singlePicture,
  isReady: isDated,
  // scale unit: hours
  defaultScale(pool, { settings }) {
    const precision = settings.precision;
    const floor = precision === 'minute' ? 24 : 5 * PERIOD_HOURS[precision];
    return Math.max(floor, robustSpread(pool, (a, b) => Math.abs(timeOf(a) - timeOf(b)) / HOUR));
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
  drawRounds(pool, count, settings, played) {
    const sorted = prioritise(pool, played);
    const rounds = [];
    for (let i = 0; i + settings.orderSize <= sorted.length && rounds.length < count; i += settings.orderSize) {
      rounds.push(sorted.slice(i, i + settings.orderSize));
    }
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
 * @property {(pool: any[], count: number, settings: any, played: Set<string>) => any[][]} drawRounds
 * @property {(images: any[]) => string[]} sitOut players who know this round's answer
 * @property {(payload: any, ctx: any) => any} parseGuess validates and normalises a guess
 * @property {(guess: any, images: any[], ctx: any) => number} distance
 * @property {(distance: number, scale: number, ctx: any) => number} score 0–5000
 * @property {(images: any[], ctx?: any) => any} answer revealed after the round
 */

/** @type {Record<string, Objective>} */
export const MODES = { location, date, order };
