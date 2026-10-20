import sharp from 'sharp';
import heicConvert from 'heic-convert';

export class ImageError extends Error {}

// HEIC/HEIF (iPhone photos) start with an ISO-BMFF "ftyp" box. The prebuilt sharp can't decode HEVC.
const isIsoBmff = (buffer) => buffer.length > 12 && buffer.toString('latin1', 4, 8) === 'ftyp';

/**
 * Normalises an uploaded picture: applies the EXIF rotation, shrinks it and re-encodes it as JPEG.
 * Re-encoding drops all metadata, so players can't read GPS or date from the file.
 * @returns {Promise<{buffer: Buffer, width: number, height: number}>}
 */
export async function processImage(input, { maxEdge = 2400, quality = 85 } = {}) {
  const encode = (source) => sharp(source, { failOn: 'error' })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  let result;
  try {
    result = await encode(input);
  } catch (err) {
    if (!isIsoBmff(input)) throw new ImageError('That file is not a picture we can read.');
    try {
      result = await encode(await heicConvert({ buffer: input, format: 'JPEG', quality: 0.92 }));
    } catch {
      throw new ImageError('That HEIC picture could not be converted.');
    }
  }
  return { buffer: result.data, width: result.info.width, height: result.info.height };
}
