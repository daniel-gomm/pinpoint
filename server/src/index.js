import http from 'node:http';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { SetStore, SetError } from './sets.js';
import { setupSockets } from './socket.js';
import { lanAddresses } from './network.js';
import { isDated, isLocated, parseTakenAt } from './modes.js';
import { processImage, ImageError } from './images.js';
import { PHASES } from './game.js';
import { ImmichConfig, ImmichClient, ImmichError } from './immich.js';
import { createSources } from './sources.js';
import { GameError } from './errors.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';

const store = new SetStore(DATA_DIR);
const immich = new ImmichConfig(DATA_DIR);
const sources = createSources({ store, immich });
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
const { games, refreshContributions, saveNow } = setupSockets(io, store, { dataDir: DATA_DIR, sources });

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 } });
const zipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024, files: 1 } });

app.use(express.json({ limit: '100kb' }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const notFound = (what = 'Picture set') => new HttpError(404, `${what} not found.`);
// Express 4 doesn't catch rejected promises; route them to the error handler.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const requireSet = (id) => store.get(id) ?? (() => { throw notFound(); })();

/** Validates picture fields from a request body against the set's map. */
function parsePatch(set, body) {
  const patch = {};
  if ('lat' in body || 'lng' in body) {
    const clear = (body.lat === null || body.lat === '') && (body.lng === null || body.lng === '');
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const [maxLat, maxLng, minLat, minLng] = set.map
      ? [set.map.height, set.map.width, 0, 0]
      : [90, 180, -90, -180];
    if (clear) {
      patch.lat = patch.lng = null;
    } else if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) {
      throw new HttpError(400, 'That position is outside the map.');
    } else {
      patch.lat = lat;
      patch.lng = lng;
    }
  }
  if ('takenAt' in body) {
    const value = body.takenAt === '' ? null : body.takenAt;
    if (value !== null && parseTakenAt(value) === null) throw new HttpError(400, 'Use a date and time like 2024-07-14T15:30.');
    patch.takenAt = value;
  }
  if ('caption' in body) patch.caption = String(body.caption ?? '').slice(0, 200);
  return patch;
}

async function readPhoto(req) {
  if (!req.file) throw new HttpError(400, 'Choose a picture to upload.');
  return (await processImage(req.file.buffer)).buffer;
}

const ids = (value) => (Array.isArray(value) ? value.map(String) : []);
const setName = (body) => {
  const name = String(body?.name ?? '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Give the set a name.');
  return name;
};

// ---------- general ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Re-evaluated per request so a changed Wi-Fi address is picked up without a restart.
app.get('/api/info', (req, res) => {
  const detect = process.env.LAN_DETECT !== 'false';
  res.json({ publicUrl: process.env.PUBLIC_URL || null, lanAddresses: detect ? lanAddresses() : [] });
});

// ---------- Immich ----------
// The API key stays on the server: it is never sent back, and players only see re-encoded pictures.

app.get('/api/immich', route(async (req, res) => {
  const client = immich.client();
  if (!client) return res.json({ connected: false, fromEnv: false });
  const base = { connected: true, fromEnv: immich.fromEnv, url: client.url };
  try {
    res.json({ ...base, ...(await client.status()) });
  } catch (err) {
    if (!(err instanceof ImmichError)) throw err;
    res.json({ ...base, error: err.message });
  }
}));

app.put('/api/immich', route(async (req, res) => {
  if (immich.fromEnv) throw new HttpError(409, 'Immich is set up through IMMICH_URL and IMMICH_API_KEY on the server.');
  const apiKey = String(req.body?.apiKey ?? '').trim();
  if (!apiKey) throw new HttpError(400, 'Paste an API key from Immich (Account Settings → API Keys).');
  const client = new ImmichClient({ url: req.body?.url, apiKey });
  const status = await client.status();
  if (status.missing.length) {
    throw new HttpError(400, `The API key needs these permissions too: ${status.missing.join(', ')}.`);
  }
  immich.save({ url: client.url, apiKey });
  res.json({ connected: true, fromEnv: false, ...status });
}));

app.delete('/api/immich', (req, res) => {
  if (immich.fromEnv) throw new HttpError(409, 'Immich is set up through IMMICH_URL and IMMICH_API_KEY on the server.');
  immich.clear();
  res.status(204).end();
});

app.get('/api/immich/albums', route(async (req, res) => {
  const client = immich.client();
  if (!client) throw new HttpError(409, 'Immich is not connected.');
  res.json(await client.albums());
}));

// ---------- picture sets ----------

app.get('/api/sets', (req, res) => {
  res.json(store.list().map(({ id, name, createdAt, images, map, fromGame }) => ({
    id,
    name,
    createdAt,
    fromGame: fromGame ?? null,
    customMap: Boolean(map),
    imageCount: images.length,
    locatedCount: images.filter(isLocated).length,
    datedCount: images.filter(isDated).length,
    cover: images[0] ? `/api/sets/${id}/files/${images[0].file}` : null,
  })));
});

app.post('/api/sets', (req, res) => res.status(201).json(store.create(setName(req.body))));

app.post('/api/sets/import', zipUpload.single('file'), route(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a zip file exported from a picture set.');
  res.status(201).json(await store.importZip(req.file.buffer));
}));

app.get('/api/sets/:id', (req, res) => res.json(requireSet(req.params.id)));

app.patch('/api/sets/:id', (req, res) => {
  requireSet(req.params.id);
  if ('name' in req.body) store.rename(req.params.id, setName(req.body));
  if ('metersWide' in req.body) {
    const meters = req.body.metersWide === null || req.body.metersWide === '' ? null : Number(req.body.metersWide);
    if (meters !== null && !(meters > 0 && meters < 1e7)) throw new HttpError(400, 'Enter the map width in meters.');
    store.setMapWidth(req.params.id, meters);
  }
  res.json(store.get(req.params.id));
});

app.delete('/api/sets/:id', (req, res) => {
  if (!store.delete(req.params.id)) throw notFound();
  res.status(204).end();
});

app.get('/api/sets/:id/export', (req, res) => {
  const out = store.exportZip(req.params.id);
  if (!out) throw notFound();
  const filename = out.name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'picture-set';
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}.zip"` });
  res.send(out.zip);
});

app.put('/api/sets/:id/map', photoUpload.single('image'), route(async (req, res) => {
  requireSet(req.params.id);
  if (!req.file) throw new HttpError(400, 'Choose an image for the map.');
  const map = await processImage(req.file.buffer, { maxEdge: 4096, quality: 90 });
  res.json(store.setMap(req.params.id, map));
}));

app.delete('/api/sets/:id/map', (req, res) => {
  requireSet(req.params.id);
  res.json(store.setMap(req.params.id, null));
});

app.post('/api/sets/:id/images', photoUpload.single('image'), route(async (req, res) => {
  const set = requireSet(req.params.id);
  const patch = parsePatch(set, req.body);
  const image = store.addImage(set.id, { buffer: await readPhoto(req), ...patch });
  res.status(201).json(image);
}));

// Bulk edit: { ids: [...], lat, lng, takenAt, caption } (any subset of the fields)
app.patch('/api/sets/:id/images', (req, res) => {
  const set = requireSet(req.params.id);
  res.json(store.updateImages(set.id, ids(req.body.ids), parsePatch(set, req.body)));
});

app.post('/api/sets/:id/images/delete', (req, res) => {
  requireSet(req.params.id);
  res.json({ deleted: store.deleteImages(req.params.id, ids(req.body.ids)) });
});

app.patch('/api/sets/:id/images/:imageId', (req, res) => {
  const set = requireSet(req.params.id);
  const [image] = store.updateImages(set.id, [req.params.imageId], parsePatch(set, req.body));
  if (!image) throw notFound('Picture');
  res.json(image);
});

app.delete('/api/sets/:id/images/:imageId', (req, res) => {
  if (!store.deleteImages(req.params.id, [req.params.imageId])) throw notFound('Picture');
  res.status(204).end();
});

app.get('/api/sets/:id/files/:file', (req, res, next) => {
  const file = store.filePath(req.params.id, req.params.file);
  if (!file) throw notFound('Picture');
  res.sendFile(file, { maxAge: '1d' }, (err) => err && !res.headersSent && next(notFound('Picture')));
});

// ---------- games ----------
// Players only learn a game code, never the set id, and only rounds that already started are served.

const requireGame = (code) => games.get(String(code).toUpperCase()) ?? (() => { throw notFound('Game'); })();

app.get('/api/games/:code/images/:index/:slot?', route(async (req, res) => {
  const game = requireGame(req.params.code);
  const { index, slot = 0 } = /** @type {{index: string, slot?: string}} */ (req.params);
  const image = game.imageFor(Number(index), Number(slot));
  if (!image) throw notFound('Picture');
  const out = await sources.file(game, image);
  if ('file' in out) return res.sendFile(out.file, { maxAge: '1h' });
  res.set('Cache-Control', 'private, max-age=3600').type('jpeg').send(out.buffer);
}));

app.get('/api/games/:code/map', (req, res) => {
  const game = requireGame(req.params.code);
  const map = game.settings.setId ? store.get(game.settings.setId)?.map : null;
  if (!map) throw notFound('Map');
  res.sendFile(store.filePath(game.settings.setId, map.file), { maxAge: '1h' });
});

// ----- pictures players add to a players-bring-photos game -----
// The player id from joining acts as the key; players only ever see their own pictures here.

function contributor(req, { changing = false } = {}) {
  const game = requireGame(req.params.code);
  if (game.settings.source !== 'players') throw new HttpError(400, 'Players can’t add pictures to this game.');
  // <img> tags can't send headers, so picture files also accept ?player=
  const playerId = String(req.get('x-player-id') ?? req.query.player ?? '');
  if (!game.isMember(playerId)) throw new HttpError(403, 'Join the game first.');
  if (changing && game.phase !== PHASES.LOBBY) throw new HttpError(409, 'The game has started; pictures can only be changed in the lobby.');
  return { game, playerId };
}

const ownImage = (game, playerId, imageId) => {
  const image = store.get(game.settings.setId)?.images.find((i) => i.id === imageId && i.contributorId === playerId);
  if (!image) throw notFound('Picture');
  return image;
};

app.get('/api/games/:code/photos', (req, res) => {
  const { game, playerId } = contributor(req);
  res.json((store.get(game.settings.setId)?.images ?? []).filter((i) => i.contributorId === playerId));
});

app.post('/api/games/:code/photos', photoUpload.single('image'), route(async (req, res) => {
  const { game, playerId } = contributor(req, { changing: true });
  const set = requireSet(game.settings.setId);
  const patch = parsePatch(set, req.body);
  const image = store.addImage(set.id, {
    buffer: await readPhoto(req), ...patch, contributorId: playerId, contributor: game.nameOf(playerId),
  });
  refreshContributions(game);
  res.status(201).json(image);
}));

app.patch('/api/games/:code/photos/:imageId', (req, res) => {
  const { game, playerId } = contributor(req, { changing: true });
  ownImage(game, playerId, req.params.imageId);
  const [image] = store.updateImages(game.settings.setId, [req.params.imageId], parsePatch(requireSet(game.settings.setId), req.body));
  refreshContributions(game);
  res.json(image);
});

app.delete('/api/games/:code/photos/:imageId', (req, res) => {
  const { game, playerId } = contributor(req, { changing: true });
  ownImage(game, playerId, req.params.imageId);
  store.deleteImages(game.settings.setId, [req.params.imageId]);
  refreshContributions(game);
  res.status(204).end();
});

app.get('/api/games/:code/photos/:imageId/file', (req, res) => {
  const { game, playerId } = contributor(req);
  const image = ownImage(game, playerId, req.params.imageId);
  res.sendFile(store.filePath(game.settings.setId, image.file), { maxAge: '1d' });
});

// ---------- errors ----------

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err instanceof HttpError || err instanceof ImmichError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ImageError || err instanceof SetError || err instanceof GameError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    saveNow();
    process.exit(0);
  });
}

server.listen(PORT, () => console.log(`geo-guessr server listening on :${PORT}, data in ${DATA_DIR}`));
