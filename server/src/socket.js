import crypto from 'node:crypto';
import { Game, GameError } from './game.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
const IDLE_MS = 3 * 60 * 60 * 1000;

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function setupSockets(io, store) {
  const games = new Map();

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

  // Wraps a handler so thrown GameErrors become `{ error }` acks instead of crashing.
  const handle = (socket, fn) => (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...(fn(payload ?? {}) ?? {}) });
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      reply({ error: err instanceof GameError ? err.message : 'Something went wrong on the server.' });
    }
  };

  const currentGame = (socket) => {
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
    socket.on('game:create', handle(socket, ({ setId, mode, rounds, roundSeconds, scale, name }) => {
      const set = store.get(String(setId));
      if (!set) throw new GameError('That picture set does not exist.');
      const code = newCode();
      const game = new Game({
        code,
        set,
        mode: mode === 'date' ? 'date' : 'location',
        images: set.images,
        rounds: clampInt(rounds, 1, 100, 5),
        roundSeconds: clampInt(roundSeconds, 10, 600, 60),
        // km for location; hours for date (up to ~200 years)
        scale: scale ? clampInt(scale, 1, 2_000_000, undefined) : undefined,
        onChange: () => broadcast(game),
      });
      const player = game.addPlayer(name);
      games.set(code, game);
      attach(socket, game, player.id);
      return { code, playerId: player.id };
    }));

    socket.on('game:join', handle(socket, ({ code, name }) => {
      const game = games.get(String(code).toUpperCase());
      if (!game) throw new GameError(`No game with code ${String(code).toUpperCase()}. Check the code with your host.`);
      const player = game.addPlayer(name);
      attach(socket, game, player.id);
      return { code: game.code, playerId: player.id };
    }));

    socket.on('game:rejoin', handle(socket, ({ code, playerId }) => {
      const game = games.get(String(code).toUpperCase());
      if (!game || !game.players.has(playerId)) throw new GameError('That game is over or you are no longer in it.');
      attach(socket, game, playerId);
      return { code: game.code, playerId };
    }));

    socket.on('game:leave', handle(socket, () => detach(socket)));
    socket.on('game:start', handle(socket, () => currentGame(socket).start(socket.data.playerId)));
    socket.on('game:kick', handle(socket, ({ playerId }) => currentGame(socket).kick(socket.data.playerId, playerId)));
    socket.on('round:next', handle(socket, () => currentGame(socket).next(socket.data.playerId)));
    socket.on('round:end', handle(socket, () => currentGame(socket).endRoundEarly(socket.data.playerId)));
    socket.on('guess:draft', handle(socket, (payload) =>
      currentGame(socket).setDraft(socket.data.playerId, payload)));
    socket.on('guess:submit', handle(socket, (payload) =>
      currentGame(socket).submitGuess(socket.data.playerId, payload)));

    socket.on('disconnect', () => detach(socket));
  });

  setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [code, game] of games) {
      if (game.lastActivity < cutoff) {
        game.dispose();
        games.delete(code);
      }
    }
  }, 10 * 60 * 1000).unref();

  return games;
}
