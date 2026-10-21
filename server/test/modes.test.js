import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, diverseDraw } from '../src/modes.js';

const TRIALS = 300;
const ROUNDS = 5;
const ctx = { settings: { orderSize: 4 }, set: { map: null } };

// 50 pictures at home, 50 from one holiday and 10 one-off trips, each far from the others.
const ONE_OFFS = [
  [41.39, 2.17], [59.33, 18.07], [38.72, -9.14], [60.17, 24.94], [37.98, 23.73],
  [47.5, 19.04], [53.35, -6.26], [55.68, 12.57], [64.15, -21.94], [44.43, 26.1],
];
function burstyPlaces() {
  const home = Array.from({ length: 50 }, (_, i) => ({ id: `home${i}`, group: 'home', lat: 52.37 + i * 1e-4, lng: 4.9 }));
  const holiday = Array.from({ length: 50 }, (_, i) => ({ id: `rome${i}`, group: 'holiday', lat: 41.9 + i * 1e-4, lng: 12.5 }));
  const oneOffs = ONE_OFFS.map(([lat, lng], i) => ({ id: `trip${i}`, group: 'one-off', lat, lng }));
  return [...home, ...holiday, ...oneOffs];
}

// The same shape in time: a burst of everyday pictures, a two-week holiday and one-off days years apart.
function burstyTimes() {
  const at = (ms) => new Date(ms).toISOString().slice(0, 16);
  const day = 24 * 3600 * 1000;
  const start = Date.UTC(2015, 0, 1);
  const home = Array.from({ length: 50 }, (_, i) => ({ id: `home${i}`, group: 'home', takenAt: at(start + i * 3600 * 1000) }));
  const holiday = Array.from({ length: 50 }, (_, i) => ({ id: `trip${i}`, group: 'holiday', takenAt: at(start + 400 * day + (i % 14) * day) }));
  const oneOffs = Array.from({ length: 10 }, (_, i) => ({ id: `day${i}`, group: 'one-off', takenAt: at(start + (800 + i * 120) * day) }));
  return [...home, ...holiday, ...oneOffs];
}

/** Average number of pictures per game from each group, and how often a game has 2+ from one burst. */
function stats(draw) {
  const totals = { home: 0, holiday: 0, 'one-off': 0 };
  let repeats = 0;
  for (let t = 0; t < TRIALS; t++) {
    const counts = { home: 0, holiday: 0, 'one-off': 0 };
    for (const image of draw()) counts[image.group]++;
    for (const g in counts) totals[g] += counts[g] / TRIALS;
    if (counts.home > 1 || counts.holiday > 1) repeats++;
  }
  return { ...totals, repeats: repeats / TRIALS };
}

function assertSpread(s) {
  // Drawn uniformly, a game would hold 5 * 10/110 ≈ 0.45 one-off pictures and nearly always 2+ from a burst.
  assert.ok(s['one-off'] > 2, `one-offs per game: ${s['one-off']}`);
  assert.ok(s.repeats < 0.6, `games with 2+ pictures from one burst: ${s.repeats}`);
  // Bursts are held back, not excluded.
  assert.ok(s.home > 0.5 && s.holiday > 0.5, `home ${s.home}, holiday ${s.holiday}`);
}

test('location rounds favour places the library has few pictures of', () => {
  const pool = burstyPlaces();
  assertSpread(stats(() => MODES.location.drawRounds(pool, ROUNDS, ctx, new Set()).flat()));
});

test('date rounds favour times the library has few pictures of', () => {
  const pool = burstyTimes();
  assertSpread(stats(() => MODES.date.drawRounds(pool, ROUNDS, ctx, new Set()).flat()));
});

test('order rounds are spread in time and fill whole rounds', () => {
  const pool = burstyTimes();
  const rounds = MODES.order.drawRounds(pool, 3, ctx, new Set());
  assert.equal(rounds.length, 3);
  assert.ok(rounds.every((r) => r.length === 4));
  assert.equal(new Set(rounds.flat().map((i) => i.id)).size, 12);
  // Not enough pictures for every round: only whole rounds.
  assert.equal(MODES.order.drawRounds(pool.slice(0, 10), 3, ctx, new Set()).length, 2);
});

test('pictures not played before come first, then played ones', () => {
  const pool = burstyPlaces();
  const played = new Set(pool.filter((i) => i.group !== 'home').map((i) => i.id));
  const drawn = diverseDraw(pool, 55, played, [() => 1, 1]);
  assert.ok(drawn.slice(0, 50).every((i) => i.group === 'home'));
  assert.ok(drawn.slice(50).every((i) => i.group !== 'home'));
  assert.equal(new Set(drawn).size, 55);
});
