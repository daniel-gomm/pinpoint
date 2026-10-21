import crypto from 'node:crypto';
import { GameError } from './errors.js';
import { MODES } from './modes.js';
import { placements } from './scoring.js';

export const MAX_PLAYERS = 30;
// A page reload briefly disconnects a player; don't end the round on them in the meantime.
export const DISCONNECT_GRACE_MS = 8000;
export const PHASES = { LOBBY: 'lobby', ROUND: 'round', REVEAL: 'reveal', FINISHED: 'finished' };

export { GameError };

/** @typedef {import('../../shared/protocol.js').GameSettings} GameSettings */
/** @typedef {import('../../shared/protocol.js').Snapshot} Snapshot */
/** @typedef {{ set: {id: string, name: string, map?: any}, images: any[] }} Pool */

const POOL_OWNER = { set: 'This picture set has', players: 'The players have added', immich: 'Immich has' };

const READY_HINT = { location: 'a location', date: 'a date', order: 'a date' };

export class Game {
  /**
   * @param {object} opts
   * @param {string} opts.code
   * @param {GameSettings} opts.settings
   * @param {() => Pool} [opts.loadPool] the pictures to play with, when start() isn't given them
   * @param {() => void} [opts.onChange] called whenever clients should get a fresh snapshot
   * @param {() => number} [opts.now]
   */
  constructor({ code, settings, loadPool, onChange, now = Date.now }) {
    this.objective = MODES[settings.mode];
    if (!this.objective) throw new GameError('Unknown game mode.');
    this.code = code;
    this.settings = settings;
    this.loadPool = loadPool;
    this.onChange = onChange;
    this.now = now;

    this.phase = PHASES.LOBBY;
    /** @type {Map<string, {id: string, name: string, connected: boolean, total: number, points: number}>} */
    this.players = new Map();
    /** @type {{id: string, name: string, connected: boolean} | null} host who presents but doesn't play */
    this.presenter = null;
    this.hostId = null;
    this.setName = '';
    this.scale = settings.scale ?? null;
    this.setup = null;
    /** @type {Array<{images: any[], sitOut: string[]}>} */
    this.rounds = [];
    this.roundIndex = -1;
    this.deadline = null;
    this.guesses = new Map();
    this.drafts = new Map();
    this.results = [];
    /** picture ids from earlier games in this lobby; a rematch prefers new ones */
    this.played = new Set();
    /** @type {Map<string, {count: number, ready: number}>} pictures each player added */
    this.contributions = new Map();
    this.timer = null;
    this.graceTimers = new Map();
    this.lastActivity = now();
  }

  // ---------- people ----------

  addPlayer(name) {
    if (this.phase !== PHASES.LOBBY) throw new GameError('This game has already started.');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('This game is full.');
    const clean = this.checkName(name);
    const player = { id: crypto.randomUUID(), name: clean, connected: true, total: 0, points: 0 };
    this.players.set(player.id, player);
    if (!this.settings.presenter) this.hostId ??= player.id;
    this.touch();
    return player;
  }

  /** The host of a presenter game: runs the show on a shared screen and doesn't guess. */
  addPresenter(name) {
    if (this.hostId) throw new GameError('This game already has a host.');
    this.presenter = { id: crypto.randomUUID(), name: this.checkName(name), connected: true };
    this.hostId = this.presenter.id;
    this.touch();
    return this.presenter;
  }

  checkName(name) {
    const clean = String(name ?? '').trim().slice(0, 24);
    if (!clean) throw new GameError('Enter a name to join.');
    const names = [...this.players.values(), ...(this.presenter ? [this.presenter] : [])].map((p) => p.name.toLowerCase());
    if (names.includes(clean.toLowerCase())) throw new GameError(`Someone is already called “${clean}”. Pick another name.`);
    return clean;
  }

  isMember(id) {
    return this.players.has(id) || this.presenter?.id === id;
  }

  nameOf(id) {
    return this.players.get(id)?.name ?? (this.presenter?.id === id ? this.presenter.name : 'Left the game');
  }

  setConnected(id, connected) {
    const person = this.players.get(id) ?? (this.presenter?.id === id ? this.presenter : null);
    if (!person) return;
    person.connected = connected;
    clearTimeout(this.graceTimers.get(id));
    this.graceTimers.delete(id);
    if (!connected && this.players.has(id)) {
      this.graceTimers.set(id, setTimeout(() => {
        this.graceTimers.delete(id);
        this.maybeEndRound();
      }, DISCONNECT_GRACE_MS));
    }
    this.touch();
  }

  kick(byId, playerId) {
    this.requireHost(byId);
    if (playerId === this.hostId) throw new GameError('The host cannot be removed.');
    this.players.delete(playerId);
    clearTimeout(this.graceTimers.get(playerId));
    this.graceTimers.delete(playerId);
    this.guesses.delete(playerId);
    this.drafts.delete(playerId);
    this.touch();
    this.maybeEndRound();
  }

  setContributions(counts) {
    this.contributions = counts;
    this.touch();
  }

  // ---------- flow ----------

  /**
   * Draws the rounds from the available pictures. Throws if there aren't enough.
   * @param {Pool} [available] defaults to what loadPool returns
   */
  prepare(available = this.loadPool?.()) {
    if (!available) throw new GameError('There are no pictures to play with.');
    const { set, images } = available;
    const pool = images.filter((i) => this.objective.isReady(i));
    const needed = this.objective.minPool(this.settings);
    if (pool.length < needed) {
      const what = POOL_OWNER[this.settings.source] ?? POOL_OWNER.set;
      throw new GameError(needed > 1
        ? `${what} ${pool.length} pictures with ${READY_HINT[this.settings.mode]}; this game needs at least ${needed}.`
        : `${what} no pictures with ${READY_HINT[this.settings.mode]} yet.`);
    }
    const ctx = { settings: this.settings, set, now: this.now(), code: this.code };
    this.setName = set.name;
    this.scale = this.settings.scale || this.objective.defaultScale(pool, ctx);
    // Derived from every ready picture, not just the drawn rounds, so it says less about them.
    this.setup = this.objective.setup(pool, ctx);
    this.rounds = this.objective
      .drawRounds(pool, this.settings.rounds, ctx, this.played)
      .map((roundImages) => ({ images: roundImages, sitOut: this.objective.sitOut(roundImages) }));
    return this.rounds.length;
  }

  /** @param {Pool} [pool] */
  start(byId, pool) {
    this.checkStart(byId);
    this.prepare(pool);
    this.startRound();
  }

  /** Throws unless this person may start the game now. */
  checkStart(byId) {
    this.requireHost(byId);
    if (this.phase !== PHASES.LOBBY) throw new GameError('The game has already started.');
    if (this.players.size === 0) throw new GameError('Wait for at least one player to join.');
  }

  next(byId) {
    this.checkNext(byId);
    if (this.roundIndex + 1 >= this.rounds.length) {
      this.phase = PHASES.FINISHED;
      this.touch();
    } else {
      this.startRound();
    }
  }

  /** Throws unless this person may move on from the reveal now. */
  checkNext(byId) {
    this.requireHost(byId);
    if (this.phase !== PHASES.REVEAL) throw new GameError('Wait for the round to finish.');
  }

  /** Back to the lobby with the same players for another game. */
  restart(byId) {
    this.requireHost(byId);
    if (this.phase !== PHASES.FINISHED) throw new GameError('Finish this game first.');
    for (const r of this.rounds) for (const image of r.images) this.played.add(image.id);
    for (const p of this.players.values()) {
      p.total = 0;
      p.points = 0;
    }
    this.rounds = [];
    this.results = [];
    this.roundIndex = -1;
    this.phase = PHASES.LOBBY;
    this.touch();
  }

  endRoundEarly(byId) {
    this.requireHost(byId);
    if (this.phase === PHASES.ROUND) this.endRound();
  }

  submitGuess(playerId, payload) {
    this.guesses.set(playerId, this.checkGuess(playerId, payload));
    this.drafts.delete(playerId);
    this.touch();
    this.maybeEndRound();
  }

  /** A pick that isn't locked in yet. It counts if the round ends before the player locks in. */
  setDraft(playerId, payload) {
    this.drafts.set(playerId, this.checkGuess(playerId, payload));
    this.lastActivity = this.now();
  }

  checkGuess(playerId, payload) {
    if (this.phase !== PHASES.ROUND) throw new GameError('There is no round in progress.');
    if (!this.players.has(playerId)) throw new GameError('Only players can guess.');
    if (this.currentRound().sitOut.includes(playerId)) throw new GameError('This is your picture, so you sit this round out.');
    if (this.guesses.has(playerId)) throw new GameError('You already guessed this round.');
    return this.objective.parseGuess(payload ?? {}, this.context());
  }

  context() {
    return { settings: this.settings, setup: this.setup, code: this.code };
  }

  currentRound() {
    return this.rounds[this.roundIndex];
  }

  startRound() {
    this.roundIndex += 1;
    this.phase = PHASES.ROUND;
    this.guesses = new Map();
    this.drafts = new Map();
    this.deadline = this.now() + this.settings.roundSeconds * 1000;
    this.armTimer();
    this.touch();
    this.maybeEndRound();
  }

  armTimer() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.endRound(), Math.max(0, this.deadline - this.now()));
  }

  maybeEndRound() {
    if (this.phase !== PHASES.ROUND) return;
    const { sitOut } = this.currentRound();
    // Players who just dropped out may be reloading, so they still count for a few seconds.
    const active = [...this.players.values()].filter((p) =>
      !sitOut.includes(p.id) && (p.connected || this.graceTimers.has(p.id)));
    // A round where every remaining player sits out (their own picture) has nothing to wait for.
    if ((active.length > 0 || sitOut.length > 0) && active.every((p) => this.guesses.has(p.id))) this.endRound();
  }

  endRound() {
    if (this.phase !== PHASES.ROUND) return;
    clearTimeout(this.timer);
    this.timer = null;
    const round = this.currentRound();
    const ctx = this.context();

    const playing = [...this.players.values()].filter((p) => !round.sitOut.includes(p.id));
    /** @type {any[]} */
    const entries = playing.map((player) => {
      const locked = this.guesses.has(player.id);
      const guess = this.guesses.get(player.id) ?? this.drafts.get(player.id) ?? null;
      const distance = guess ? this.objective.distance(guess, round.images, ctx) : null;
      const points = guess ? this.objective.score(distance, this.scale, ctx) : 0;
      return { playerId: player.id, sitOut: false, guess, locked: guess ? locked : false, distance, points };
    });
    placements(entries).forEach((p, i) => Object.assign(entries[i], p));
    for (const e of entries) e.score = this.settings.scoring === 'placement' ? e.placement : e.points;

    // Sitting out shouldn't cost you: you get the average of everyone who played.
    const avg = (key, step) => {
      if (!entries.length) return 0;
      const mean = entries.reduce((sum, e) => sum + e[key], 0) / entries.length;
      return Math.round(mean / step) * step;
    };
    for (const player of this.players.values()) {
      if (!round.sitOut.includes(player.id)) continue;
      const points = avg('points', 1);
      entries.push({
        playerId: player.id, sitOut: true, guess: null, locked: false, distance: null, points, placement: null, rank: null,
        score: this.settings.scoring === 'placement' ? avg('placement', 0.5) : points,
      });
    }

    for (const e of entries) {
      const player = this.players.get(e.playerId);
      player.total += e.score;
      player.points += e.points;
    }
    this.results.push({ entries });
    this.phase = PHASES.REVEAL;
    this.deadline = null;
    this.touch();
  }

  requireHost(id) {
    if (id !== this.hostId) throw new GameError('Only the host can do that.');
  }

  touch() {
    this.lastActivity = this.now();
    this.onChange?.();
  }

  dispose() {
    clearTimeout(this.timer);
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.onChange = null;
  }

  imageFor(index, slot = 0) {
    if (index < 0 || index > this.roundIndex) return null;
    return this.rounds[index]?.images[slot] ?? null;
  }

  /** A picture's reveal version, only once its round is over. */
  revealFor(index, slot = 0) {
    const over = index < this.roundIndex || (index === this.roundIndex && this.phase !== PHASES.ROUND);
    const image = over ? this.imageFor(index, slot) : null;
    return image?.revealFile ? image : null;
  }

  // ---------- views ----------

  standings() {
    return [...this.players.values()]
      .sort((a, b) => b.total - a.total || b.points - a.points || a.name.localeCompare(b.name));
  }

  publicResult(index, viewerId) {
    const round = this.rounds[index];
    const last = (e) => (e.sitOut ? 1 : 0);
    const links = round.images.map((i) => i.link ?? null);
    return {
      index,
      answer: this.objective.answer(round.images, this.context()),
      // After the round, pictures with a reveal version (e.g. uncropped) show that one.
      imageUrls: round.images.map((image, slot) =>
        `/api/games/${this.code}/${image.revealFile ? 'reveal' : 'images'}/${index}/${slot}`),
      // Where the host can open the original (e.g. in Immich); other players don't get the address.
      links: viewerId === this.hostId && links.some(Boolean) ? links : null,
      guesses: this.results[index].entries
        .map((e) => ({ ...e, name: this.nameOf(e.playerId) }))
        .sort((a, b) => last(a) - last(b) || b.score - a.score || b.points - a.points),
    };
  }

  imageUrls(index) {
    return this.rounds[index].images.map((_, slot) => `/api/games/${this.code}/images/${index}/${slot}`);
  }

  /**
   * What one person is allowed to see. Never leaks the answer of a running round.
   * @returns {Snapshot}
   */
  snapshot(viewerId) {
    const s = this.settings;
    const inRound = this.phase === PHASES.ROUND;
    const round = this.roundIndex >= 0 ? this.rounds[this.roundIndex] : null;
    return {
      code: this.code,
      setName: this.setName,
      phase: /** @type {Snapshot['phase']} */ (this.phase),
      you: viewerId,
      hostId: this.hostId,
      presenter: this.presenter ? { id: this.presenter.id, name: this.presenter.name, connected: this.presenter.connected } : null,
      settings: {
        mode: s.mode, scoring: s.scoring, rounds: s.rounds, roundSeconds: s.roundSeconds,
        precision: s.precision, orderSize: s.orderSize, presenter: s.presenter, source: s.source,
      },
      totalRounds: this.rounds.length || s.rounds,
      scale: this.scale,
      setup: this.setup,
      serverNow: this.now(),
      players: this.standings().map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        total: p.total,
        points: p.points,
        guessed: inRound && this.guesses.has(p.id),
        sittingOut: inRound && round.sitOut.includes(p.id),
        photos: this.contributions.get(p.id) ?? null,
      })),
      round: round && {
        index: this.roundIndex,
        imageUrls: this.imageUrls(this.roundIndex),
        deadline: this.deadline,
        sittingOut: round.sitOut.includes(viewerId),
        myGuess: inRound ? this.guesses.get(viewerId) ?? null : null,
        myDraft: inRound ? this.drafts.get(viewerId) ?? null : null,
      },
      reveal: this.phase === PHASES.REVEAL ? this.publicResult(this.roundIndex, viewerId) : null,
      history: this.phase === PHASES.FINISHED ? this.results.map((_, i) => this.publicResult(i, viewerId)) : null,
    };
  }

  // ---------- persistence ----------

  toJSON() {
    return {
      code: this.code,
      settings: this.settings,
      phase: this.phase,
      players: [...this.players.values()],
      presenter: this.presenter,
      hostId: this.hostId,
      setName: this.setName,
      scale: this.scale,
      setup: this.setup,
      rounds: this.rounds,
      roundIndex: this.roundIndex,
      deadline: this.deadline,
      guesses: [...this.guesses],
      drafts: [...this.drafts],
      results: this.results,
      played: [...this.played],
      contributions: [...this.contributions],
      lastActivity: this.lastActivity,
    };
  }

  /**
   * Rebuilds a saved game. Everyone starts disconnected; a running round keeps its deadline.
   * @param {any} data from toJSON()
   * @param {{loadPool?: () => Pool, onChange?: () => void, now?: () => number}} opts
   */
  static fromJSON(data, { loadPool, onChange, now = Date.now }) {
    const game = new Game({ code: data.code, settings: data.settings, loadPool, now });
    Object.assign(game, {
      phase: data.phase,
      presenter: data.presenter && { ...data.presenter, connected: false },
      hostId: data.hostId,
      setName: data.setName,
      scale: data.scale,
      setup: data.setup,
      rounds: data.rounds,
      roundIndex: data.roundIndex,
      deadline: data.deadline,
      guesses: new Map(data.guesses),
      drafts: new Map(data.drafts),
      results: data.results,
      played: new Set(data.played),
      contributions: new Map(data.contributions),
      lastActivity: data.lastActivity,
    });
    for (const p of data.players) game.players.set(p.id, { ...p, connected: false });
    game.onChange = onChange;
    if (game.phase === PHASES.ROUND) game.armTimer();
    return game;
  }
}
