const EARTH_RADIUS_KM = 6371.0088;
export const MAX_SCORE = 5000;
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

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Size of the playing field: the largest distance between two pictures, ignoring outliers.
 * A picture whose median distance to the others is over 3x the typical one (say, the single
 * holiday photo in a set from one city) would otherwise make every other round easy.
 */
export function robustSpread(items, distance) {
  const n = items.length;
  const d = items.map((a) => items.map((b) => distance(a, b)));
  const typical = d.map((row, i) => median(row.filter((_, j) => j !== i)));
  const cutoff = 3 * median(typical);
  const core = n < 3 ? items.map((_, i) => i) : typical.flatMap((m, i) => (m <= cutoff ? [i] : []));
  let max = 0;
  for (const i of core) for (const j of core) max = Math.max(max, d[i][j]);
  return max;
}

// Size of the playing field for real-world locations.
export function scaleForLocations(locations) {
  return Math.max(MIN_SCALE_KM, robustSpread(locations, haversineKm));
}

// GeoGuessr-style exponential falloff: being off by a tenth of the field costs ~63%.
export function score(distance, scale, perfect = PERFECT_KM) {
  if (distance <= perfect) return MAX_SCORE;
  return Math.round(MAX_SCORE * Math.exp((-10 * distance) / scale));
}

/**
 * Placement points for one round: one point per player you were closer than, half a point per tie.
 * Players without a guess beat nobody. A bad round therefore costs at most "last place".
 * @param {Array<{distance: number | null}>} entries
 * @returns {Array<{placement: number, rank: number | null}>} in the same order
 */
export function placements(entries) {
  return entries.map((me) => {
    if (me.distance === null) return { placement: 0, rank: null };
    let placement = 0;
    let better = 0;
    for (const other of entries) {
      if (other === me) continue;
      if (other.distance === null || other.distance > me.distance) placement += 1;
      else if (other.distance === me.distance) placement += 0.5;
      else better += 1;
    }
    return { placement, rank: better + 1 };
  });
}
