import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { SetStore, SetError } from '../src/sets.js';

const tmpStore = () => new SetStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pinpoint-')));
const jpeg = (color) => sharp({ create: { width: 20, height: 10, channels: 3, background: color } }).jpeg().toBuffer();

test('bulk updates and deletes', async () => {
  const store = tmpStore();
  const set = store.create('Trip');
  const ids = [];
  for (const c of ['#f00', '#0f0', '#00f']) ids.push(store.addImage(set.id, { buffer: await jpeg(c) }).id);
  const changed = store.updateImages(set.id, ids.slice(0, 2), { takenAt: '2020-01-01T10:00', lat: 1, lng: 2 });
  assert.equal(changed.length, 2);
  assert.deepEqual(store.get(set.id).images.map((i) => i.takenAt), ['2020-01-01T10:00', '2020-01-01T10:00', null]);
  assert.equal(store.deleteImages(set.id, [ids[0], 'nope']), 1);
  assert.equal(store.get(set.id).images.length, 2);
  assert.ok(!fs.existsSync(store.filePath(set.id, `${ids[0]}.jpg`)), 'file removed too');
});

test('switching to a custom map clears pin locations', async () => {
  const store = tmpStore();
  const set = store.create('Office');
  store.addImage(set.id, { buffer: await jpeg('#f00'), lat: 52, lng: 4 });
  store.setMap(set.id, { buffer: await jpeg('#fff'), width: 20, height: 10 });
  const after = store.get(set.id);
  assert.deepEqual(after.map, { file: 'map.jpg', width: 20, height: 10, metersWide: null });
  assert.equal(after.images[0].lat, null);
  store.setMapWidth(set.id, 35);
  assert.equal(store.get(set.id).map.metersWide, 35);
});

test('export and import round-trip a set, including its map', async () => {
  const store = tmpStore();
  const set = store.create('Holiday');
  store.setMap(set.id, { buffer: await jpeg('#fff'), width: 20, height: 10 });
  store.setMapWidth(set.id, 12);
  store.addImage(set.id, { buffer: await jpeg('#f00'), lat: 5, lng: 6, takenAt: '2021-05-05T05:05', caption: 'Beach' });

  const { zip, name } = store.exportZip(set.id);
  assert.equal(name, 'Holiday');
  const other = tmpStore();
  const imported = await other.importZip(zip);
  assert.notEqual(imported.id, set.id);
  assert.equal(imported.name, 'Holiday');
  assert.deepEqual(imported.map && [imported.map.width, imported.map.metersWide], [20, 12]);
  assert.deepEqual(
    imported.images.map(({ lat, lng, takenAt, caption }) => ({ lat, lng, takenAt, caption })),
    [{ lat: 5, lng: 6, takenAt: '2021-05-05T05:05', caption: 'Beach' }],
  );
  assert.ok(fs.existsSync(other.filePath(imported.id, imported.images[0].file)));
});

test('import rejects junk and cleans up after a bad picture', async () => {
  const store = tmpStore();
  await assert.rejects(store.importZip(Buffer.from('nope')), SetError);
  const bad = Buffer.from(zipSync({
    'set.json': strToU8(JSON.stringify({ name: 'Bad', images: [{ file: 'a.jpg' }] })),
    'a.jpg': strToU8('this is not a jpeg'),
  }));
  await assert.rejects(store.importZip(bad));
  assert.equal(store.list().length, 0, 'half-imported set removed');
});

test('reveal versions: guess on a crop, reveal the original, swap, remove, export', async () => {
  const store = tmpStore();
  const set = store.create('Party');
  const image = store.addImage(set.id, { buffer: await jpeg('#f00'), caption: 'Original' });
  const original = image.file;

  // a cropped version to guess on: the original moves to the reveal
  const cropped = store.addVersion(set.id, image.id, await jpeg('#0f0'), 'guess');
  assert.equal(cropped.revealFile, original);
  assert.notEqual(cropped.file, original);

  // replacing the guess picture again drops the previous crop, keeps the original
  const recropped = store.addVersion(set.id, image.id, await jpeg('#00f'), 'guess');
  assert.equal(recropped.revealFile, original);
  assert.ok(!fs.existsSync(store.filePath(set.id, cropped.file)), 'old crop removed');

  const swapped = store.swapVersions(set.id, image.id);
  assert.deepEqual([swapped.file, swapped.revealFile], [original, recropped.file]);

  const { zip } = store.exportZip(set.id);
  const other = tmpStore();
  const [copy] = (await other.importZip(zip)).images;
  assert.ok(copy.revealFile && fs.existsSync(other.filePath(other.list()[0].id, copy.revealFile)), 'reveal survives export');

  const removed = store.removeReveal(set.id, image.id);
  assert.equal(removed.revealFile, undefined);
  assert.ok(!fs.existsSync(store.filePath(set.id, recropped.file)));
  assert.equal(store.addVersion(set.id, 'nope', await jpeg('#fff'), 'reveal'), null);

  store.addVersion(set.id, image.id, await jpeg('#fff'), 'reveal');
  const files = () => fs.readdirSync(path.dirname(store.filePath(set.id, 'x.jpg'))).filter((f) => f.endsWith('.jpg'));
  assert.equal(files().length, 2);
  store.deleteImages(set.id, [image.id]);
  assert.equal(files().length, 0, 'both versions deleted with the picture');
});
