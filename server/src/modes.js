import crypto from 'node:crypto';
import { haversineKm, scaleForLocations, score } from './scoring.js';
import { GameError } from './errors.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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

const location = {
  isReady: isLocated,
  // scale unit: km
  defaultScale: (images) => scaleForLocations(images),
  setup: () => ({}),
  parseGuess({ lat, lng }) {
    lat = Number(lat);
    lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) {
      throw new GameError('That is not a valid map position.');
    }
    // Leaflet allows panning across the antimeridian; normalise to [-180, 180).
    return { lat, lng: ((((lng + 180) % 360) + 360) % 360) - 180 };
  },
  distance: (guess, image) => haversineKm(guess, image),
  score: (distance, scale) => score(distance, scale),
  answer: (image) => ({ lat: image.lat, lng: image.lng }),
};

const date = {
  isReady: isDated,
  // scale unit: hours. A set shot within one day still gets a full day of room.
  defaultScale(images) {
    const times = images.map((i) => parseTakenAt(i.takenAt));
    return Math.max(24, (Math.max(...times) - Math.min(...times)) / HOUR);
  },
  /**
   * The slider range players pick from. Its ends are padded by a random amount so they don't
   * reveal when the earliest or latest picture was taken, and it never extends past today.
   */
  setup(images, now = Date.now()) {
    const times = images.map((i) => parseTakenAt(i.takenAt));
    const min = Math.min(...times);
    const max = Math.max(...times);
    const room = Math.max(max - min, 30 * DAY);
    const pad = () => room * (0.15 + crypto.randomInt(1000) / 1000 * 0.35);
    const endOfToday = Math.ceil(now / DAY) * DAY;
    const start = Math.floor((min - pad()) / DAY) * DAY;
    const end = Math.min(endOfToday, Math.ceil((max + pad()) / DAY) * DAY);
    return { range: { start, end: Math.max(end, Math.ceil(max / DAY) * DAY) } };
  },
  parseGuess({ time }, setup) {
    time = Number(time);
    if (!Number.isFinite(time) || time < setup.range.start || time > setup.range.end) {
      throw new GameError('Pick a date within the timeline.');
    }
    return { time };
  },
  distance: (guess, image) => Math.abs(guess.time - parseTakenAt(image.takenAt)) / HOUR,
  score: (distance, scale) => score(distance, scale, 0.25),
  answer: (image) => ({ time: parseTakenAt(image.takenAt) }),
};

export const MODES = { location, date };
