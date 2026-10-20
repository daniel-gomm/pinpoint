import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ImmichClient, ImmichConfig, normalizeUrl } from '../src/immich.js';
import { createSources, spreadOut } from '../src/sources.js';
import { Game } from '../src/game.js';
import { cleanSettings } from '../src/socket.js';
import { fakeImmich, ALBUM, id, asset } from './fake-immich.js';

function tempConfig(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-test-'));
  const config = new ImmichConfig(dir, {});
  if (url) config.save({ url, apiKey: 'secret' });
  return { config, dir };
}

test('normalizes the Immich address', () => {
  assert.equal(normalizeUrl('https://photos.example.org/'), 'https://photos.example.org');
  assert.equal(normalizeUrl('http://10.0.0.2:2283/api/'), 'http://10.0.0.2:2283');
  assert.throws(() => normalizeUrl('photos.example.org'), /address of your Immich server/);
  assert.throws(() => normalizeUrl('ftp://x'), /http:\/\/ or https:\/\//);
});

test('connection status, permissions and readable errors', async (t) => {
  const immich = await fakeImmich({ assets: [], permissions: ['asset.read'] });
  t.after(immich.close);
  const status = await new ImmichClient({ url: immich.url, apiKey: 'secret' }).status();
  assert.deepEqual(status, { url: immich.url, version: '3.2.2', user: 'Daniel', missing: ['asset.view', 'album.read'] });
  await assert.rejects(new ImmichClient({ url: immich.url, apiKey: 'wrong' }).status(), /did not accept the API key/);
  await assert.rejects(new ImmichClient({ url: 'http://127.0.0.1:1', apiKey: 'x' }).status(), /Could not reach Immich/);
});

test('albums: own and shared, without duplicates or empty ones', async (t) => {
  const immich = await fakeImmich({ assets: [asset(1)] });
  t.after(immich.close);
  const albums = await new ImmichClient({ url: immich.url, apiKey: 'secret' }).albums();
  assert.deepEqual(albums.map((a) => [a.name, a.count]), [['Trip', 1]]);
});

test('the key is stored only on the server, readable by its user', () => {
  const { config, dir } = tempConfig('http://immich.local:2283/');
  assert.equal(config.client()?.url, 'http://immich.local:2283');
  assert.equal(fs.statSync(path.join(dir, 'immich.json')).mode & 0o077, 0);
  assert.equal(new ImmichConfig(dir, { IMMICH_URL: 'http://env:1', IMMICH_API_KEY: 'k' }).client()?.url, 'http://env:1');
  config.clear();
  assert.equal(new ImmichConfig(dir, {}).client(), null);
});

test('pool: pictures from an album, as game records', async (t) => {
  const assets = [
    ...Array.from({ length: 8 }, (_, i) => asset(i)),
    asset(20, { make: null }), // screenshot
    asset(21, { lat: null, lng: null }),
    asset(22, { lat: 0, lng: 0 }), // "null island": a broken GPS fix
  ];
  const immich = await fakeImmich({ assets });
  t.after(immich.close);
  const { config } = tempConfig(immich.url);
  const sources = createSources({ store: /** @type {any} */ ({}), immich: config });

  const settings = cleanSettings({ source: 'immich', mode: 'location', rounds: 3, immich: { albumId: ALBUM, favorites: true, from: '2020-01-01' } });
  assert.deepEqual(settings.immich, { albumId: ALBUM, favorites: true, cameraOnly: true, from: '2020-01-01', to: null });
  const { set, images } = await sources.pool(settings);
  assert.equal(set.name, 'Trip (favourites)');
  assert.equal(images.length, 10, 'the screenshot is skipped');
  const one = images.find((i) => i.id === id(3));
  assert.deepEqual(one, {
    id: id(3), lat: 52.3, lng: 4.3, takenAt: '2020-04-13T13:30', caption: 'City 3, Netherlands', link: `${immich.url}/photos/${id(3)}`,
  });
  assert.equal(images.find((i) => i.id === id(22))?.lat, null);

  const search = immich.calls.find((c) => c.url === '/api/search/random');
  assert.deepEqual(search?.body, {
    type: 'IMAGE', withExif: true, visibility: 'timeline', size: 1000,
    albumIds: [ALBUM], isFavorite: true, takenAfter: '2020-01-01T00:00:00.000Z',
  });

  await assert.rejects(sources.pool({ ...settings, immich: { ...settings.immich, albumId: id(5) } }), /album no longer exists/);
});

test('bursts: one picture per hour', () => {
  const shots = ['2021-05-01T10:00', '2021-05-01T10:01', '2021-05-01T10:59', '2021-05-01T11:00', null]
    .map((takenAt, i) => ({ id: `p${i}`, takenAt }));
  assert.equal(spreadOut(shots).length, 3);
});

test('a game on Immich pictures: previews fetched once, links only for the host', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const immich = await fakeImmich({ assets: Array.from({ length: 6 }, (_, i) => asset(i)) });
  t.after(immich.close);
  const { config } = tempConfig(immich.url);
  const sources = createSources({ store: /** @type {any} */ ({}), immich: config });
  const settings = cleanSettings({ source: 'immich', mode: 'date', rounds: 2, immich: {} });
  const game = new Game({ code: 'IMMI', settings });
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');
  game.start(host.id, await sources.pool(settings));
  assert.equal(game.setName, 'Immich library');

  sources.prefetch(game);
  const image = game.imageFor(0);
  const first = await sources.file(game, image);
  const again = await sources.file(game, image);
  assert.ok('buffer' in first && 'buffer' in again);
  assert.equal(first.buffer, again.buffer);
  const metadata = await sharp(first.buffer).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(immich.calls.filter((c) => c.url?.includes(`/assets/${image.id}/thumbnail`)).length, 1);

  game.endRoundEarly(host.id);
  assert.deepEqual(game.snapshot(host.id).reveal?.links, [image.link]);
  assert.equal(game.snapshot(guest.id).reveal?.links, null);
  assert.equal(JSON.stringify(game.snapshot(guest.id)).includes(immich.url), false, 'players never see the Immich address');
});
