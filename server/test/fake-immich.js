// A stand-in for the parts of the Immich API the game uses, for unit and browser tests.
import http from 'node:http';
import sharp from 'sharp';

export const ALBUM = '11111111-1111-4111-8111-111111111111';
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const asset = (n, { lat = 52 + n / 10, lng = 4 + n / 10, at = `2020-0${1 + (n % 9)}-1${n % 10}T1${n % 10}:30:00.000Z`, make = 'Canon' } = {}) => ({
  id: id(n), type: 'IMAGE', localDateTime: at,
  exifInfo: { latitude: lat, longitude: lng, make, city: `City ${n}`, country: 'Netherlands', description: '' },
});

/** A tiny stand-in for the Immich endpoints the game uses. */
export async function fakeImmich({ assets, permissions = ['asset.read', 'asset.view', 'album.read'], port = 0 }) {
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
      if (req.url === '/api/search/random') return json(200, assets);
      if (/\/api\/assets\/.+\/thumbnail\?size=preview/.test(req.url ?? '')) return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg);
      json(404, { message: 'Not found' });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${address.port}`, calls, close: () => server.close() };
}
