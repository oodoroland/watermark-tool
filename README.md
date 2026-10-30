# Watermark Studio

Node.js + sharp web tool: watermark one image or a batch (up to 50), download the image or a ZIP.

## Run

```bash
npm install
npm start            # http://localhost:3000/watermark
```

| Env var | Default | What it does |
|---|---|---|
| `PORT` | 3000 | |
| `MAX_FILES` | 20 | Images per export. The page's meta description says "up to 20"; update it if you change this. |
| `MAX_FILE_MB` | 15 | Per file |
| `MAX_MEGAPIXELS` | 50 | Larger images are refused (memory guard) |
| `CONCURRENCY` | min(2, CPUs) | Images processed at once, across all visitors |
| `MAX_QUEUED_JOBS` | 60 | Images allowed to wait; beyond that requests get 503 "busy" |
| `JOB_TIMEOUT_SECONDS` | 30 | Per image |
| `PREVIEW_LIMIT_PER_5MIN` | 300 | Previews per IP |
| `EXPORT_LIMIT_PER_15MIN` | 20 | Exports per IP |
| `TRUST_PROXY` | loopback | Which proxy to trust for the visitor IP. Nginx on the same host: leave it. In Docker behind one proxy: `1`. |

Docker (includes fonts, which text watermarks need on slim images):

```bash
docker build -t watermark-tool . && docker run -p 3000:3000 watermark-tool
```

## Features

- Text or logo watermark; colour, opacity, size (relative to image width), rotation -180..180
- 9 grid positions, tiled across the image, or custom (click on the preview)
- Live preview on a downscaled copy; export is full resolution
- Output: keep original format, or JPEG / PNG / WebP with quality
- EXIF orientation respected; metadata stripped

## API

`POST /api/watermark` multipart: `images` (1..50 files), optional `logo`, `options` (JSON string).
One image returns the image; several return `watermarked.zip` (failures listed in `errors.txt`).
`POST /api/preview` same fields, returns a max-1000px JPEG.

Options: `type` text|image, `text`, `font`, `color` (#hex), `bold`, `size` (% of width),
`opacity` (0-1), `angle`, `position` (tl tc tr ml c mr bl bc br tile custom), `margin`, `gap`, `x`, `y`,
`format`, `quality`.

## Production

Built in: per-IP rate limits, a global processing limit with a bounded queue (503 when full),
per-image timeout and pixel limit, security headers (helmet, strict CSP), generic error messages
for visitors (details go to the server log), graceful shutdown, and uploads deleted after each request.

Served at `https://tools.oodoroland.com/watermark` (`/` redirects there). Behind Nginx:

```nginx
server {
    server_name tools.oodoroland.com;
    client_max_body_size 320m;          # MAX_FILES x MAX_FILE_MB + a logo
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;        # big batches
        proxy_request_buffering off;    # stream uploads to Node instead of buffering them in Nginx
    }
}
```

The rate limits key on the visitor IP, so `TRUST_PROXY` must match your setup. If every visitor
appears as the same IP, they all share one limit.

Run it on a different box or container from the main site's API if you can: a busy day here should
not slow the main site down. For high volume, move processing to a job queue (BullMQ) and workers.
# watermark-tool
