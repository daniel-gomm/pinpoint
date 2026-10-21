// A stand-in for the parts of the Immich API the game uses, for unit and browser tests.
import http from 'node:http';
import sharp from 'sharp';

export const ALBUM = '11111111-1111-4111-8111-111111111111';
export const PARTNER = '22222222-2222-4222-8222-222222222222';
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const asset = (n, { lat = 52 + n / 10, lng = 4 + n / 10, at = `2020-0${1 + (n % 9)}-1${n % 10}T1${n % 10}:30:00.000Z`, make = 'Canon', shared = false } = {}) => ({
  id: id(n), type: 'IMAGE', localDateTime: at, shared,
  exifInfo: { latitude: lat, longitude: lng, make, city: `City ${n}`, country: 'Netherlands', description: '' },
});

/** A tiny stand-in for the Immich endpoints the game uses. */
export async function fakeImmich({ assets, partnerAssets = [], permissions = ['asset.read', 'asset.view', 'album.read'], port = 0 }) {
  const byId = new Map([...assets, ...partnerAssets].map((a) => [a.id, a]));
  /** A timeline as Immich sends it: months, and one month's pictures as columns. */
  const timeline = (params) => (params.get('userId') === PARTNER ? partnerAssets : assets.filter((a) => !a.shared))
    .filter((a) => params.get('isFavorite') !== 'true' || a.isFavorite);
  const month = (a) => `${a.localDateTime.slice(0, 7)}-01`;
  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a6' } }).jpeg().toBuffer();
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const json = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.headers['x-api-key'] !== 'secret') return json(401, { message: 'Invalid API key' });
      if (req.url === '/api/server/version') return json(200, { major: 3, minor: 2, patch: 2 });
      if (req.url === '/api/users/me') return json(200, { name: 'Daniel', email: 'd@example.org' });
      if (req.url === '/api/api-keys/me') return json(200, { permissions });
      if (req.url?.startsWith('/api/albums?shared')) return json(200, [{ id: ALBUM, albumName: 'Trip', assetCount: assets.length }]);
      if (req.url === '/api/albums') return json(200, [{ id: ALBUM, albumName: 'Trip', assetCount: assets.length }, { id: id(99), albumName: 'Empty', assetCount: 0 }]);
      if (req.url === `/api/albums/${ALBUM}`) return json(200, { id: ALBUM, albumName: 'Trip' });
      if (req.url?.startsWith('/api/albums/')) return json(400, { message: 'Not found or no album.read access' });
      // Like Immich, random search skips pictures other people shared in an album.
      const url = new URL(req.url ?? '/', 'http://fake');
      if (url.pathname === '/api/partners') {
        if (!permissions.includes('partner.read')) return json(403, { message: 'Missing required permission: partner.read' });
        return json(200, partnerAssets.length ? [{ id: PARTNER, name: 'Aymara', email: 'a@example.org', inTimeline: false }] : []);
      }
      if (url.pathname === '/api/timeline/buckets') {
        const counts = new Map();
        for (const a of timeline(url.searchParams)) counts.set(month(a), (counts.get(month(a)) ?? 0) + 1);
        return json(200, [...counts].map(([timeBucket, count]) => ({ timeBucket, count })));
      }
      if (url.pathname === '/api/timeline/bucket') {
        const items = timeline(url.searchParams).filter((a) => month(a) === url.searchParams.get('timeBucket'));
        return json(200, {
          id: items.map((a) => a.id),
          isImage: items.map((a) => a.type === 'IMAGE'),
          isTrashed: items.map(() => false),
          city: items.map((a) => (a.exifInfo.latitude == null ? null : a.exifInfo.city)),
          fileCreatedAt: items.map((a) => a.localDateTime.slice(0, 19)),
          localOffsetHours: items.map(() => 0),
        });
      }
      if (req.url === '/api/search/random') return json(200, assets.filter((a) => !a.shared));
      if (req.url === '/api/search/metadata') return json(200, { assets: { items: assets, total: assets.length, count: assets.length, nextPage: null } });
      if (/\/api\/assets\/.+\/thumbnail\?size=preview/.test(req.url ?? '')) return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg);
      const single = /^\/api\/assets\/([^/]+)$/.exec(url.pathname);
      if (single && byId.has(single[1])) return json(200, byId.get(single[1]));
      json(404, { message: 'Not found' });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${address.port}`, calls, close: () => server.close() };
}
