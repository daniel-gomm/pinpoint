import { h, api, toast, IMAGE_ACCEPT, isImageFile } from './util.js';
import { uploadPhoto } from './upload.js';
import { createMap, pinIcon, L } from './map.js';

/**
 * Lobby panel for games where players bring their own pictures. Each player only ever sees
 * their own pictures here; the server checks this with their player id.
 * @param {{code: string, playerId: string, mode: string}} opts
 */
export function contributePanel({ code, playerId, mode }) {
  const needsPlace = mode === 'location';
  const headers = { 'X-Player-Id': playerId };
  const base = `/api/games/${code}/photos`;
  let photos = [];
  let editing = null;
  let map = null;

  const list = h('ul', { class: 'my-photos' });
  const status = h('p', { class: 'muted' });
  const fileInput = h('input', { type: 'file', accept: IMAGE_ACCEPT, multiple: true, hidden: true, onChange: (e) => add(e.target.files) });
  const editor = h('div', { class: 'photo-editor', hidden: true });
  const panel = h('section', { class: 'panel contribute' },
    h('h2', {}, 'Your pictures'),
    h('p', { class: 'muted' }, needsPlace
      ? 'Add pictures and mark where each was taken. You sit out the rounds with your own pictures.'
      : 'Add pictures and check when each was taken. You sit out the rounds with your own pictures.'),
    h('button', { class: 'btn', type: 'button', onClick: () => fileInput.click() }, 'Add pictures'),
    fileInput, status, list, editor);

  const ready = (p) => (needsPlace ? p.lat !== null && p.lng !== null : Boolean(p.takenAt));

  async function load() {
    try {
      photos = await api(base, { headers });
      render();
    } catch (err) { toast(err.message, 'error'); }
  }

  function render() {
    const missing = photos.filter((p) => !ready(p)).length;
    status.textContent = photos.length
      ? `${photos.length} added${missing ? `, ${missing} still need ${needsPlace ? 'a place' : 'a date'}` : ', all ready'}`
      : '';
    list.replaceChildren(...photos.map((p) => h('li', {},
      h('button', { type: 'button', class: `thumb${ready(p) ? '' : ' unplaced'}${editing === p.id ? ' selected' : ''}`, onClick: () => edit(p.id) },
        h('img', { src: `${base}/${p.id}/file?player=${encodeURIComponent(playerId)}`, alt: p.caption || 'Your picture', loading: 'lazy' }),
        ready(p) ? null : h('span', { class: 'badges' }, h('span', { class: 'badge' }, needsPlace ? 'No place' : 'No date'))))));
  }

  async function add(files) {
    const images = [...files].filter(isImageFile);
    for (const [i, file] of images.entries()) {
      status.textContent = `Uploading ${i + 1} of ${images.length}…`;
      try {
        photos.push(await uploadPhoto(base, file, { headers }));
      } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
    }
    fileInput.value = '';
    render();
    const next = photos.find((p) => !ready(p));
    if (next) edit(next.id);
  }

  async function save(id, patch) {
    try {
      const updated = await api(`${base}/${id}`, { method: 'PATCH', body: patch, headers });
      Object.assign(photos.find((p) => p.id === id), updated);
      render();
      return updated;
    } catch (err) { toast(err.message, 'error'); }
  }

  function edit(id) {
    editing = id;
    map?.remove();
    map = null;
    const p = photos.find((x) => x.id === id);
    if (!p) { editor.hidden = true; return; }
    const mapEl = h('div', { class: 'map contribute-map' });
    editor.hidden = false;
    editor.replaceChildren(...[
      h('img', { class: 'detail-img', src: `${base}/${p.id}/file?player=${encodeURIComponent(playerId)}`, alt: '' }),
      h('div', { class: 'row' },
        h('label', {}, 'Caption', h('input', { value: p.caption, maxlength: 200, onChange: (e) => save(id, { caption: e.target.value }) })),
        h('label', {}, 'Taken on', h('input', { type: 'datetime-local', value: p.takenAt ?? '', onChange: (e) => save(id, { takenAt: e.target.value ? e.target.value.slice(0, 16) : null }) }))),
      needsPlace ? h('p', { class: ready(p) ? 'muted' : 'warn' }, ready(p) ? 'Click the map to move the pin.' : 'Click the map where this picture was taken.') : null,
      needsPlace ? mapEl : null,
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn danger subtle', onClick: () => remove(id) }, 'Remove picture'),
        h('button', { type: 'button', class: 'btn', onClick: () => { editing = null; editor.hidden = true; map?.remove(); map = null; render(); } }, 'Done')),
    ].filter(Boolean));
    render();
    if (!needsPlace) return;
    map = createMap(mapEl);
    let marker = null;
    const place = (lat, lng) => {
      marker ??= L.marker([lat, lng], { icon: pinIcon() }).addTo(map);
      marker.setLatLng([lat, lng]);
    };
    if (ready(p)) {
      place(p.lat, p.lng);
      map.setView([p.lat, p.lng], 10);
    }
    map.on('click', async (e) => {
      const { lat, lng } = e.latlng.wrap();
      place(lat, lng);
      await save(id, { lat, lng });
    });
  }

  async function remove(id) {
    try {
      await api(`${base}/${id}`, { method: 'DELETE', headers });
      photos = photos.filter((p) => p.id !== id);
      editing = null;
      editor.hidden = true;
      map?.remove();
      map = null;
      render();
    } catch (err) { toast(err.message, 'error'); }
  }

  load();
  return { el: panel, destroy: () => map?.remove() };
}
