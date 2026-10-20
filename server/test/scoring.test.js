import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, score, scaleForLocations, placements, robustSpread, MIN_SCALE_KM } from '../src/scoring.js';

const amsterdam = { lat: 52.3676, lng: 4.9041 };
const paris = { lat: 48.8566, lng: 2.3522 };

test('haversine matches known city distance', () => {
  assert.ok(Math.abs(haversineKm(amsterdam, paris) - 430) < 5);
  assert.equal(haversineKm(paris, paris), 0);
});

test('score falls off exponentially with distance relative to field size', () => {
  assert.equal(score(0, 100), 5000);
  assert.equal(score(0.02, 100), 5000);
  assert.equal(score(10, 100), Math.round(5000 * Math.exp(-1)));
  assert.ok(score(1, 100) > score(5, 100));
  assert.equal(score(100000, 100), 0);
});

test('field size ignores a single far-away outlier', () => {
  const city = [0, 1, 2, 3, 4, 5].map((i) => ({ lat: 52.37 + i * 0.01, lng: 4.9 }));
  const withOutlier = [...city, { lat: -33.9, lng: 18.4 }]; // Cape Town
  assert.ok(scaleForLocations(withOutlier) < 10, 'scale stays city-sized');
  assert.equal(scaleForLocations([paris]), MIN_SCALE_KM);
  const spread = (xs) => robustSpread(xs, (a, b) => Math.abs(a - b));
  assert.equal(spread([0, 10, 20, 30, 40]), 40, 'evenly spread: plain maximum');
  assert.equal(spread([0, 0, 1, 1, 50, 50, 51]), 51, 'two clusters both count');
  assert.equal(spread([5]), 0);
});

test('placements: players beaten, ties split, no guess beats nobody', () => {
  const result = placements([{ distance: 5 }, { distance: 1 }, { distance: 5 }, { distance: null }]);
  assert.deepEqual(result, [
    { placement: 1.5, rank: 2 },
    { placement: 3, rank: 1 },
    { placement: 1.5, rank: 2 },
    { placement: 0, rank: null },
  ]);
});
