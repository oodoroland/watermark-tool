'use strict';
const sharp = require('sharp');

// Keep libvips from hoarding RAM on a server; tune per box.
sharp.cache({ memory: 64, files: 0, items: 50 });

const POSITIONS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br', 'tile', 'custom'];
const FORMATS = ['original', 'jpeg', 'png', 'webp'];
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const MAX_MEGAPIXELS = Number(process.env.MAX_MEGAPIXELS || 50);
const MAX_INPUT_PIXELS = MAX_MEGAPIXELS * 1e6; // decompression-bomb guard
const JOB_TIMEOUT_SECONDS = Number(process.env.JOB_TIMEOUT_SECONDS || 30);

/** An error whose message is safe and useful to show the visitor. Anything else gets a generic message. */
class UserError extends Error {}

const clamp = (n, lo, hi, d) => {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** Validate + normalise untrusted options. Every size is RELATIVE to the base image width. */
function normalizeOptions(raw = {}) {
  const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.color || '') ? raw.color : '#ffffff';
  return {
    type: raw.type === 'image' ? 'image' : 'text',
    text: String(raw.text ?? '© Your Brand').slice(0, 80) || '©',
    color,
    bold: raw.bold !== false && raw.bold !== 'false',
    font: ['DejaVu Sans', 'Poppins', 'Inter', 'sans-serif'].includes(raw.font) ? raw.font : 'sans-serif',
    opacity: clamp(raw.opacity, 0.02, 1, 0.5),
    size: clamp(raw.size, 2, 100, 30), // watermark width, % of image width
    angle: clamp(raw.angle, -180, 180, 0),
    position: POSITIONS.includes(raw.position) ? raw.position : 'br',
    margin: clamp(raw.margin, 0, 30, 3), // % of image width
    x: clamp(raw.x, 0, 100, 50), // custom: centre of mark, % of width
    y: clamp(raw.y, 0, 100, 50), // custom: centre of mark, % of height
    gap: clamp(raw.gap, 0, 100, 25), // tile spacing, % of mark width
    format: FORMATS.includes(raw.format) ? raw.format : 'original',
    quality: Math.round(clamp(raw.quality, 40, 100, 85)),
  };
}

/** Render text once at a large size and trim to its tight bounds (transparent PNG). */
async function renderText(o) {
  const fontSize = 240;
  const w = Math.ceil(o.text.length * fontSize * 0.95) + 200;
  const h = fontSize * 3;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<text x="100" y="${fontSize * 1.8}" font-family="${o.font}, DejaVu Sans, sans-serif" ` +
    `font-size="${fontSize}" font-weight="${o.bold ? 700 : 400}" fill="${o.color}">${escapeXml(o.text)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().trim().toBuffer();
}

/** Build the final overlay (text or logo): resized -> opacity -> rotated -> fitted -> padded for tiling. */
async function buildMark(o, baseW, baseH, logo) {
  if (o.type === 'image' && !logo) throw new UserError('Choose a logo file first.');
  const raw = o.type === 'image' ? await sharp(logo, { limitInputPixels: MAX_INPUT_PIXELS }).png().toBuffer() : await renderText(o);

  const targetW = Math.max(8, Math.round((baseW * o.size) / 100));
  let mark = await sharp(raw)
    .resize({ width: targetW })
    .ensureAlpha()
    .linear([1, 1, 1, o.opacity], [0, 0, 0, 0]) // scale alpha channel only
    .png()
    .toBuffer();

  if (o.angle) mark = await sharp(mark).rotate(o.angle, { background: TRANSPARENT }).png().toBuffer();

  // overlay must not exceed the base image
  let m = await sharp(mark).metadata();
  if (m.width > baseW || m.height > baseH) {
    mark = await sharp(mark).resize({ width: baseW, height: baseH, fit: 'inside' }).png().toBuffer();
    m = await sharp(mark).metadata();
  }

  if (o.position === 'tile') {
    const pad = Math.round((m.width * o.gap) / 200);
    mark = await sharp(mark).extend({ top: pad, bottom: pad, left: pad, right: pad, background: TRANSPARENT }).png().toBuffer();
    m = await sharp(mark).metadata();
    return { input: mark, tile: true, left: 0, top: 0, _w: m.width, _h: m.height };
  }

  const mg = Math.round((baseW * o.margin) / 100);
  const W = m.width, H = m.height;
  const col = { l: mg, c: Math.round((baseW - W) / 2), r: baseW - W - mg };
  const row = { t: mg, m: Math.round((baseH - H) / 2), b: baseH - H - mg };
  let left, top;
  if (o.position === 'custom') {
    left = Math.round((baseW * o.x) / 100 - W / 2);
    top = Math.round((baseH * o.y) / 100 - H / 2);
  } else {
    const [r, c] = { tl: ['t', 'l'], tc: ['t', 'c'], tr: ['t', 'r'], ml: ['m', 'l'], c: ['m', 'c'], mr: ['m', 'r'], bl: ['b', 'l'], bc: ['b', 'c'], br: ['b', 'r'] }[o.position];
    left = col[c];
    top = row[r];
  }
  left = Math.min(Math.max(0, left), Math.max(0, baseW - W));
  top = Math.min(Math.max(0, top), Math.max(0, baseH - H));
  return { input: mark, left, top, _w: W, _h: H };
}

/**
 * Watermark one image.
 * @param {string|Buffer} input  file path (preferred for big files) or buffer
 * @returns {{data: Buffer, ext: string, mime: string}}
 */
async function watermarkImage(input, rawOpts, logo, options) {
  try {
    return await renderWatermark(input, rawOpts, logo, options);
  } catch (e) {
    if (e instanceof UserError) throw e;
    if (/pixel limit/i.test(e.message)) throw new UserError(`Image is too large (max ${MAX_MEGAPIXELS} megapixels).`);
    if (/timeout/i.test(e.message)) throw new UserError('This image took too long to process.');
    throw e;
  }
}

async function renderWatermark(input, rawOpts, logo, { maxWidth } = {}) {
  const o = normalizeOptions(rawOpts);
  const opts = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' };

  const meta = await sharp(input, opts).metadata();

  if (!meta.width || !meta.height) throw new UserError('Unreadable image.');
  const swap = meta.orientation >= 5; // EXIF-rotated phone photos
  let baseW = swap ? meta.height : meta.width;
  let baseH = swap ? meta.width : meta.height;

  let pipe = sharp(input, opts).rotate(); // apply EXIF orientation, then strip it
  if (maxWidth && baseW > maxWidth) {
    baseH = Math.round((baseH * maxWidth) / baseW);
    baseW = maxWidth;
    pipe = pipe.resize({ width: maxWidth });
  }

  const { _w, _h, ...entry } = await buildMark(o, baseW, baseH, logo);
  pipe = pipe.composite([entry]);

  let fmt = o.format === 'original' ? meta.format : o.format;
  if (!['jpeg', 'png', 'webp'].includes(fmt)) fmt = 'png'; // gif/tiff/avif/heif -> png
  if (fmt === 'jpeg') pipe = pipe.jpeg({ quality: o.quality, mozjpeg: true });
  else if (fmt === 'webp') pipe = pipe.webp({ quality: o.quality });
  else pipe = pipe.png({ compressionLevel: 8 });

  const data = await pipe.timeout({ seconds: JOB_TIMEOUT_SECONDS }).toBuffer();
  return { data, ext: fmt === 'jpeg' ? 'jpg' : fmt, mime: `image/${fmt}` };
}

module.exports = { watermarkImage, normalizeOptions, UserError };
