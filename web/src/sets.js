import exifr from 'exifr';
import { h, api, toast } from './util.js';
import { createMap, pinIcon, L } from './map.js';

const MAX_EDGE = 2400;

export function setListView(root) {
  const list = h('div', { class: 'set-grid' });
  const form = h('form', { class: 'new-set', onSubmit: create },
    h('label', { class: 'grow' }, 'New set name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'Summer road trip' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Create set'),
  );
  root.append(h('section', { class: 'page' },
    h('h1', {}, 'Picture sets'),
    h('p', { class: 'muted' }, 'A set is a collection of photos with the place each was taken. Games draw their rounds from one set.'),
    form, list));

  api('/api/sets').then((sets) => {
    if (!sets.length) {
      list.append(h('p', { class: 'empty' }, 'No sets yet. Name your first one above, then add pictures to it.'));
      return;
    }
    list.append(...sets.map((s) => h('a', { class: 'set-card', href: `#/sets/${s.id}` },
      s.cover ? h('img', { src: s.cover, alt: '', loading: 'lazy' }) : h('div', { class: 'cover-empty' }),
      h('strong', {}, s.name),
      h('span', { class: 'muted' }, `${s.imageCount} pictures`,
        s.imageCount > s.locatedCount ? `, ${s.imageCount - s.locatedCount} without a location` : '',
        s.imageCount > s.datedCount ? `, ${s.imageCount - s.datedCount} without a date` : ''),
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
}

async function prepareUpload(file) {
  let gps = null;
  let takenAt = null;
  try {
    gps = await exifr.gps(file);
  } catch { /* no EXIF */ }
  try {
    // Raw EXIF strings ("2023:07:14 15:30:12") are the camera's wall-clock time, which is what we store.
    const exif = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
    const raw = exif?.DateTimeOriginal ?? exif?.CreateDate;
    const m = typeof raw === 'string' && raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
    if (m && m[1] !== '0000') takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  } catch { /* no EXIF */ }
  // Re-encode to strip EXIF (players could otherwise read the GPS tag) and shrink huge photos.
  let blob = file;
  if (file.type !== 'image/gif') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const ratio = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * ratio);
    canvas.height = Math.round(bitmap.height * ratio);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  }
  const form = new FormData();
  form.append('image', blob, file.name.replace(/\.[^.]+$/, '') + (blob === file ? '' : '.jpg'));
  if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
    form.append('lat', gps.latitude);
    form.append('lng', gps.longitude);
  }
  if (takenAt) form.append('takenAt', takenAt);
  return form;
}

export function setEditorView(root, setId) {
  let set = null;
  let selectedId = null;
  const markers = new Map();

  const title = h('input', { class: 'title-input', 'aria-label': 'Set name', maxlength: 80, onChange: rename });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onChange: (e) => upload(e.target.files) });
  const dropzone = h('button', { class: 'dropzone', type: 'button', onClick: () => fileInput.click() },
    h('strong', {}, 'Add pictures'),
    h('span', {}, 'Drop photos here or click to choose. Place and date are read from the photo’s camera data when it has them.'));
  const thumbs = h('ul', { class: 'thumbs' });
  const status = h('p', { class: 'muted set-status' });
  const mapEl = h('div', { class: 'map editor-map' });
  const detail = h('div', { class: 'detail' });
  const searchInput = h('input', { type: 'search', placeholder: 'Jump to a place, e.g. Lisbon', 'aria-label': 'Search for a place' });
  const search = h('form', { class: 'map-search', onSubmit: searchPlace }, searchInput, h('button', { class: 'btn', type: 'submit' }, 'Search'));

  root.append(h('section', { class: 'editor' },
    h('div', { class: 'editor-head' },
      h('a', { href: '#/sets', class: 'back' }, 'All sets'),
      title,
      h('button', { class: 'btn danger', type: 'button', onClick: removeSet }, 'Delete set')),
    h('div', { class: 'editor-body' },
      h('aside', { class: 'editor-side' }, dropzone, fileInput, status, thumbs),
      h('div', { class: 'editor-main' }, detail, search, mapEl)),
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

  const map = createMap(mapEl);
  map.on('click', (e) => {
    if (!selectedId) return toast('Select a picture first, then click where it was taken.');
    const { lat, lng } = e.latlng.wrap();
    saveLocation(selectedId, lat, lng);
  });

  load();

  async function load() {
    try {
      set = await api(`/api/sets/${setId}`);
    } catch (err) {
      root.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Set not found'),
        h('p', {}, 'It may have been deleted. ', h('a', { href: '#/sets' }, 'Back to all sets'))));
      return;
    }
    title.value = set.name;
    selectedId = set.images[0]?.id ?? null;
    renderAll();
    fitAll();
  }

  const fileUrl = (img) => `/api/sets/${set.id}/files/${img.file}`;
  const located = (img) => img.lat !== null && img.lng !== null;
  const dated = (img) => Boolean(img.takenAt);

  function renderAll() {
    renderThumbs();
    renderDetail();
    renderMarkers();
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
        class: `thumb${img.id === selectedId ? ' selected' : ''}${located(img) && dated(img) ? '' : ' unplaced'}`,
        'aria-pressed': img.id === selectedId ? 'true' : 'false',
        onClick: () => select(img.id),
      },
      h('img', { src: fileUrl(img), alt: img.caption || 'Picture', loading: 'lazy' }),
      h('span', { class: 'badges' },
        located(img) ? null : h('span', { class: 'badge' }, 'No place'),
        dated(img) ? null : h('span', { class: 'badge' }, 'No date'))),
    )));
  }

  function renderDetail() {
    const img = set.images.find((i) => i.id === selectedId);
    if (!img) {
      detail.replaceChildren(h('p', { class: 'empty' },
        set.images.length ? 'Select a picture to place it on the map.' : 'This set is empty. Add some pictures to get started.'));
      return;
    }
    const caption = h('input', {
      value: img.caption, maxlength: 200, placeholder: 'Shown to players after the round',
      onChange: async (e) => {
        try {
          Object.assign(img, await api(`/api/sets/${set.id}/images/${img.id}`, { method: 'PATCH', body: { caption: e.target.value } }));
          toast('Caption saved');
        } catch (err) { toast(err.message, 'error'); }
      },
    });
    const takenAt = h('input', {
      type: 'datetime-local', value: img.takenAt ?? '',
      onChange: async (e) => {
        try {
          const value = e.target.value ? e.target.value.slice(0, 16) : null;
          Object.assign(img, await api(`/api/sets/${set.id}/images/${img.id}`, { method: 'PATCH', body: { takenAt: value } }));
          renderThumbs();
          toast(value ? 'Date saved' : 'Date removed');
        } catch (err) { toast(err.message, 'error'); }
      },
    });
    detail.replaceChildren(
      h('img', { class: 'detail-img', src: fileUrl(img), alt: img.caption || 'Selected picture' }),
      h('div', { class: 'detail-fields' },
        h('div', { class: 'row' },
          h('label', {}, 'Caption', caption),
          h('label', {}, 'Taken on', takenAt)),
        h('p', { class: located(img) ? 'muted' : 'warn' },
          located(img)
            ? `Placed at ${img.lat.toFixed(5)}, ${img.lng.toFixed(5)}. Click the map or drag the pin to move it.`
            : 'Click the map where this picture was taken.'),
        h('button', { class: 'btn danger subtle', type: 'button', onClick: () => removeImage(img) }, 'Remove picture')),
    );
  }

  function renderMarkers() {
    for (const m of markers.values()) m.remove();
    markers.clear();
    for (const img of set.images.filter(located)) {
      const selected = img.id === selectedId;
      const marker = L.marker([img.lat, img.lng], {
        icon: pinIcon(selected ? 'var(--pin)' : 'var(--ink-soft)'),
        draggable: selected,
        zIndexOffset: selected ? 1000 : 0,
        title: img.caption || 'Picture',
      }).addTo(map);
      marker.on('click', () => select(img.id));
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng().wrap();
        saveLocation(img.id, lat, lng);
      });
      markers.set(img.id, marker);
    }
  }

  function fitAll() {
    const pts = set.images.filter(located).map((i) => [i.lat, i.lng]);
    if (pts.length === 1) map.setView(pts[0], 12);
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
  }

  function select(id) {
    selectedId = id;
    renderAll();
    const img = set.images.find((i) => i.id === id);
    if (img && located(img) && !map.getBounds().contains([img.lat, img.lng])) map.panTo([img.lat, img.lng]);
  }

  async function saveLocation(id, lat, lng) {
    try {
      const updated = await api(`/api/sets/${set.id}/images/${id}`, { method: 'PATCH', body: { lat, lng } });
      Object.assign(set.images.find((i) => i.id === id), updated);
      // Jump to the next picture that still needs a location.
      const next = set.images.find((i) => !located(i));
      if (next && selectedId === id) selectedId = next.id;
      renderAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function upload(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return toast('Choose image files (JPEG, PNG, WebP).', 'error');
    let done = 0;
    let failed = 0;
    for (const file of images) {
      status.textContent = `Uploading ${done + 1} of ${images.length}…`;
      try {
        const form = await prepareUpload(file);
        const image = await api(`/api/sets/${set.id}/images`, { method: 'POST', form });
        set.images.push(image);
        selectedId ??= image.id;
        done++;
        renderThumbs();
      } catch (err) {
        failed++;
        toast(`${file.name}: ${err.message || 'could not be read. HEIC photos need converting to JPEG first.'}`, 'error');
      }
    }
    const firstMissing = set.images.find((i) => !located(i));
    if (firstMissing) selectedId = firstMissing.id;
    renderAll();
    fitAll();
    toast(`Added ${done} picture${done === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
    fileInput.value = '';
  }

  async function removeImage(img) {
    if (!confirm('Remove this picture from the set?')) return;
    try {
      await api(`/api/sets/${set.id}/images/${img.id}`, { method: 'DELETE' });
      set.images = set.images.filter((i) => i !== img);
      selectedId = set.images[0]?.id ?? null;
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

  return () => map.remove();
}
