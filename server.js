/**
 * server.js
 * Express backend for FB Reels Auto-Poster (demo)
 *
 * Features:
 * - Serves public/ static frontend
 * - /auth/facebook and callback to obtain long-lived user token and page tokens
 * - /presign to generate S3 presigned PUT URLs
 * - /publish to stream an uploaded S3 object to Meta Resumable Upload API and finish
 *
 * NOTES:
 * - This is a demo. Persist tokens securely in production.
 * - Validate and harden error handling and retries (Meta offsets, chunking, backoff).
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const AWS = require('aws-sdk');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const cookieSession = require('cookie-session');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'sess',
  keys: [process.env.SESSION_SECRET || 'dev_secret'],
  maxAge: 24 * 60 * 60 * 1000
}));

// Serve frontend
app.use('/', express.static(path.join(__dirname, 'public')));

// Configure AWS
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});
const S3 = new AWS.S3();

// Helper for FB Graph calls
function fbGraph(path, params = {}, method = 'GET') {
  const url = `https://graph.facebook.com${path}`;
  return axios({ url, method, params });
}

// --- 1) FACEBOOK OAUTH flow ---
// Redirect to FB OAuth dialog
app.get('/auth/facebook', (req, res) => {
  const clientId = process.env.FB_APP_ID;
  const redirect = process.env.FB_REDIRECT_URI;
  // Minimal scopes for Pages management and video publishing - adjust as needed
  const scope = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'pages_read_user_content',
    'pages_manage_metadata'
    // For production you may need publish_video or additional scopes & review
  ].join(',');

  const oauthUrl = `https://www.facebook.com/v17.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&response_type=code`;
  res.redirect(oauthUrl);
});

// Callback: exchange code -> short token -> long token -> fetch pages and tokens
app.get('/auth/facebook/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');

    // Exchange code for a short-lived user token
    const tokenResp = await axios.get('https://graph.facebook.com/v17.0/oauth/access_token', {
      params: {
        client_id: process.env.FB_APP_ID,
        redirect_uri: process.env.FB_REDIRECT_URI,
        client_secret: process.env.FB_APP_SECRET,
        code
      }
    });

    const shortLived = tokenResp.data.access_token;

    // Exchange for long-lived token
    const longResp = await axios.get('https://graph.facebook.com/v17.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.FB_APP_ID,
        client_secret: process.env.FB_APP_SECRET,
        fb_exchange_token: shortLived
      }
    });

    const longLivedUserToken = longResp.data.access_token;

    // Get Pages and their page access tokens
    const accountsResp = await fbGraph('/me/accounts', { access_token: longLivedUserToken });
    req.session.userAccessToken = longLivedUserToken;
    req.session.pages = accountsResp.data.data; // [{id, name, access_token}, ...]

    // Return a simple HTML page and instruct user to return to app
    res.send(`
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Connected to Facebook</h2>
        <p>Your account was connected successfully. You may now close this window and return to the app.</p>
        <pre>${JSON.stringify(req.session.pages, null, 2)}</pre>
      </div>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Auth failed. Check server logs.');
  }
});

// --- 2) presign S3 URL for browser uploads ---
app.post('/presign', async (req, res) => {
  try {
    const { filename, contentType } = req.body;
    if (!filename || !contentType) return res.status(400).send('filename + contentType required');

    const key = `uploads/${uuidv4()}_${filename}`;
    const params = {
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Expires: 60 * 5, // 5 minutes
      ContentType: contentType,
      ACL: 'private'
    };

    const url = await S3.getSignedUrlPromise('putObject', params);
    res.json({ url, key });
  } catch (err) {
    console.error('presign error', err);
    res.status(500).send('Presign failed');
  }
});

// --- 3) publish: take S3 key, stream to Meta using Resumable Upload API ---
/*
  Request body:
  {
    pageId: "<PAGE_ID>",
    pageAccessToken: "<PAGE_ACCESS_TOKEN>",
    s3Key: "uploads/....",
    filename: "myvideo.mp4"
  }
*/
app.post('/publish', async (req, res) => {
  try {
    const { pageId, pageAccessToken, s3Key, filename } = req.body;
    if (!pageId || !pageAccessToken || !s3Key || !filename) return res.status(400).send('pageId, pageAccessToken, s3Key, filename required');

    // 1) get object size from S3
    const head = await S3.headObject({ Bucket: process.env.S3_BUCKET, Key: s3Key }).promise();
    const totalSize = head.ContentLength;

    // 2) start upload session with Meta
    const startResp = await axios.post(`https://graph.facebook.com/v17.0/${pageId}/videos`, null, {
      params: {
        upload_phase: 'start',
        file_size: totalSize,
        access_token: pageAccessToken
      }
    });

    const { upload_session_id, start_offset, end_offset } = startResp.data;
    let sessionId = upload_session_id;
    let nextStart = start_offset || '0';
    let nextEnd = end_offset || null;

    // 3) transfer loop - use offsets returned by Graph API. This simplified demo requests ranges from S3 accordingly.
    while (true) {
      // Request the server what to send next is based on current nextStart
      // Meta will tell us the next offsets to send — if equal, the transfer phase is done.
      // We'll request a chunk from S3 matching the offset window. For safety, cap chunk size.
      const rangeStart = parseInt(nextStart, 10);
      // If nextEnd provided, use it; else choose a reasonable chunk
      const rangeEnd = nextEnd ? (parseInt(nextEnd, 10) - 1) : Math.min(rangeStart + (1024 * 1024 * 8) - 1, totalSize - 1); // 8MB chunk

      const s3Stream = S3.getObject({
        Bucket: process.env.S3_BUCKET,
        Key: s3Key,
        Range: `bytes=${rangeStart}-${rangeEnd}`
      }).createReadStream();

      // Send chunk to Graph (transfer)
      const transferResp = await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v17.0/${pageId}/videos`,
        params: {
          upload_phase: 'transfer',
          start_offset: nextStart,
          upload_session_id: sessionId,
          access_token: pageAccessToken
        },
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        data: s3Stream,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        // Increase timeout for large chunks
        timeout: 5 * 60 * 1000
      });

      const transferData = transferResp.data;
      // If Graph returns updated offsets and they differ, continue. Otherwise break to finish.
      if (transferData.start_offset && transferData.end_offset && transferData.start_offset !== transferData.end_offset) {
        nextStart = transferData.start_offset;
        nextEnd = transferData.end_offset;
        // loop to upload remaining bytes
        continue;
      }
      break;
    }

    // 4) finish
    const finishResp = await axios.post(`https://graph.facebook.com/v17.0/${pageId}/videos`, null, {
      params: {
        upload_phase: 'finish',
        upload_session_id: sessionId,
        access_token: pageAccessToken,
        title: filename,
        description: 'Uploaded by FB Reels Auto-Poster'
      }
    });

    const publishedVideoId = finishResp.data.video_id || finishResp.data.id || null;

    res.json({
      uploaded: true,
      videoId: publishedVideoId,
      meta: finishResp.data
    });

  } catch (err) {
    console.error('publish error', err.response?.data || err.message);
    res.status(500).json({ error: (err.response?.data || err.message) });
  }
});

// Simple route to list pages stored in session
app.get('/pages', (req, res) => {
  res.json({ pages: req.session.pages || [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
