import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Game, GameError } from './game.js';
import { MODES, PRECISIONS, ORDER_SIZES } from './modes.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
const IDLE_MS = 3 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 1000;

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);

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
    source: raw.source === 'players' ? 'players' : 'set',
  };
}

export function setupSockets(io, store, { dataDir }) {
  /** @type {Map<string, Game>} */
  const games = new Map();
  const saveFile = path.resolve(dataDir, 'games.json');
  let saveTimer = null;

  function newCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    } while (games.has(code));
    return code;
  }

  const loadPool = (setId) => () => {
    const set = store.get(setId);
    if (!set) throw new GameError('The picture set for this game was deleted.');
    return { set, images: set.images };
  };

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
        register(Game.fromJSON(data, { loadPool: loadPool(data.settings.setId) }));
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
  const handle = (fn) => (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...(fn(payload ?? {}) ?? {}) });
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      reply({ error: err instanceof GameError ? err.message : 'Something went wrong on the server.' });
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
    socket.on('game:create', handle(({ setId, name, settings: raw }) => {
      const settings = cleanSettings(raw);
      const code = newCode();
      if (settings.source === 'players') {
        const day = new Date().toISOString().slice(0, 10);
        settings.setId = store.create(`Photos from game ${code} (${day})`, { fromGame: code }).id;
      } else {
        if (!store.get(String(setId))) throw new GameError('That picture set does not exist.');
        settings.setId = String(setId);
      }
      const game = new Game({ code, settings, loadPool: loadPool(settings.setId) });
      if (settings.source === 'set') {
        // Fail early when the set can't support this game, and show the real number of rounds.
        settings.rounds = game.prepare();
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
    socket.on('game:start', handle(() => gameOf(socket).start(socket.data.playerId)));
    socket.on('game:restart', handle(() => gameOf(socket).restart(socket.data.playerId)));
    socket.on('game:kick', handle(({ playerId }) => gameOf(socket).kick(socket.data.playerId, playerId)));
    socket.on('round:next', handle(() => gameOf(socket).next(socket.data.playerId)));
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
