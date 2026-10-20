import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export function createMap(el, { center = [30, 10], zoom = 2 } = {}) {
  const map = L.map(el, { worldCopyJump: true, zoomControl: true, attributionControl: true }).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  // Containers often get their size after layout settles.
  const observer = new ResizeObserver(() => map.invalidateSize());
  observer.observe(el);
  map.on('unload', () => observer.disconnect());
  return map;
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
