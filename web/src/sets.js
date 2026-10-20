import { h, api, toast, IMAGE_ACCEPT, isImageFile } from './util.js';
import { createMap, pinIcon, L } from './map.js';
import { uploadPhoto } from './upload.js';

export function setListView(root) {
  const list = h('div', { class: 'set-grid' });
  const form = h('form', { class: 'new-set', onSubmit: create },
    h('label', { class: 'grow' }, 'New set name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'Summer road trip' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Create set'));
  const importInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onChange: (e) => importSet(e.target.files[0]) });
  root.append(h('section', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, 'Picture sets'),
      h('button', { class: 'btn', type: 'button', onClick: () => importInput.click() }, 'Import a set'), importInput),
    h('p', { class: 'muted' }, 'A set is a collection of photos with where and when each was taken. Games draw their rounds from one set.'),
    form, list));

  api('/api/sets').then((sets) => {
    if (!sets.length) {
      list.append(h('p', { class: 'empty' }, 'No sets yet. Name your first one above, or import a set someone exported.'));
      return;
    }
    list.append(...sets.map((s) => h('a', { class: 'set-card', href: `#/sets/${s.id}` },
      s.cover ? h('img', { src: s.cover, alt: '', loading: 'lazy' }) : h('div', { class: 'cover-empty' }),
      h('strong', {}, s.name),
      h('span', { class: 'muted' }, `${s.imageCount} pictures`,
        s.imageCount > s.locatedCount ? `, ${s.imageCount - s.locatedCount} without a location` : '',
        s.imageCount > s.datedCount ? `, ${s.imageCount - s.datedCount} without a date` : ''),
      s.customMap ? h('span', { class: 'tag' }, 'Custom map') : null,
    )));
  }).catch((err) => toast(err.message, 'error'));

  async function create(event) {
    event.preventDefault();
    try {
      const set = await api('/api/sets', { method: 'POST', body: { name: new FormData(form).get('name') } });
      location.hash = `#/sets/${set.id}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function importSet(file) {
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    toast('Importing…');
    try {
      const set = await api('/api/sets/import', { method: 'POST', form: body });
      toast(`Imported “${set.name}” with ${set.images.length} pictures`);
      location.hash = `#/sets/${set.id}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}

export function setEditorView(root, setId) {
  let set = null;
  /** @type {Set<string>} */
  let selected = new Set();
  let anchor = null;
  let map = null;
  const markers = new Map();

  const title = h('input', { class: 'title-input', 'aria-label': 'Set name', maxlength: 80, onChange: rename });
  const exportLink = h('a', { class: 'btn', href: `/api/sets/${setId}/export`, download: true }, 'Export');
  const fileInput = h('input', { type: 'file', accept: IMAGE_ACCEPT, multiple: true, hidden: true, onChange: (e) => upload(e.target.files) });
  const dropzone = h('button', { class: 'dropzone', type: 'button', onClick: () => fileInput.click() },
    h('strong', {}, 'Add pictures'),
    h('span', {}, 'Drop photos here or click to choose (JPEG, PNG, HEIC). Place and date are read from the camera data when available.'));
  const thumbs = h('ul', { class: 'thumbs' });
  const status = h('p', { class: 'muted set-status' });
  const mapEl = h('div', { class: 'map editor-map' });
  const mapBar = h('div', { class: 'map-bar' });
  const detail = h('div', { class: 'detail' });
  const searchInput = h('input', { type: 'search', placeholder: 'Jump to a place, e.g. Lisbon', 'aria-label': 'Search for a place' });
  const search = h('form', { class: 'map-search', onSubmit: searchPlace }, searchInput, h('button', { class: 'btn', type: 'submit' }, 'Search'));
  const mapFileInput = h('input', { type: 'file', accept: IMAGE_ACCEPT, hidden: true, onChange: (e) => setCustomMap(e.target.files[0]) });

  root.append(h('section', { class: 'editor' },
    h('div', { class: 'editor-head' },
      h('a', { href: '#/sets', class: 'back' }, 'All sets'),
      title,
      exportLink,
      h('button', { class: 'btn danger', type: 'button', onClick: removeSet }, 'Delete set')),
    h('div', { class: 'editor-body' },
      h('aside', { class: 'editor-side' }, dropzone, fileInput, status,
        h('p', { class: 'hint' }, 'Ctrl- or Shift-click to select several pictures and edit them together.'), thumbs),
      h('div', { class: 'editor-main' }, detail, mapBar, mapFileInput, search, mapEl)),
  ));

  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  }
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    upload(e.dataTransfer.files);
  });

  load();

  async function load() {
    try {
      set = await api(`/api/sets/${setId}`);
    } catch {
      root.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Set not found'),
        h('p', {}, 'It may have been deleted. ', h('a', { href: '#/sets' }, 'Back to all sets'))));
      return;
    }
    title.value = set.name;
    if (set.images[0]) selected = new Set([set.images[0].id]);
    buildMap();
    renderAll();
    fitAll();
  }

  const fileUrl = (file) => `/api/sets/${set.id}/files/${file}`;
  const located = (img) => img.lat !== null && img.lng !== null;
  const dated = (img) => Boolean(img.takenAt);
  const selectedImages = () => set.images.filter((i) => selected.has(i.id));

  function buildMap() {
    map?.remove();
    markers.clear();
    const custom = set.map ? { url: fileUrl(set.map.file), width: set.map.width, height: set.map.height } : null;
    map = createMap(mapEl, { custom });
    search.hidden = Boolean(custom);
    map.on('click', (e) => {
      if (!selected.size) return toast('Select a picture first, then click where it was taken.');
      const { lat, lng } = custom ? e.latlng : e.latlng.wrap();
      saveLocation([...selected], lat, lng);
    });
  }

  function renderAll() {
    renderThumbs();
    renderDetail();
    renderMarkers();
    renderMapBar();
  }

  function renderThumbs() {
    const noPlace = set.images.filter((i) => !located(i)).length;
    const noDate = set.images.filter((i) => !dated(i)).length;
    const gaps = [noPlace && `${noPlace} without a location`, noDate && `${noDate} without a date`].filter(Boolean);
    status.textContent = set.images.length
      ? `${set.images.length} pictures${gaps.length ? `, ${gaps.join(', ')}` : ', all with location and date'}`
      : '';
    thumbs.replaceChildren(...set.images.map((img) => h('li', {},
      h('button', {
        type: 'button',
        class: `thumb${selected.has(img.id) ? ' selected' : ''}${located(img) && dated(img) ? '' : ' unplaced'}`,
        'aria-pressed': selected.has(img.id) ? 'true' : 'false',
        onClick: (e) => select(img.id, e),
      },
      h('img', { src: fileUrl(img.file), alt: img.caption || 'Picture', loading: 'lazy' }),
      h('span', { class: 'badges' },
        located(img) ? null : h('span', { class: 'badge' }, 'No place'),
        dated(img) ? null : h('span', { class: 'badge' }, 'No date'))),
    )));
  }

  async function patch(ids, body, message) {
    try {
      const updated = await api(`/api/sets/${set.id}/images`, { method: 'PATCH', body: { ids, ...body } });
      for (const u of updated) Object.assign(set.images.find((i) => i.id === u.id), u);
      renderAll();
      if (message) toast(message);
      return updated;
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderDetail() {
    const imgs = selectedImages();
    if (!imgs.length) {
      detail.replaceChildren(h('p', { class: 'empty' },
        set.images.length ? 'Select a picture to place it on the map.' : 'This set is empty. Add some pictures to get started.'));
      return;
    }
    const ids = imgs.map((i) => i.id);
    if (imgs.length > 1) {
      const takenAt = h('input', { type: 'datetime-local', 'aria-label': 'Taken on' });
      detail.replaceChildren(
        h('div', { class: 'bulk-thumbs' }, imgs.slice(0, 6).map((i) => h('img', { src: fileUrl(i.file), alt: '' }))),
        h('div', { class: 'detail-fields' },
          h('h2', {}, `${imgs.length} pictures selected`),
          h('p', { class: 'muted' }, 'Click the map to place all of them there.'),
          h('div', { class: 'inline-form' },
            h('label', {}, 'Taken on', takenAt),
            h('button', { class: 'btn', type: 'button', onClick: () => takenAt.value
              ? patch(ids, { takenAt: takenAt.value.slice(0, 16) }, `Date set for ${ids.length} pictures`)
              : toast('Pick a date and time first.') }, 'Set date for all')),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn subtle', type: 'button', onClick: () => patch(ids, { lat: null, lng: null }, 'Locations cleared') }, 'Clear locations'),
            h('button', { class: 'btn subtle', type: 'button', onClick: () => patch(ids, { takenAt: null }, 'Dates cleared') }, 'Clear dates'),
            h('button', { class: 'btn danger subtle', type: 'button', onClick: () => removeImages(ids) }, `Remove ${ids.length} pictures`),
            h('button', { class: 'link', type: 'button', onClick: () => { selected = new Set(); renderAll(); } }, 'Clear selection'))),
      );
      return;
    }
    const [img] = imgs;
    const caption = h('input', {
      value: img.caption, maxlength: 200, placeholder: 'Shown to players after the round',
      onChange: (e) => patch(ids, { caption: e.target.value }, 'Caption saved'),
    });
    const takenAt = h('input', {
      type: 'datetime-local', value: img.takenAt ?? '',
      onChange: (e) => patch(ids, { takenAt: e.target.value ? e.target.value.slice(0, 16) : null }, e.target.value ? 'Date saved' : 'Date removed'),
    });
    detail.replaceChildren(
      h('img', { class: 'detail-img', src: fileUrl(img.file), alt: img.caption || 'Selected picture' }),
      h('div', { class: 'detail-fields' },
        h('div', { class: 'row' }, h('label', {}, 'Caption', caption), h('label', {}, 'Taken on', takenAt)),
        h('p', { class: located(img) ? 'muted' : 'warn' },
          located(img)
            ? set.map
              ? 'Placed on the map. Click the map or drag the pin to move it.'
              : `Placed at ${img.lat.toFixed(5)}, ${img.lng.toFixed(5)}. Click the map or drag the pin to move it.`
            : 'Click the map where this picture was taken.'),
        h('button', { class: 'btn danger subtle', type: 'button', onClick: () => removeImages(ids) }, 'Remove picture')),
    );
  }

  function renderMapBar() {
    const choose = h('button', { class: 'btn subtle', type: 'button', onClick: () => mapFileInput.click() },
      set.map ? 'Replace map image' : 'Use your own map image');
    if (!set.map) {
      mapBar.replaceChildren(h('span', {}, h('strong', {}, 'World map. '), 'A floor plan or campus map works too.'), choose);
      return;
    }
    const meters = h('input', { type: 'number', min: 1, step: 'any', value: set.map.metersWide ?? '', placeholder: 'optional', 'aria-label': 'Map width in meters',
      onChange: async (e) => {
        try {
          set = { ...set, ...(await api(`/api/sets/${set.id}`, { method: 'PATCH', body: { metersWide: e.target.value || null } })) };
          toast(e.target.value ? 'Map width saved' : 'Map width removed');
        } catch (err) { toast(err.message, 'error'); }
      } });
    mapBar.replaceChildren(
      h('span', {}, h('strong', {}, 'Your map image. '), 'Real width in meters ', meters, ' lets players see distances in meters.'),
      choose,
      h('button', { class: 'btn subtle', type: 'button', onClick: () => setCustomMap(null) }, 'Back to world map'));
  }

  function renderMarkers() {
    for (const m of markers.values()) m.remove();
    markers.clear();
    const single = selected.size === 1;
    for (const img of set.images.filter(located)) {
      const isSel = selected.has(img.id);
      const marker = L.marker([img.lat, img.lng], {
        icon: pinIcon(isSel ? 'var(--pin)' : 'var(--ink-soft)'),
        draggable: isSel && single,
        zIndexOffset: isSel ? 1000 : 0,
        title: img.caption || 'Picture',
      }).addTo(map);
      marker.on('click', (e) => select(img.id, e.originalEvent));
      marker.on('dragend', () => {
        const { lat, lng } = set.map ? marker.getLatLng() : marker.getLatLng().wrap();
        saveLocation([img.id], lat, lng);
      });
      markers.set(img.id, marker);
    }
  }

  function fitAll() {
    if (set.map) return;
    const pts = set.images.filter(located).map((i) => [i.lat, i.lng]);
    if (pts.length === 1) map.setView(pts[0], 12, { animate: false });
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14, animate: false });
  }

  /** Click selects one; Ctrl/Cmd toggles; Shift selects a range from the last clicked picture. */
  function select(id, event) {
    const ids = set.images.map((i) => i.id);
    if (event?.shiftKey && anchor) {
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      selected = new Set(ids.slice(a, b + 1));
    } else if (event?.ctrlKey || event?.metaKey) {
      selected = new Set(selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = id;
    } else {
      selected = new Set([id]);
      anchor = id;
    }
    renderAll();
    const img = set.images.find((i) => i.id === id);
    if (img && located(img) && !map.getBounds().contains([img.lat, img.lng])) map.panTo([img.lat, img.lng]);
  }

  async function saveLocation(ids, lat, lng) {
    const updated = await patch(ids, { lat, lng });
    if (!updated) return;
    // With one picture selected, jump to the next one that still needs a location.
    if (ids.length === 1) {
      const next = set.images.find((i) => !located(i));
      if (next) {
        selected = new Set([next.id]);
        anchor = next.id;
        renderAll();
      }
    }
  }

  async function upload(files) {
    const images = [...files].filter(isImageFile);
    if (!images.length) return toast('Choose image files (JPEG, PNG, HEIC, WebP).', 'error');
    let done = 0;
    let failed = 0;
    for (const file of images) {
      status.textContent = `Uploading ${done + failed + 1} of ${images.length}…`;
      try {
        // GPS positions mean nothing on a custom map image.
        const image = await uploadPhoto(`/api/sets/${set.id}/images`, file, { withLocation: !set.map });
        set.images.push(image);
        done++;
        renderThumbs();
      } catch (err) {
        failed++;
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    const firstMissing = set.images.find((i) => !located(i));
    if (firstMissing) selected = new Set([firstMissing.id]);
    else if (!selected.size && set.images[0]) selected = new Set([set.images[0].id]);
    renderAll();
    fitAll();
    toast(`Added ${done} picture${done === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
    fileInput.value = '';
  }

  async function setCustomMap(file) {
    const placed = set.images.filter(located).length;
    if (placed && !confirm(`Switching the map clears the location of all ${placed} placed pictures. Continue?`)) {
      mapFileInput.value = '';
      return;
    }
    try {
      if (file) {
        const body = new FormData();
        body.append('image', file);
        set = await api(`/api/sets/${set.id}/map`, { method: 'PUT', form: body });
      } else {
        set = await api(`/api/sets/${set.id}/map`, { method: 'DELETE' });
      }
      buildMap();
      renderAll();
      toast(file ? 'Map image set. Click it to place your pictures.' : 'Back on the world map');
    } catch (err) { toast(err.message, 'error'); }
    mapFileInput.value = '';
  }

  async function removeImages(ids) {
    if (!confirm(ids.length === 1 ? 'Remove this picture from the set?' : `Remove these ${ids.length} pictures from the set?`)) return;
    try {
      await api(`/api/sets/${set.id}/images/delete`, { method: 'POST', body: { ids } });
      set.images = set.images.filter((i) => !ids.includes(i.id));
      selected = new Set(set.images[0] ? [set.images[0].id] : []);
      renderAll();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function rename() {
    try {
      set = { ...set, ...(await api(`/api/sets/${set.id}`, { method: 'PATCH', body: { name: title.value } })) };
      toast('Name saved');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function removeSet() {
    if (!confirm(`Delete “${set.name}” and all its pictures? This cannot be undone.`)) return;
    try {
      await api(`/api/sets/${set.id}`, { method: 'DELETE' });
      location.hash = '#/sets';
    } catch (err) { toast(err.message, 'error'); }
  }

  async function searchPlace(event) {
    event.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const [hit] = await res.json();
      if (!hit) return toast(`No place found for “${q}”.`);
      const [s, n, w, e] = hit.boundingbox.map(Number);
      map.fitBounds([[s, w], [n, e]], { maxZoom: 16 });
    } catch {
      toast('Place search is unavailable right now. Pan the map instead.', 'error');
    }
  }

  return () => map?.remove();
}
