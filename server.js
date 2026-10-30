'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { watermarkImage, UserError } = require('./lib/watermark');
const { createJobLimiter } = require('./lib/job-limiter');

const env = (name, fallback) => Number(process.env[name] || fallback);

const PORT = env('PORT', 3001);
const MAX_FILES = env('MAX_FILES', 20);
const MAX_FILE_MB = env('MAX_FILE_MB', 15);
const PREVIEW_MAX_MB = 5; // the client sends a 1000px JPEG; anything bigger is not a real preview
const CONCURRENCY = env('CONCURRENCY', Math.max(1, Math.min(2, os.cpus().length)));
const MAX_QUEUED_JOBS = env('MAX_QUEUED_JOBS', 60);
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/tiff']);
const GENERIC_ERROR = "Couldn't process this image. Is it a valid JPEG, PNG, WebP, GIF, AVIF or TIFF?";

/* Which proxies to trust for the visitor's IP (rate limits key on it). "loopback" fits Nginx on the
   same host. Behind Docker or one other proxy, set TRUST_PROXY=1. Never trust more hops than you
   have: a client could then fake its IP and skip the rate limits. */
const parseTrustProxy = (v) => (v === undefined ? 'loopback' : /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v);

// Uploads go to disk, not RAM, so a batch can't blow up the heap. Own folder, emptied on start,
// so files from a crashed run don't pile up.
const UPLOAD_DIR = path.join(os.tmpdir(), 'watermark-tool');
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const makeUpload = (maxImages, maxMb) =>
  multer({
    storage: multer.diskStorage({ destination: UPLOAD_DIR }),
    limits: { files: maxImages + 1, fileSize: maxMb * 1024 * 1024, fields: 5, fieldSize: 16 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, ALLOWED.has(file.mimetype)),
  }).fields([{ name: 'images', maxCount: maxImages }, { name: 'logo', maxCount: 1 }]);
const exportUpload = makeUpload(MAX_FILES, MAX_FILE_MB);
const previewUpload = makeUpload(1, PREVIEW_MAX_MB);

const jobs = createJobLimiter({ concurrency: CONCURRENCY, maxQueued: MAX_QUEUED_JOBS });

const limitJson = (message) => (_req, res) => res.status(429).json({ error: message });
// Dragging a slider fires a preview every ~300ms, so previews get a much higher allowance than exports.
const previewLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: env('PREVIEW_LIMIT_PER_5MIN', 300),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: limitJson('Too many previews. Wait a minute and try again.'),
});
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env('EXPORT_LIMIT_PER_15MIN', 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: limitJson('Too many exports. Wait a few minutes and try again.'),
});

/** Refuse before the upload when the queue is already full, so we don't take in files we can't process. */
const rejectWhenBusy = (_req, res, next) =>
  jobs.canAccept(1) ? next() : res.status(503).set('Retry-After', '30').json({ error: 'Busy right now. Try again in a moment.' });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'blob:', 'data:'],
        'style-src': ["'self'"],
        'script-src': ["'self'", 'https://cloud.umami.is'],
        'connect-src': ["'self'", 'https://cloud.umami.is', 'https://api-gateway.umami.dev'],
      },
    },
  })
);

app.get('/', (_req, res) => res.redirect(302, '/watermark'));
app.get('/watermark', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.get('/health', (_req, res) => res.json({ ok: true, ...jobs.stats() }));
app.get('/api/config', (_req, res) => res.json({ maxFiles: MAX_FILES, maxFileMb: MAX_FILE_MB }));

const cleanup = (req) => {
  for (const f of Object.values(req.files || {}).flat()) fs.unlink(f.path, () => {});
};
const parseOptions = (req) => {
  try { return JSON.parse(req.body.options || '{}'); } catch { return {}; }
};
const readLogo = (req) => (req.files?.logo?.[0] ? fs.readFileSync(req.files.logo[0].path) : null);
const safeBase = (name) =>
  path.parse(name).name.replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'image';

/** The message a visitor sees. Unexpected errors are logged and replaced with a generic one. */
function publicMessage(e) {
  if (e instanceof UserError) return e.message;
  console.error('[watermark]', e);
  return GENERIC_ERROR;
}
const busy = (res) => res.status(503).set('Retry-After', '30').json({ error: 'Busy right now. Try again in a moment.' });

// Live preview: client sends a downscaled copy of the first image.
app.post('/api/preview', previewLimiter, rejectWhenBusy, previewUpload, async (req, res) => {
  try {
    const file = req.files?.images?.[0];
    if (!file) return res.status(400).json({ error: 'No image' });
    if (!jobs.canAccept(1)) return busy(res);
    const options = { ...parseOptions(req), format: 'jpeg', quality: 80 };
    const logo = readLogo(req);
    const { data, mime } = await jobs.run(() => watermarkImage(file.path, options, logo, { maxWidth: 1000 }));
    res.type(mime).send(data);
  } catch (e) {
    res.status(422).json({ error: publicMessage(e) });
  } finally {
    cleanup(req);
  }
});

// Single image -> the image. Multiple -> a ZIP (streamed as results complete).
app.post('/api/watermark', exportLimiter, rejectWhenBusy, exportUpload, async (req, res) => {
  const files = req.files?.images || [];
  try {
    if (!files.length) return res.status(400).json({ error: 'Upload at least one image (JPEG, PNG, WebP, GIF, AVIF or TIFF).' });
    if (!jobs.canAccept(files.length)) return busy(res);
    const opts = parseOptions(req);
    const logo = readLogo(req);

    if (files.length === 1) {
      const f = files[0];
      const { data, ext, mime } = await jobs.run(() => watermarkImage(f.path, opts, logo));
      res.set({ 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${safeBase(f.originalname)}-watermarked.${ext}"` });
      return res.send(data);
    }

    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="watermarked.zip"' });
    const zip = archiver('zip', { zlib: { level: 0 } }); // images are already compressed
    zip.on('error', () => res.destroy());
    zip.pipe(res);

    const used = new Set();
    const errors = [];
    // Queued together, so the whole batch is admitted or refused at once (checked above).
    await Promise.all(
      files.map((f) =>
        jobs
          .run(() => watermarkImage(f.path, opts, logo))
          .then(({ data, ext }) => {
            let name = `${safeBase(f.originalname)}-watermarked`, n = 1;
            while (used.has(`${name}.${ext}`)) name = `${safeBase(f.originalname)}-watermarked-${++n}`;
            used.add(`${name}.${ext}`);
            zip.append(data, { name: `${name}.${ext}` });
          })
          .catch((e) => errors.push(`${f.originalname}: ${publicMessage(e)}`))
          .finally(() => fs.unlink(f.path, () => {}))
      )
    );
    if (errors.length) zip.append(errors.join('\n'), { name: 'errors.txt' });
    await zip.finalize();
  } catch (e) {
    if (!res.headersSent) res.status(422).json({ error: publicMessage(e) });
    else res.destroy();
  } finally {
    cleanup(req);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_FILE_MB} MB).`
      : err.code === 'LIMIT_FILE_COUNT' || (err.code === 'LIMIT_UNEXPECTED_FILE' && err.field === 'images') ? `Too many files (max ${MAX_FILES}).`
      : 'Invalid upload.';
    return res.status(400).json({ error: msg });
  }
  console.error('[watermark]', err);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

const server = app.listen(PORT, () =>
  console.log(`Watermark tool on http://localhost:${PORT}/watermark  (concurrency ${CONCURRENCY}, max ${MAX_FILES} files × ${MAX_FILE_MB} MB)`)
);
// A slow upload of a full batch can take minutes; a stalled one should not hold a socket forever.
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 60 * 1000;

// On deploy/restart: stop taking new requests, let running exports finish, then exit.
const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
