# Deployment

## Platform: Vercel

Triển khai từ thư mục `work/camera-giaothong` (không deploy cả repo hunter).

## URL

Điền sau lần `vercel --prod` đầu tiên.

## Deploy command

```sh
cd work/camera-giaothong
vercel link --yes --project camera-giaothong
vercel --prod --yes
```

Local: `npm start` rồi mở http://127.0.0.1:8765/camera-traffic.html.

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `NDAMAPS_API_KEY` | for map/search | Server-only. Never expose to the browser. |
| `ALLOWED_HOST` | custom domain | Hostname only, e.g. `cameras.example`. |
| `FFMPEG_PATH` | optional | Default `ffmpeg`. Hobby Vercel has no ffmpeg; HN JPEG/live return 503. |
| `VERCEL` | set by Vercel | Enables the deployment host allowlist. |

```sh
printf '%s' "$NDAMAPS_API_KEY" | vercel env add NDAMAPS_API_KEY production preview development --yes
```

Do not print the key. `ALLOWED_HOST` is only needed for a custom domain.

## What works on Vercel

- Map (if `NDAMAPS_API_KEY` is set), HCM snapshots (Notis), HN catalog.
- HN JPEG/live need ffmpeg on the host. Without it the UI still lists cameras; snapshot/live show the existing 503 copy.

## Custom domain

Set the domain in Vercel, then `ALLOWED_HOST` to that hostname.

## Rollback

```sh
vercel rollback
```
