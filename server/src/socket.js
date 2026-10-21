import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Game, GameError } from './game.js';
import { MODES, PRECISIONS, ORDER_SIZES } from './modes.js';
import { ImmichError } from './immich.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
const IDLE_MS = 3 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 1000;

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);
const SOURCES = ['set', 'players', 'immich'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null);

/** @returns {import('../../shared/protocol.js').ImmichSettings} */
function cleanImmich(raw = {}) {
  const albumId = typeof raw.albumId === 'string' && UUID_RE.test(raw.albumId) ? raw.albumId : null;
  let [from, to] = [day(raw.from), day(raw.to)];
  if (from && to && from > to) [from, to] = [to, from];
  return {
    albumId, favorites: Boolean(raw.favorites), cameraOnly: raw.cameraOnly !== false, from, to,
    // An album already holds everything shared in it.
    partners: !albumId && Boolean(raw.partners),
  };
}

/** @returns {import('../../shared/protocol.js').GameSettings} */
export function cleanSettings(raw = {}) {
  const mode = oneOf(raw.mode, Object.keys(MODES), 'location');
  return {
    mode,
    scoring: oneOf(raw.scoring, ['placement', 'points'], 'placement'),
    rounds: clampInt(raw.rounds, 1, 100, 5),
    roundSeconds: clampInt(raw.roundSeconds, 10, 600, mode === 'order' ? 90 : 60),
    // km for location; hours for date (up to ~200 years)
    scale: raw.scale ? clampInt(raw.scale, 1, 2_000_000, undefined) : undefined,
    precision: oneOf(raw.precision, PRECISIONS, 'minute'),
    orderSize: oneOf(Number(raw.orderSize), ORDER_SIZES, 4),
    presenter: Boolean(raw.presenter),
    source: oneOf(raw.source, SOURCES, 'set'),
    ...(raw.source === 'immich' ? { immich: cleanImmich(raw.immich ?? {}) } : {}),
  };
}

/**
 * @param {import('socket.io').Server} io
 * @param {import('./sets.js').SetStore} store
 * @param {{dataDir: string, sources: ReturnType<typeof import('./sources.js').createSources>}} opts
 */
export function setupSockets(io, store, { dataDir, sources }) {
  /** @type {Map<string, Game>} */
  const games = new Map();
  const saveFile = path.resolve(dataDir, 'games.json');
  let saveTimer = null;
  /** codes of games whose next round is waiting for its pictures */
  const advancing = new Set();

  function newCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    } while (games.has(code));
    return code;
  }

  async function broadcast(game) {
    const sockets = await io.in(game.code).fetchSockets();
    for (const s of sockets) s.emit('state', game.snapshot(s.data.playerId));
  }

  // ----- persistence: games survive a server restart -----
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const data = JSON.stringify([...games.values()].map((g) => g.toJSON()));
    fs.writeFileSync(saveFile + '.tmp', data);
    fs.renameSync(saveFile + '.tmp', saveFile);
  }
  const scheduleSave = () => { saveTimer ??= setTimeout(saveNow, SAVE_DELAY_MS); };

  function register(game) {
    games.set(game.code, game);
    game.onChange = () => {
      broadcast(game);
      scheduleSave();
      sources.prefetch(game);
    };
  }

  function restore() {
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    } catch { /* first start */ }
    for (const data of saved) {
      if (data.lastActivity < Date.now() - IDLE_MS) continue;
      try {
        register(Game.fromJSON(data, {}));
      } catch (err) {
        console.error(`Could not restore game ${data.code}:`, err.message);
      }
    }
    if (games.size) console.log(`Restored ${games.size} game(s)`);
  }

  /** Recounts the pictures each player added to a players-bring-photos game. */
  function refreshContributions(game) {
    const set = store.get(game.settings.setId);
    const counts = new Map();
    for (const image of set?.images ?? []) {
      if (!image.contributorId) continue;
      const c = counts.get(image.contributorId) ?? { count: 0, ready: 0 };
      c.count += 1;
      if (game.objective.isReady(image)) c.ready += 1;
      counts.set(image.contributorId, c);
    }
    game.setContributions(counts);
  }

  // Wraps a handler so thrown GameErrors become `{ error }` acks instead of crashing.
  const handle = (fn) => async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...((await fn(payload ?? {})) ?? {}) });
    } catch (err) {
      const shown = err instanceof GameError || err instanceof ImmichError;
      if (!shown) console.error(err);
      reply({ error: shown ? err.message : 'Something went wrong on the server.' });
    }
  };

  const gameOf = (socket) => {
    const game = games.get(socket.data.code);
    if (!game) throw new GameError('This game no longer exists.');
    return game;
  };

  function attach(socket, game, playerId) {
    if (socket.data.code && socket.data.code !== game.code) detach(socket);
    socket.data.code = game.code;
    socket.data.playerId = playerId;
    socket.join(game.code);
    game.setConnected(playerId, true);
  }

  function detach(socket) {
    const game = games.get(socket.data.code);
    socket.leave(socket.data.code);
    const { playerId } = socket.data;
    socket.data.code = socket.data.playerId = null;
    if (!game) return;
    // The same player may be open in another tab.
    io.in(game.code).fetchSockets().then((others) => {
      if (!others.some((s) => s.data.playerId === playerId)) game.setConnected(playerId, false);
    });
  }

  io.on('connection', (socket) => {
    socket.on('game:create', handle(async ({ setId, name, settings: raw }) => {
      const settings = cleanSettings(raw);
      if (settings.source === 'set') {
        if (!store.get(String(setId))) throw new GameError('That picture set does not exist.');
        settings.setId = String(setId);
      }
      const pool = settings.source === 'players' ? null : await sources.pool(settings);
      const code = newCode();
      if (settings.source === 'players') {
        const day = new Date().toISOString().slice(0, 10);
        settings.setId = store.create(`Photos from game ${code} (${day})`, { fromGame: code }).id;
      }
      const game = new Game({ code, settings });
      if (pool) {
        // Fail early when the pictures can't support this game, and show the real number of rounds.
        settings.rounds = game.prepare(pool);
        game.rounds = [];
      }
      const host = settings.presenter ? game.addPresenter(name) : game.addPlayer(name);
      register(game);
      attach(socket, game, host.id);
      scheduleSave();
      return { code, playerId: host.id };
    }));

    socket.on('game:join', handle(({ code, name }) => {
      const game = games.get(String(code).toUpperCase());
      if (!game) throw new GameError(`No game with code ${String(code).toUpperCase()}. Check the code with your host.`);
      const player = game.addPlayer(name);
      attach(socket, game, player.id);
      return { code: game.code, playerId: player.id };
    }));

    socket.on('game:rejoin', handle(({ code, playerId }) => {
      const game = games.get(String(code).toUpperCase());
      if (!game || !game.isMember(playerId)) throw new GameError('That game is over or you are no longer in it.');
      attach(socket, game, playerId);
      return { code: game.code, playerId };
    }));

    socket.on('game:leave', handle(() => detach(socket)));
    // Starting a round waits for its pictures, so the host can't trigger it twice meanwhile.
    const advance = async (game, step) => {
      if (advancing.has(game.code)) throw new GameError('The pictures for the next round are still loading.');
      advancing.add(game.code);
      try {
        await step();
      } finally {
        advancing.delete(game.code);
      }
    };

    socket.on('game:start', handle(() => {
      const game = gameOf(socket);
      const { playerId } = socket.data;
      game.checkStart(playerId);
      return advance(game, async () => {
        game.prepare(await sources.pool(game.settings));
        await sources.ready(game, 0);
        game.checkStart(playerId);
        game.startRound();
      });
    }));
    socket.on('game:restart', handle(() => gameOf(socket).restart(socket.data.playerId)));
    socket.on('game:kick', handle(({ playerId }) => gameOf(socket).kick(socket.data.playerId, playerId)));
    socket.on('round:next', handle(() => {
      const game = gameOf(socket);
      const { playerId } = socket.data;
      game.checkNext(playerId);
      return advance(game, async () => {
        await sources.ready(game, game.roundIndex + 1);
        game.next(playerId);
      });
    }));
    socket.on('round:end', handle(() => gameOf(socket).endRoundEarly(socket.data.playerId)));
    socket.on('guess:draft', handle((payload) => gameOf(socket).setDraft(socket.data.playerId, payload)));
    socket.on('guess:submit', handle((payload) => gameOf(socket).submitGuess(socket.data.playerId, payload)));

    socket.on('disconnect', () => detach(socket));
  });

  setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [code, game] of games) {
      if (game.lastActivity < cutoff) {
        game.dispose();
        games.delete(code);
        scheduleSave();
      }
    }
  }, 10 * 60 * 1000).unref();

  restore();
  return { games, refreshContributions, saveNow };
}
