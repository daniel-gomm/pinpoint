import { h, api, toast, store } from './util.js';
import { connect, request, rememberPlayer } from './socket.js';
import { immichStatus } from './immich.js';

const MODE_CHOICES = [
  ['location', 'Place', 'Drop a pin where the picture was taken.'],
  ['date', 'Date', 'Pick when it was taken on a timeline.'],
  ['order', 'Order', 'Sort a few pictures from oldest to newest.'],
];
// What a picture needs to be playable in each mode, and how sets count it.
const NEEDS = { location: ['locatedCount', 'location'], date: ['datedCount', 'date'], order: ['datedCount', 'date'] };

export function homeView(root) {
  const savedName = store.get('gg:name') ?? '';

  const joinForm = h('form', { class: 'panel join', onSubmit: join },
    h('h2', {}, 'Join a game'),
    h('p', { class: 'muted' }, 'Ask the host for the four-letter code, or scan the code on their screen.'),
    h('label', {}, 'Game code',
      h('input', { name: 'code', required: true, maxlength: 4, autocomplete: 'off', class: 'code-input', placeholder: 'ABCD' })),
    h('label', {}, 'Your name', h('input', { name: 'name', required: true, maxlength: 24, value: savedName })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Join game'),
  );

  let sets = [];
  const radio = (name, value, checked) => h('input', { type: 'radio', name, value, checked, onChange: update });
  const field = (label, control) => h('label', {}, label, control);
  const setSelect = h('select', { name: 'setId' }, h('option', { value: '' }, 'Loading sets…'));
  const setField = field('Picture set', setSelect);
  /** @type {import('./immich.js').ImmichStatus | null} */
  let immich = null;
  const albumSelect = h('select', { name: 'albumId', onChange: update }, h('option', { value: '' }, 'Whole library'));
  const libraryWarning = h('p', { class: 'hint' },
    'Any picture in the library can come up, including private ones. Pick an album to choose what others see.');
  const partnersText = h('span');
  const partnersBox = h('input', { type: 'checkbox', name: 'partners' });
  const partnersField = h('label', { class: 'check' }, partnersBox, partnersText);
  let partnersShown = false;
  const immichMissing = h('p', { class: 'warn' });
  const immichFields = h('div', {},
    immichMissing,
    h('label', {}, 'Album', albumSelect),
    libraryWarning,
    h('div', { class: 'immich-options' },
      partnersField,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'favorites' }), h('span', {}, 'Favourites only')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'cameraOnly', checked: true }),
        h('span', {}, 'Camera photos only (skips screenshots and saved pictures, whose dates are often wrong)'))),
    h('div', { class: 'row' },
      field('Taken from', h('input', { name: 'from', type: 'date' })),
      field('Taken until', h('input', { name: 'to', type: 'date' }))));
  const precisionField = field('How exact', h('select', { name: 'precision' },
    h('option', { value: 'minute' }, 'Day and time of day'),
    h('option', { value: 'day' }, 'Day'),
    h('option', { value: 'month' }, 'Month'),
    h('option', { value: 'year' }, 'Year')));
  const orderSizeField = field('Pictures per round', h('select', { name: 'orderSize' },
    [3, 4, 5, 6].map((n) => h('option', { value: n, selected: n === 4 }, String(n)))));
  const scaleInput = h('input', { name: 'scale', type: 'number', min: 1, placeholder: 'Automatic' });
  const scaleLabel = h('span');
  const scaleHint = h('p', { class: 'hint' });
  const scaleField = h('div', {}, h('label', {}, scaleLabel, scaleInput), scaleHint);
  const nameLabel = h('span', {}, 'Your name');
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create game');

  const hostForm = h('form', { class: 'panel host', onSubmit: host },
    h('h2', {}, 'Host a game'),
    h('fieldset', { class: 'choices three' },
      h('legend', {}, 'What do players guess?'),
      MODE_CHOICES.map(([value, title, text]) => h('label', { class: 'choice' },
        radio('mode', value, value === 'location'), h('strong', {}, title), h('span', {}, text)))),
    h('fieldset', { class: 'choices three' },
      h('legend', {}, 'Pictures'),
      h('label', { class: 'choice' }, radio('source', 'set', true), h('strong', {}, 'Picture set'), h('span', {}, 'Pictures you prepared.')),
      h('label', { class: 'choice' }, radio('source', 'immich', false), h('strong', {}, 'Immich'),
        h('span', {}, 'Random pictures from your photo library.')),
      h('label', { class: 'choice' }, radio('source', 'players', false), h('strong', {}, 'Players bring them'),
        h('span', {}, 'Everyone adds their own in the lobby.'))),
    setField,
    immichFields,
    precisionField,
    orderSizeField,
    h('div', { class: 'row' },
      field('Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 100, value: 5 })),
      field('Seconds per round', h('input', { name: 'roundSeconds', type: 'number', min: 10, max: 600, step: 5, value: 60 }))),
    h('details', {},
      h('summary', {}, 'Scoring'),
      h('fieldset', { class: 'choices' },
        h('label', { class: 'choice' }, radio('scoring', 'placement', true), h('strong', {}, 'Placement'),
          h('span', {}, 'A point for every player you beat each round. One bad round costs little.')),
        h('label', { class: 'choice' }, radio('scoring', 'points', false), h('strong', {}, 'Points'),
          h('span', {}, 'Up to 5,000 per round, by how close you were.'))),
      scaleField),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'presenter', onChange: update }),
      h('span', {}, h('strong', {}, 'Show on a shared screen. '), 'This device presents the game (photo, timer, results) and doesn’t play.')),
    h('label', {}, nameLabel, h('input', { name: 'name', required: true, maxlength: 24, value: savedName })),
    submit,
  );

  root.append(
    h('section', { class: 'home' },
      h('div', { class: 'home-intro' },
        h('h1', {}, 'Where was this picture taken? When?'),
        h('p', {}, 'Upload your own photos, mark where and when each was taken, and let friends guess the place on a map or the moment on a timeline. Closest guess wins the round.'),
      ),
      h('div', { class: 'home-panels' }, joinForm, hostForm),
    ),
  );

  const values = () => Object.fromEntries(new FormData(hostForm));

  function update() {
    const v = values();
    const [countKey, needed] = NEEDS[String(v.mode)];
    const fromSet = v.source === 'set';
    const fromImmich = v.source === 'immich';
    setField.hidden = !fromSet;
    immichFields.hidden = !fromImmich;
    libraryWarning.hidden = Boolean(v.albumId);
    // An album already holds everything shared in it.
    partnersField.hidden = !partnersShown || Boolean(v.albumId);
    if (fromImmich) loadImmich();
    precisionField.hidden = v.mode !== 'date';
    orderSizeField.hidden = v.mode !== 'order';
    scaleField.hidden = v.mode === 'order';
    nameLabel.textContent = v.presenter ? 'Name shown as host' : 'Your name';
    const date = v.mode === 'date';
    scaleLabel.textContent = date ? 'Time span in days' : 'Map size in km';
    scaleHint.textContent = date
      ? 'Points only: a guess one tenth of the time span off earns about a third of the 5,000 points. Automatic uses the time between the oldest and newest picture, ignoring outliers.'
      : 'Points only: a guess one tenth of the map size away earns about a third of the 5,000 points. Automatic uses the distance between the farthest pictures, ignoring outliers.';

    const playable = sets.filter((s) => s[countKey] > 0);
    const selected = setSelect.value;
    setSelect.replaceChildren(...(playable.length
      ? playable.map((s) => h('option', { value: s.id, selected: s.id === selected },
          `${s.name} (${s[countKey]} with a ${needed})`))
      : [h('option', { value: '' }, `No sets with ${needed}s yet`)]));
    submit.disabled = (fromSet && !playable.length) || (fromImmich && (!immich?.connected || Boolean(immich.error)));
  }

  let immichLoading = null;
  function loadImmich() {
    immichLoading ??= (async () => {
      immichMissing.textContent = 'Checking Immich…';
      try {
        immich = await immichStatus();
        if (!immich.connected) {
          immichMissing.replaceChildren('Immich is not connected yet. ', h('a', { href: '#/sets' }, 'Connect it on the Picture sets page.'));
          return;
        }
        if (immich.error) {
          immichMissing.textContent = immich.error;
          return;
        }
        immichMissing.textContent = '';
        const albums = await api('/api/immich/albums');
        albumSelect.append(...albums.map((a) => h('option', { value: a.id }, `${a.name} (${a.count})`)));
        const partners = await api('/api/immich/partners');
        if (partners === null) {
          partnersBox.disabled = true;
          partnersText.textContent = 'Partner photos: add the partner.read and timeline.read permissions to the API key to include them';
          partnersShown = true;
        } else if (partners.length) {
          partnersText.textContent = `Include photos ${partners.map((p) => p.name).join(', ')} share${partners.length === 1 ? 's' : ''} with you`;
          partnersShown = true;
        }
      } catch (err) {
        immichMissing.textContent = err.message;
      } finally {
        update();
      }
    })();
  }

  api('/api/sets').then((result) => {
    sets = result;
    update();
  }).catch((err) => toast(err.message, 'error'));
  update();

  async function join(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    store.set('gg:name', String(data.name).trim());
    connect();
    const res = await request('game:join', { code: String(data.code).trim().toUpperCase(), name: data.name });
    if (res.error) return toast(res.error, 'error');
    rememberPlayer(res.code, res.playerId);
    location.hash = `#/game/${res.code}`;
  }

  async function host(event) {
    event.preventDefault();
    const v = values();
    store.set('gg:name', String(v.name).trim());
    connect();
    submit.disabled = true;
    submit.textContent = v.source === 'immich' ? 'Picking pictures…' : 'Creating…';
    const res = await request('game:create', {
      setId: v.setId,
      name: v.name,
      settings: {
        mode: v.mode,
        source: v.source,
        scoring: v.scoring,
        rounds: Number(v.rounds),
        roundSeconds: Number(v.roundSeconds),
        precision: v.precision,
        orderSize: Number(v.orderSize),
        presenter: Boolean(v.presenter),
        immich: v.source === 'immich'
          ? { albumId: v.albumId || null, favorites: Boolean(v.favorites), cameraOnly: Boolean(v.cameraOnly), partners: Boolean(v.partners) && !v.albumId, from: v.from || null, to: v.to || null }
          : undefined,
        // the server takes km for location and hours for date
        scale: v.scale ? Number(v.scale) * (v.mode === 'date' ? 24 : 1) : undefined,
      },
    });
    submit.textContent = 'Create game';
    update();
    if (res.error) return toast(res.error, 'error');
    rememberPlayer(res.code, res.playerId);
    location.hash = `#/game/${res.code}`;
  }
}
