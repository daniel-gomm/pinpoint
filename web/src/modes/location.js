import { formatDistance } from '../util.js';
import { createMap, showPoints, pinIcon, dotIcon, nearLng, escapeHtml, L } from '../map.js';

/** @type {import('./index.js').ModeUI} */
export default {
  title: 'Guess the place',
  emptyPrompt: 'Place a pin on the map',
  showsPhotos: false,

  createPicker(el, { state, initial, color, onPick }) {
    el.classList.add('map', 'guess-map');
    const map = createMap(el, { custom: state.setup.map });
    let marker = null;
    let locked = false;
    const place = (latlng) => {
      marker ??= L.marker(latlng, { icon: pinIcon(color), keyboard: false }).addTo(map);
      marker.setLatLng(latlng);
    };
    map.on('click', (e) => {
      if (locked) return;
      place(e.latlng);
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    if (initial) {
      place(initial);
      if (!state.setup.map) map.setView(initial, 4, { animate: false });
    }
    return {
      setLocked(value) {
        locked = value;
        el.classList.toggle('locked', value);
      },
      destroy: () => map.remove(),
    };
  },

  renderAnswer(el, result, { state, colorOf }) {
    el.className = 'map reveal-map';
    const custom = state.setup.map;
    const map = createMap(el, { custom });
    const { answer } = result;
    const points = [[answer.lat, answer.lng]];
    for (const g of result.guesses) {
      if (!g.guess) continue;
      const guess = /** @type {{lat: number, lng: number}} */ (g.guess);
      const lng = custom ? guess.lng : nearLng(guess.lng, answer.lng);
      const color = colorOf(g.playerId);
      L.polyline([[answer.lat, answer.lng], [guess.lat, lng]], { color, weight: 2, dashArray: '6 6', opacity: 0.9 }).addTo(map);
      L.marker([guess.lat, lng], { icon: dotIcon(color, g.name) })
        .bindTooltip(`${escapeHtml(g.name)}: ${this.formatOff(g.distance, state)}`, { direction: 'top', offset: [0, -8] })
        .addTo(map);
      points.push([guess.lat, lng]);
    }
    L.marker([answer.lat, answer.lng], { icon: pinIcon('var(--pin)'), zIndexOffset: 1000 })
      .bindTooltip(answer.caption ? escapeHtml(answer.caption) : 'Here', { direction: 'top', offset: [0, -34] })
      .addTo(map);
    showPoints(map, points, { custom: Boolean(custom) });
    return () => map.remove();
  },

  formatOff(distance, state) {
    if (distance === null || distance === undefined) return 'No guess';
    const map = state.setup?.map;
    // Without a known real-world width, custom maps measure in percent of their width.
    if (map && !map.metersWide) return `${distance < 10 ? distance.toFixed(1) : Math.round(distance)}% of the map`;
    return formatDistance(distance);
  },
};

