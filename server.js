import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();

// 1️⃣ Start Facebook login
app.get("/auth/facebook", (req, res) => {
  const redirectUri = encodeURIComponent(process.env.FB_REDIRECT_URI);
  const scopes = [
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "publish_video"
  ].join(",");

  const fbLoginUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.FB_APP_ID}&redirect_uri=${redirectUri}&scope=${scopes}&response_type=code`;

  res.redirect(fbLoginUrl);
});

// 2️⃣ Handle Facebook callback
app.get("/auth/facebook/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code returned from Facebook");

  const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.FB_APP_ID}&redirect_uri=${encodeURIComponent(process.env.FB_REDIRECT_URI)}&client_secret=${process.env.FB_APP_SECRET}&code=${code}`;

  try {
    const response = await fetch(tokenUrl);
    const data = await response.json();
    if (data.error) throw data.error;

    // Save access token securely
    console.log("Access Token:", data.access_token);

    res.send("✅ Facebook connected! You can now upload videos.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error exchanging code for token");
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
