import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/** @typedef {import('../../shared/protocol.js').MapSetup} MapSetup */

const removed = new WeakSet();

/**
 * A Leaflet map: the OpenStreetMap world map, or a custom image (floor plan, campus map ...)
 * where coordinates are pixels with lat = y (from the bottom) and lng = x.
 * @param {HTMLElement} el
 * @param {{custom?: {url: string, width: number, height: number} | null}} [opts]
 */
export function createMap(el, { custom = null } = {}) {
  let map;
  if (custom) {
    const bounds = L.latLngBounds([0, 0], [custom.height, custom.width]);
    map = L.map(el, { crs: L.CRS.Simple, minZoom: -5, maxZoom: 3, zoomSnap: 0.25, attributionControl: false });
    L.imageOverlay(custom.url, bounds).addTo(map);
    map.fitBounds(bounds);
    map.setMaxBounds(bounds.pad(0.25));
    map.once('resize', () => map.fitBounds(bounds));
  } else {
    map = L.map(el, { worldCopyJump: true }).setView([30, 10], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  }
  // Containers often get their size after layout settles.
  const observer = new ResizeObserver(() => map.invalidateSize());
  observer.observe(el);
  map.on('unload', () => observer.disconnect());
  // Rounds end on a timer, often while a player is mid-zoom. Leaflet finishes a zoom animation
  // in a timeout that crashes if the map is gone by then; that callback bails out when
  // _animatingZoom is false, so clear it on removal.
  const remove = map.remove.bind(map);
  map.remove = () => {
    removed.add(map);
    map.stop();
    /** @type {any} */ (map)._animatingZoom = false;
    return remove();
  };
  return map;
}

/** Fits the map around some points, or centers on a single one. */
export function showPoints(map, points, { custom = false } = {}) {
  requestAnimationFrame(() => {
    if (removed.has(map)) return;
    map.invalidateSize();
    if (points.length > 1) map.fitBounds(points, { padding: [50, 50], maxZoom: custom ? 1 : 15, animate: false });
    else if (points.length === 1) map.setView(points[0], custom ? 0 : 12, { animate: false });
  });
}

export function pinIcon(color = 'var(--pin)', label = '') {
  return L.divIcon({
    className: 'pin-icon',
    html: `<span class="pin" style="--c:${color}"><span>${label}</span></span>`,
    iconSize: [28, 38],
    iconAnchor: [14, 37],
  });
}

export function dotIcon(color, label = '') {
  return L.divIcon({
    className: 'dot-icon',
    html: `<span class="dot" style="--c:${color}" title="${escapeHtml(label)}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Shortest-path longitude so lines don't wrap the long way around the globe. */
export function nearLng(lng, ref) {
  let out = lng;
  while (out - ref > 180) out -= 360;
  while (ref - out > 180) out += 360;
  return out;
}

export { L };
