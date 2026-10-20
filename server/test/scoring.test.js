import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, score, scaleForLocations, MIN_SCALE_KM } from '../src/scoring.js';

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

test('field size is the largest pairwise distance with a floor', () => {
  assert.ok(Math.abs(scaleForLocations([amsterdam, paris, amsterdam]) - haversineKm(amsterdam, paris)) < 1e-9);
  assert.equal(scaleForLocations([paris]), MIN_SCALE_KM);
});
