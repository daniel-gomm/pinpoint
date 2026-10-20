import http from 'node:http';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { SetStore, isImageType } from './sets.js';
import { setupSockets } from './socket.js';
import { lanAddresses } from './network.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';

const store = new SetStore(DATA_DIR);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
const games = setupSockets(io, store);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, isImageType(file.mimetype)),
});

app.use(express.json({ limit: '100kb' }));

const parseCoord = (value, limit) => {
  if (value === null || value === '' || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
};

const notFound = (res, what = 'Picture set') => res.status(404).json({ error: `${what} not found.` });

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Re-evaluated per request so a changed Wi-Fi address is picked up without a restart.
app.get('/api/info', (req, res) => {
  res.json({ publicUrl: process.env.PUBLIC_URL || null, lanAddresses: lanAddresses() });
});

app.get('/api/sets', (req, res) => {
  res.json(store.list().map(({ id, name, createdAt, images }) => ({
    id,
    name,
    createdAt,
    imageCount: images.length,
    locatedCount: images.filter((i) => i.lat !== null && i.lng !== null).length,
    cover: images[0] ? `/api/sets/${id}/files/${images[0].file}` : null,
  })));
});

app.post('/api/sets', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Give the set a name.' });
  res.status(201).json(store.create(name));
});

app.get('/api/sets/:id', (req, res) => {
  const set = store.get(req.params.id);
  return set ? res.json(set) : notFound(res);
});

app.patch('/api/sets/:id', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Give the set a name.' });
  const set = store.rename(req.params.id, name);
  return set ? res.json(set) : notFound(res);
});

app.delete('/api/sets/:id', (req, res) => {
  return store.delete(req.params.id) ? res.status(204).end() : notFound(res);
});

app.post('/api/sets/:id/images', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a JPEG, PNG, WebP, GIF or AVIF image.' });
  const lat = parseCoord(req.body.lat, 90);
  const lng = parseCoord(req.body.lng, 180);
  const image = store.addImage(req.params.id, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
    lat: lat ?? null,
    lng: lng ?? null,
    caption: String(req.body.caption ?? '').slice(0, 200),
  });
  return image ? res.status(201).json(image) : notFound(res);
});

app.patch('/api/sets/:id/images/:imageId', (req, res) => {
  const patch = {};
  if ('lat' in req.body || 'lng' in req.body) {
    patch.lat = parseCoord(req.body.lat, 90);
    patch.lng = parseCoord(req.body.lng, 180);
    if (patch.lat === undefined || patch.lng === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude are out of range.' });
    }
  }
  if ('caption' in req.body) patch.caption = String(req.body.caption ?? '').slice(0, 200);
  const image = store.updateImage(req.params.id, req.params.imageId, patch);
  return image ? res.json(image) : notFound(res, 'Picture');
});

app.delete('/api/sets/:id/images/:imageId', (req, res) => {
  return store.deleteImage(req.params.id, req.params.imageId) ? res.status(204).end() : notFound(res, 'Picture');
});

app.get('/api/sets/:id/files/:file', (req, res) => {
  const file = store.imagePath(req.params.id, req.params.file);
  if (!file) return notFound(res, 'Picture');
  res.sendFile(file, { maxAge: '1d' }, (err) => err && !res.headersSent && notFound(res, 'Picture'));
});

// Players only learn a game code, never the set id, and only rounds that already started are served.
app.get('/api/games/:code/images/:index', (req, res) => {
  const game = games.get(req.params.code.toUpperCase());
  const image = game?.imageForRound(Number(req.params.index));
  if (!image) return notFound(res, 'Picture');
  res.sendFile(store.imagePath(game.setId, image.file), { maxAge: '1h' });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That picture is larger than 15 MB.' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

server.listen(PORT, () => console.log(`geo-guessr server listening on :${PORT}, data in ${DATA_DIR}`));
