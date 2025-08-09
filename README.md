# FB Reels Auto-Poster (Demo)

**Description**

This repository contains a demo implementation of a Facebook (Meta) Reels Auto-Poster:
- Frontend: Bootstrap UI in `public/index.html`
- Backend: Node/Express (`server.js`) with:
  - Facebook OAuth flow to obtain long-lived user token and Page tokens
  - `/presign` to generate S3 presigned PUT URLs
  - `/publish` to stream an S3 video object to Meta using the Resumable Upload API (start → transfer → finish)

> ⚠️ This is a demo. Do not use tokens stored in session for production. Persist tokens securely, implement retries, and follow Meta App Review requirements.

## Quickstart (local)

1. Clone repo
```bash
git clone <your-repo-url>
cd fb-reels-autoposter
