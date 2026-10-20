import { h, api, toast, store, formatPoints, formatScore, ordinal, playerColor, qrSvg, lightbox } from './util.js';
import { connect, request, rememberPlayer, rememberedPlayer, forgetPlayer } from './socket.js';
import { MODES } from './modes/index.js';
import { contributePanel } from './contribute.js';

/** @typedef {import('../../shared/protocol.js').Snapshot} Snapshot */

const URGENT_SECONDS = 15;
const isLocalhost = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const PRECISION_LABEL = { minute: 'to the quarter hour', day: 'to the day', month: 'to the month', year: 'to the year' };

/** Origin other players should use. Falls back to the current origin unless that is localhost. */
async function inviteOrigin() {
  try {
    const { publicUrl, lanAddresses } = await api('/api/info');
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    if (!isLocalhost()) return location.origin;
    if (lanAddresses[0]) return `${location.protocol}//${lanAddresses[0]}${location.port ? `:${location.port}` : ''}`;
  } catch { /* keep the current origin */ }
  return isLocalhost() ? null : location.origin;
}

export function gameView(root, codeParam) {
  const code = codeParam.toUpperCase();
  const socket = connect();
  /** @type {Snapshot} */
  let state = null;
  let layoutKey = null;
  let clockOffset = 0;
  let teardown = [];
  let ui = {};

  const mode = () => MODES[state.settings.mode];
  const me = () => state.players.find((p) => p.id === state.you);
  const isHost = () => state.hostId === state.you;
  const isPresenter = () => state.presenter?.id === state.you;
  const serverNow = () => Date.now() + clockOffset;
  const fmtScore = (n) => formatScore(n, state.settings.scoring);
  const colorOf = (playerId) => {
    const order = [...state.players].sort((a, b) => a.id.localeCompare(b.id));
    return playerColor(Math.max(0, order.findIndex((p) => p.id === playerId)));
  };
  const hostName = () => state.presenter?.name ?? state.players.find((p) => p.id === state.hostId)?.name ?? 'the host';

  socket.on('state', onState);
  socket.on('connect', rejoin);
  if (rememberedPlayer(code)) rejoin();
  else showJoin();

  async function rejoin() {
    const playerId = rememberedPlayer(code);
    if (!playerId) return;
    const res = await request('game:rejoin', { code, playerId });
    if (res.error) {
      forgetPlayer(code);
      showJoin(res.error);
    }
  }

  function showJoin(message) {
    reset();
    const form = h('form', { class: 'panel narrow', onSubmit: async (e) => {
      e.preventDefault();
      const name = new FormData(form).get('name');
      store.set('gg:name', String(name).trim());
      const res = await request('game:join', { code, name });
      if (res.error) return toast(res.error, 'error');
      rememberPlayer(res.code, res.playerId);
    } },
      h('h2', {}, `Join game ${code}`),
      message ? h('p', { class: 'warn' }, message) : null,
      h('label', {}, 'Your name', h('input', { name: 'name', required: true, maxlength: 24, value: store.get('gg:name') ?? '', autofocus: true })),
      h('button', { class: 'btn primary', type: 'submit' }, 'Join game'),
      h('a', { href: '#/', class: 'back' }, 'Back to start'));
    root.replaceChildren(h('section', { class: 'page center' }, form));
  }

  function reset() {
    for (const fn of teardown) fn();
    teardown = [];
    ui = {};
    layoutKey = null;
    document.body.classList.remove('presenting');
  }

  function onState(snap) {
    if (snap.code !== code) return;
    state = snap;
    clockOffset = snap.serverNow - Date.now();
    if (!me() && !isPresenter()) {
      forgetPlayer(code);
      reset();
      root.replaceChildren(h('section', { class: 'page center' },
        h('h1', {}, 'You were removed from this game'),
        h('p', {}, h('a', { href: '#/' }, 'Back to start'))));
      return;
    }
    const key = `${snap.phase}:${snap.round?.index ?? -1}`;
    if (key !== layoutKey) {
      reset();
      layoutKey = key;
      document.body.classList.toggle('presenting', isPresenter());
      ({ lobby: renderLobby, round: renderRound, reveal: renderReveal, finished: renderFinished })[snap.phase]();
    }
    ui.update?.();
  }

  async function act(event, payload) {
    const res = await request(event, payload);
    if (res.error) toast(res.error, 'error');
    return res;
  }

  function leave() {
    request('game:leave');
    forgetPlayer(code);
    location.hash = '#/';
  }

  function playerList({ showScores = false, showGuessed = false, showPhotos = false } = {}) {
    return h('ul', { class: 'players' }, state.players.map((p) => h('li', { class: p.connected ? '' : 'offline' },
      h('span', { class: 'swatch', style: { background: colorOf(p.id) } }),
      h('span', { class: 'name' }, p.name, p.id === state.you ? ' (you)' : '', p.id === state.hostId ? h('small', {}, ' host') : null),
      !p.connected ? h('small', { class: 'muted' }, 'offline') : null,
      showPhotos ? h('small', { class: 'muted' }, `${p.photos?.ready ?? 0} picture${p.photos?.ready === 1 ? '' : 's'} ready`) : null,
      showGuessed ? h('span', { class: `guessed ${p.guessed ? 'yes' : ''}` },
        p.sittingOut ? 'Own picture' : p.guessed ? 'Guessed' : 'Thinking') : null,
      showScores ? h('span', { class: 'score' }, fmtScore(p.total)) : null,
      isHost() && state.phase === 'lobby' && p.id !== state.you
        ? h('button', { class: 'link', type: 'button', onClick: () => act('game:kick', { playerId: p.id }) }, 'Remove')
        : null,
    )));
  }

  function summary() {
    const s = state.settings;
    const parts = [
      `${state.totalRounds} round${state.totalRounds === 1 ? '' : 's'} of ${s.roundSeconds} seconds`,
      s.mode === 'date' ? `dates ${PRECISION_LABEL[s.precision]}` : null,
      s.mode === 'order' ? `${s.orderSize} pictures per round` : null,
      s.scoring === 'placement' ? 'scored by placement' : 'scored in points',
      s.source === 'immich' ? 'random pictures from Immich' : null,
    ].filter(Boolean);
    return `${parts.join(', ')}.`;
  }

  /** For the host: open the round's pictures in Immich. Other players don't get the links. */
  function originalLinks(result) {
    const links = result.links ?? [];
    if (!links.some(Boolean)) return null;
    const open = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
    return h('p', { class: 'original-links' }, links.length === 1
      ? open(links[0], 'Open in Immich')
      : ['Open in Immich: ', links.map((href, i) => (href ? [open(href, `picture ${i + 1}`), i < links.length - 1 ? ', ' : ''] : null))]);
  }

  // ---------- Lobby ----------
  function renderLobby() {
    let shareUrl = `${location.origin}${location.pathname}#/game/${code}`;
    const shareInput = h('input', { value: shareUrl, readonly: true, 'aria-label': 'Invite link', onFocus: (e) => e.target.select() });
    const shareHint = h('p', { class: 'hint' });
    const qr = h('div', { class: 'qr-wrap' });
    const setQr = () => qr.replaceChildren(qrSvg(shareUrl), h('span', {}, 'Scan to join'));
    setQr();
    inviteOrigin().then((origin) => {
      if (origin) {
        shareUrl = `${origin}${location.pathname}#/game/${code}`;
        shareInput.value = shareUrl;
        setQr();
      } else if (isLocalhost()) {
        shareHint.textContent = 'This link only works on this computer. Share your network address instead.';
      }
    });
    const players = h('div');
    const controls = h('div', { class: 'lobby-controls' });
    const bringPhotos = state.settings.source === 'players';
    let contribute = null;
    if (bringPhotos) {
      contribute = contributePanel({ code, playerId: state.you, mode: state.settings.mode });
      teardown.push(contribute.destroy);
    }

    root.replaceChildren(h('section', { class: `lobby${isPresenter() ? ' lobby-presenter' : ''}` },
      h('div', { class: 'lobby-side' },
        h('div', { class: 'stamp', 'aria-label': `Game code ${code}` },
          h('span', { class: 'stamp-label' }, 'Game code'),
          h('span', { class: 'stamp-code' }, code)),
        qr),
      h('div', { class: 'lobby-info' },
        h('h1', {}, bringPhotos ? 'Bring your own pictures' : state.setName),
        h('p', { class: 'lobby-mode' }, mode().title),
        h('p', { class: 'muted' }, summary()),
        h('div', { class: 'share' },
          shareInput,
          h('button', { class: 'btn', type: 'button', onClick: async () => {
            try { await navigator.clipboard.writeText(shareUrl); toast('Invite link copied'); }
            catch { toast('Copy the link from the box instead.'); }
          } }, 'Copy invite link')),
        shareHint,
        h('h2', {}, 'Players'),
        players,
        contribute?.el,
        controls,
        h('button', { class: 'link', type: 'button', onClick: leave }, 'Leave game')),
    ));
    let starting = false;
    async function start() {
      starting = true;
      ui.update();
      await act('game:start');
      starting = false;
      ui.update?.();
    }
    ui.update = () => {
      players.replaceChildren(state.players.length
        ? playerList({ showPhotos: bringPhotos })
        : h('p', { class: 'muted' }, 'Nobody has joined yet. Players scan the code or open the invite link.'));
      const n = state.players.length;
      controls.replaceChildren(isHost()
        ? h('button', { class: 'btn primary big', type: 'button', disabled: n === 0 || starting, onClick: start },
            starting ? 'Starting…' : n ? `Start game with ${n} player${n === 1 ? '' : 's'}` : 'Waiting for players')
        : h('p', { class: 'waiting' }, `Waiting for ${hostName()} to start the game.`));
    };
  }

  // ---------- Round ----------
  function renderRound() {
    const { round } = state;
    const m = mode();
    const role = isPresenter() ? 'presenter' : round.sittingOut ? 'sitting-out' : 'player';
    let pending = round.myGuess ?? round.myDraft ?? m.initialGuess?.(state) ?? null;
    let locked = Boolean(round.myGuess);
    let draftTimer = null;

    const timer = h('span', { class: 'timer' });
    const bar = h('span', { class: 'timer-bar' });
    const players = h('div', { class: 'round-players' });
    const hostTools = h('div');
    const photoPanel = () => h('figure', { class: 'photo', onClick: () => lightbox(round.imageUrls[0]), title: 'Click to enlarge' },
      h('img', { src: round.imageUrls[0], alt: 'Round picture' }));
    const photoStrip = () => h('div', { class: 'photo-strip' }, round.imageUrls.map((url, i) =>
      h('figure', { onClick: () => lightbox(url) }, h('img', { src: url, alt: `Picture ${i + 1}` }))));

    let main;
    let input = null;
    let inputEl = null;
    const lockBtn = h('button', { class: 'btn primary big', type: 'button', disabled: true, onClick: lockIn });
    if (role === 'player') {
      inputEl = h('div', { class: 'picker' });
      main = m.showsPhotos
        ? h('div', { class: 'guess-pane wide' }, inputEl, lockBtn)
        : [photoPanel(), h('div', { class: 'guess-pane' }, inputEl, lockBtn)];
    } else if (role === 'presenter') {
      // the shared screen shows the picture(s) as large as possible; players guess on their phones
      main = m.showsPhotos ? h('div', { class: 'guess-pane wide' }, photoStrip()) : photoPanel();
    } else {
      const note = h('div', { class: 'presenter-note' }, h('h2', {}, 'This is your picture'),
        h('p', {}, 'Sit back while the others guess. You get the average of their scores for this round.'));
      main = m.showsPhotos ? h('div', { class: 'guess-pane wide' }, photoStrip(), note) : [photoPanel(), note];
    }

    const section = h('section', { class: `round mode-${state.settings.mode} role-${role}` },
      h('div', { class: 'round-bar' },
        h('strong', {}, `Round ${round.index + 1} of ${state.totalRounds}`),
        h('span', { class: 'timer-wrap' }, timer, h('span', { class: 'timer-track' }, bar)),
        h('button', { class: 'link', type: 'button', onClick: leave }, 'Leave')),
      h('div', { class: 'round-body' }, main, h('aside', { class: 'round-side' }, players, hostTools)),
    );
    root.replaceChildren(section);

    // Each pick is sent as a draft so it still counts if time runs out before locking in.
    function pick(payload) {
      if (locked) return;
      pending = payload;
      refresh();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => request('guess:draft', payload), state.settings.mode === 'date' ? 300 : 0);
    }
    teardown.push(() => clearTimeout(draftTimer));

    if (inputEl) {
      input = m.createPicker(inputEl, { state, initial: pending, color: colorOf(state.you), onPick: pick });
      teardown.push(() => input.destroy());
    }

    function refresh() {
      lockBtn.disabled = locked || !pending;
      lockBtn.textContent = locked ? 'Guess locked in' : pending && state.settings.mode !== 'order' ? 'Lock in guess' : m.emptyPrompt;
      input?.setLocked(locked);
    }
    refresh();

    async function lockIn() {
      if (!pending || locked) return;
      locked = true;
      clearTimeout(draftTimer);
      refresh();
      const res = await act('guess:submit', pending);
      if (res.error) {
        locked = false;
        refresh();
      }
    }

    const tick = () => {
      const left = Math.max(0, round.deadline - serverNow());
      const secs = Math.ceil(left / 1000);
      timer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      timer.classList.toggle('urgent', secs <= URGENT_SECONDS);
      section.classList.toggle('urgent', secs <= URGENT_SECONDS);
      bar.style.transform = `scaleX(${left / (state.settings.roundSeconds * 1000)})`;
    };
    tick();
    const interval = setInterval(tick, 250);
    teardown.push(() => clearInterval(interval));

    ui.update = () => {
      const playing = state.players.filter((p) => p.connected && !p.sittingOut);
      players.replaceChildren(
        h('h2', {}, `${state.players.filter((p) => p.guessed).length} of ${playing.length} guessed`),
        playerList({ showGuessed: true }));
      hostTools.replaceChildren(isHost()
        ? h('button', { class: 'btn subtle', type: 'button', onClick: () => act('round:end') }, 'End round now')
        : '');
    };
  }

  // ---------- Reveal ----------
  function resultsTable(result) {
    const placement = state.settings.scoring === 'placement';
    return h('table', { class: 'results' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Off by'), h('th', { class: 'num' }, 'Round'), h('th', { class: 'num' }, 'Total'))),
      h('tbody', {}, result.guesses.map((g) => h('tr', { class: g.playerId === state.you ? 'me' : '' },
        h('td', {}, h('span', { class: 'swatch', style: { background: colorOf(g.playerId) } }), g.name),
        h('td', {}, g.sitOut ? h('span', { class: 'muted' }, 'Own picture') : mode().formatOff(g.distance, state),
          g.guess && !g.locked ? h('small', { class: 'muted', title: 'Picked but not locked in before time ran out' }, ' unlocked') : null),
        h('td', { class: 'num', title: placement ? `${formatPoints(g.points)} points` : '' },
          placement && g.rank ? h('small', { class: 'muted' }, `${ordinal(g.rank)} `) : null,
          `+${fmtScore(g.score)}`),
        h('td', { class: 'num' }, fmtScore(state.players.find((p) => p.id === g.playerId)?.total ?? 0)),
      ))));
  }

  function renderReveal() {
    const result = state.reveal;
    const m = mode();
    const answerEl = h('div');
    const side = h('aside', { class: 'reveal-side' });
    root.replaceChildren(h('section', { class: `reveal mode-${state.settings.mode}` },
      h('div', { class: 'round-bar' },
        h('strong', {}, `Round ${result.index + 1} of ${state.totalRounds} result`),
        h('button', { class: 'link', type: 'button', onClick: leave }, 'Leave')),
      h('div', { class: 'reveal-body' }, answerEl, side)));
    teardown.push(m.renderAnswer(answerEl, result, { state, colorOf }));

    ui.update = () => {
      const last = result.index + 1 >= state.totalRounds;
      side.replaceChildren(...[
        m.showsPhotos ? null : h('figure', { class: 'reveal-photo' },
          h('img', { src: result.imageUrls[0], alt: result.answer.caption || 'This round’s picture', onClick: () => lightbox(result.imageUrls[0]) }),
          result.answer.caption ? h('figcaption', {}, result.answer.caption) : null,
          m.answerNote?.(result, state)),
        originalLinks(result),
        resultsTable(result),
        isHost()
          ? h('button', { class: 'btn primary big', type: 'button', onClick: () => act('round:next') },
              last ? 'Show final scores' : 'Next round')
          : h('p', { class: 'waiting' }, `Waiting for ${hostName()} to continue.`),
      ].filter(Boolean));
    };
  }

  // ---------- Finished ----------
  function renderFinished() {
    const ranked = state.players;
    const placement = state.settings.scoring === 'placement';
    const m = mode();
    const entryOf = (round, playerId) => round.guesses.find((g) => g.playerId === playerId);
    const answerEl = h('div');
    let recap = 0;
    let cleanupRecap = null;
    const recapLabel = h('span');
    const recapLinks = h('div');
    const showRecap = (i) => {
      recap = (i + state.history.length) % state.history.length;
      cleanupRecap?.();
      answerEl.replaceChildren();
      cleanupRecap = m.renderAnswer(answerEl, state.history[recap], { state, colorOf });
      const caption = state.history[recap].answer.caption;
      recapLabel.textContent = `Round ${recap + 1}${caption ? `: ${caption}` : ''}`;
      recapLinks.replaceChildren(...[originalLinks(state.history[recap])].filter(Boolean));
    };
    const unit = (n) => (placement ? `placement point${n === 1 ? '' : 's'}` : `point${n === 1 ? '' : 's'}`);

    root.replaceChildren(h('section', { class: 'finished' },
      h('h1', {}, ranked[0] ? `${ranked[0].name} wins` : 'Game over'),
      h('ol', { class: 'podium' }, ranked.slice(0, 3).map((p, i) => h('li', { class: `place-${i + 1}` },
        h('span', { class: 'place' }, ordinal(i + 1)),
        h('strong', {}, p.name),
        h('span', { class: 'score' }, `${fmtScore(p.total)} ${unit(p.total)}`)))),
      placement ? h('p', { class: 'muted' }, 'Each round, you get a point for every player you were closer than. Ties are broken by points.') : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'results breakdown' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Player'),
          state.history.map((r) => h('th', { class: 'num' }, `R${r.index + 1}`)),
          h('th', { class: 'num' }, 'Total'),
          placement ? h('th', { class: 'num' }, 'Points') : null)),
        h('tbody', {}, ranked.map((p) => h('tr', { class: p.id === state.you ? 'me' : '' },
          h('td', {}, h('span', { class: 'swatch', style: { background: colorOf(p.id) } }), p.name),
          state.history.map((r) => {
            const g = entryOf(r, p.id);
            const title = !g ? '' : g.sitOut ? 'Own picture (average of the others)' : g.guess ? m.formatOff(g.distance, state) : 'No guess';
            return h('td', { class: `num${g?.sitOut ? ' muted' : ''}`, title }, g && (g.guess || g.sitOut) ? fmtScore(g.score) : '–');
          }),
          h('td', { class: 'num total' }, fmtScore(p.total)),
          placement ? h('td', { class: 'num muted' }, formatPoints(p.points)) : null))))),
      h('div', { class: 'recap' },
        h('div', { class: 'recap-nav' },
          h('button', { class: 'btn', type: 'button', onClick: () => showRecap(recap - 1), 'aria-label': 'Previous round' }, 'Previous'),
          recapLabel,
          h('button', { class: 'btn', type: 'button', onClick: () => showRecap(recap + 1), 'aria-label': 'Next round' }, 'Next')),
        recapLinks,
        answerEl),
      h('div', { class: 'finish-actions' },
        isHost() ? h('button', { class: 'btn primary', type: 'button', onClick: () => act('game:restart') }, 'Play again with everyone') : null,
        h('a', { class: `btn${isHost() ? '' : ' primary'}`, href: '#/', onClick: () => { request('game:leave'); forgetPlayer(code); } }, 'Back to start')),
      isHost() ? null : h('p', { class: 'muted' }, `${hostName()} can start another game with everyone; stay on this page to join in.`),
    ));
    showRecap(0);
    teardown.push(() => cleanupRecap?.());
  }

  return () => {
    reset();
    socket.off('state', onState);
    socket.off('connect', rejoin);
  };
}
