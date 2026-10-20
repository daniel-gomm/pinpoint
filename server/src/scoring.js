const EARTH_RADIUS_KM = 6371.0088;
const MAX_SCORE = 5000;
const PERFECT_KM = 0.025;
export const MIN_SCALE_KM = 1;

const rad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Size of the playing field: the largest distance between any two locations.
export function scaleForLocations(locations) {
  let max = 0;
  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      max = Math.max(max, haversineKm(locations[i], locations[j]));
    }
  }
  return Math.max(MIN_SCALE_KM, max);
}

// GeoGuessr-style exponential falloff: being off by a tenth of the field costs ~63%.
export function score(distance, scale, perfect = PERFECT_KM) {
  if (distance <= perfect) return MAX_SCORE;
  return Math.round(MAX_SCORE * Math.exp((-10 * distance) / scale));
}
