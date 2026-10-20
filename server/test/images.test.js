import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { processImage, ImageError } from '../src/images.js';

test('uploads are rotated upright, shrunk and stripped of metadata', async () => {
  // 400x200 landscape stored with "rotate 90°" orientation and a GPS-bearing EXIF block
  const input = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: '#c33' } })
    .withExif({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 22/1 0/1' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  assert.ok((await sharp(input).metadata()).exif, 'fixture has EXIF');

  const out = await processImage(input);
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([out.width, out.height], [1200, 2400], 'rotated to portrait and fitted in 2400 px');
  assert.equal(meta.exif, undefined, 'no EXIF left (no GPS, no date)');
});

test('PNG with transparency becomes a JPEG on white', async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const out = await processImage(png);
  const { data } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240, 'flattened onto white');
});

test('non-images are rejected', async () => {
  await assert.rejects(processImage(Buffer.from('not an image at all')), ImageError);
});

// Needs a real HEIC photo, e.g. libheif's examples/example.heic: HEIC_SAMPLE=path npm test
test('HEIC (iPhone) photos are converted', { skip: !process.env.HEIC_SAMPLE && 'set HEIC_SAMPLE to run' }, async () => {
  const out = await processImage(fs.readFileSync(process.env.HEIC_SAMPLE));
  assert.equal((await sharp(out.buffer).metadata()).format, 'jpeg');
});
