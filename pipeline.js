import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import { stringify } from "csv-stringify/sync";
import open from "open";
import "dotenv/config";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CLIENT_ID       = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI    = "http://127.0.0.1:8888/callback";
const PORT            = 8888;
const SCOPES          = "playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private";
const TOKEN_FILE      = ".spotify_tokens.json";

const SOURCE_PLAYLIST     = process.env.SOURCE_PLAYLIST;
const SORT_MODE           = process.env.SORT_MODE || "listen";
const NEW_PLAYLIST_NAME   = process.env.NEW_PLAYLIST_NAME || "";
const NEW_PLAYLIST_PUBLIC = process.env.NEW_PLAYLIST_PUBLIC === "true";

if (!CLIENT_ID) {
  console.error("❌ Missing SPOTIFY_CLIENT_ID in .env");
  process.exit(1);
}
if (!SOURCE_PLAYLIST) {
  console.error("❌ Missing SOURCE_PLAYLIST in .env");
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

const SORT_MODES = {
  dj:         { w_harm: 0.70, w_bpm: 0.30, label: "DJ Set" },
  listen:     { w_harm: 0.50, w_bpm: 0.50, label: "Écoute active" },
  adrenaline: { w_harm: 0.30, w_bpm: 0.70, label: "Adrénaline" },
};

if (!SORT_MODES[SORT_MODE]) {
  console.error(`❌ Invalid SORT_MODE "${SORT_MODE}" — use: dj | listen | adrenaline`);
  process.exit(1);
}

const CAMELOT_TO_KEY = {
  "1A":"G#m","1B":"B","2A":"Ebm","2B":"F#","3A":"Bbm","3B":"Db",
  "4A":"Fm","4B":"Ab","5A":"Cm","5B":"Eb","6A":"Gm","6B":"Bb",
  "7A":"Dm","7B":"F","8A":"Am","8B":"C","9A":"Em","9B":"G",
  "10A":"Bm","10B":"D","11A":"F#m","11B":"A","12A":"C#m","12B":"E",
};

const SPOTIFY_TO_CAMELOT = {
  "0_1":"8B","1_1":"3B","2_1":"10B","3_1":"5B","4_1":"12B","5_1":"7B",
  "6_1":"2B","7_1":"9B","8_1":"4B","9_1":"11B","10_1":"6B","11_1":"1B",
  "0_0":"5A","1_0":"12A","2_0":"7A","3_0":"2A","4_0":"9A","5_0":"4A",
  "6_0":"11A","7_0":"6A","8_0":"1A","9_0":"8A","10_0":"3A","11_0":"10A",
};

// ─── PKCE ─────────────────────────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ─── TOKEN MANAGEMENT ────────────────────────────────────────────────────────
let tokenData = { accessToken: null, refreshToken: null, expiresAt: 0 };

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    }
  } catch {}
}

function saveTokens() {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

function isTokenExpired() {
  return Date.now() >= tokenData.expiresAt - 60_000;
}

async function refreshAccessToken() {
  if (!tokenData.refreshToken) return false;
  try {
    const res = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: tokenData.refreshToken,
        client_id:     CLIENT_ID,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    tokenData.accessToken = res.data.access_token;
    tokenData.expiresAt   = Date.now() + res.data.expires_in * 1000;
    if (res.data.refresh_token) tokenData.refreshToken = res.data.refresh_token;
    saveTokens();
    return true;
  } catch {
    return false;
  }
}

async function ensureToken() {
  if (tokenData.accessToken && !isTokenExpired()) return;
  if (tokenData.refreshToken) {
    console.log("🔄 Refreshing access token...");
    if (await refreshAccessToken()) return;
    console.log("⚠️  Refresh failed — re-authenticating...");
  }
  await doOAuthFlow();
}

// ─── OAUTH PKCE FLOW ──────────────────────────────────────────────────────────
function doOAuthFlow() {
  return new Promise((resolve, reject) => {
    const codeVerifier  = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const state = crypto.randomBytes(16).toString("hex");

    const authURL = `https://accounts.spotify.com/authorize?${new URLSearchParams({
      client_id:             CLIENT_ID,
      response_type:         "code",
      redirect_uri:          REDIRECT_URI,
      scope:                 SCOPES,
      state,
      code_challenge_method: "S256",
      code_challenge:        codeChallenge,
    })}`;

    const app    = express();
    const server = app.listen(PORT, () => {
      console.log("🌐 Opening Spotify login in browser...");
      console.log(`   If it didn't open: ${authURL}`);
      open(authURL).catch(() => {});
    });

    server.on("error", err => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${PORT} already in use. Free it with: kill $(lsof -ti :${PORT})`));
      } else {
        reject(err);
      }
    });

    app.get("/callback", async (req, res) => {
      const { code, error, state: returnedState } = req.query;
      if (returnedState !== state) {
        res.send(`<html><body style="font-family:sans-serif;padding:2rem"><h2>❌ State mismatch</h2><p>Possible CSRF attack. Try again.</p></body></html>`);
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }
      if (error) {
        res.send(`<html><body style="font-family:sans-serif;padding:2rem"><h2>❌ ${error}</h2><p>Check your terminal.</p></body></html>`);
        server.close();
        reject(new Error(`Spotify auth error: ${error}`));
        return;
      }
      try {
        const tokenRes = await axios.post(
          "https://accounts.spotify.com/api/token",
          new URLSearchParams({
            grant_type:    "authorization_code",
            code,
            redirect_uri:  REDIRECT_URI,
            client_id:     CLIENT_ID,
            code_verifier: codeVerifier,
          }),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        tokenData.accessToken  = tokenRes.data.access_token;
        tokenData.refreshToken = tokenRes.data.refresh_token;
        tokenData.expiresAt    = Date.now() + tokenRes.data.expires_in * 1000;
        saveTokens();
        res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:2rem">
          <h2>✅ Authenticated!</h2><p>You can close this tab.</p></body></html>`);
        server.close();
        resolve();
      } catch (err) {
        const detail = err.response?.data || err.message;
        res.send(`<html><body style="font-family:sans-serif;padding:2rem"><h2>❌ Token exchange failed</h2><pre>${JSON.stringify(detail,null,2)}</pre></body></html>`);
        server.close();
        reject(new Error(`Token exchange failed: ${JSON.stringify(detail)}`));
      }
    });
  });
}

// ─── SPOTIFY API WITH RETRY ──────────────────────────────────────────────────
async function spotifyRequest(method, url, data, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await ensureToken();
    try {
      const res = await axios({ method, url, data,
        headers: {
          Authorization:  `Bearer ${tokenData.accessToken}`,
          "Content-Type": "application/json",
        },
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 && attempt === 0) {
        tokenData.expiresAt = 0;
        continue;
      }
      if (status === 429) {
        const wait = parseInt(err.response?.headers?.["retry-after"] || "1", 10) * 1000;
        console.log(`  ⏳ Rate limited — waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// ─── PLAYLIST & TRACK HELPERS ────────────────────────────────────────────────
function extractPlaylistId(input) {
  const m = input.match(/playlist\/([a-zA-Z0-9]+)/);
  return m ? m[1] : input.trim();
}

async function fetchAllTracks(playlistId) {
  let tracks = [], url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50`;
  while (url) {
    const res = await spotifyRequest("get", url);
    tracks = tracks.concat(res.items.filter(i => i.track?.id));
    url = res.next;
  }
  return tracks;
}

async function fetchAudioFeatures(trackIds) {
  const features = [];
  for (let i = 0; i < trackIds.length; i += 100) {
    const chunk = trackIds.slice(i, i + 100);
    try {
      const res = await spotifyRequest("get",
        `https://api.spotify.com/v1/audio-features?ids=${chunk.join(",")}`
      );
      features.push(...(res.audio_features || []));
    } catch (err) {
      if (err.response?.status === 403) {
        features.push(...new Array(chunk.length).fill(null));
      } else {
        throw err;
      }
    }
  }
  return features;
}

async function fetchAudioAnalysis(trackId) {
  try {
    const res = await spotifyRequest("get", `https://api.spotify.com/v1/audio-analysis/${trackId}`);
    return {
      keyConfidence:     res.track?.key_confidence              ?? null,
      tempoConfidence:   res.track?.tempo_confidence             ?? null,
      modeConfidence:    res.track?.mode_confidence              ?? null,
      endOfFadeIn:       res.track?.end_of_fade_in               ?? 0,
      startOfFadeOut:    res.track?.start_of_fade_out            ?? null,
      timeSignature:     res.track?.time_signature               ?? null,
      timeSigConfidence: res.track?.time_signature_confidence    ?? null,
    };
  } catch {
    return { keyConfidence: null, tempoConfidence: null, modeConfidence: null,
             endOfFadeIn: 0, startOfFadeOut: null, timeSignature: null, timeSigConfidence: null };
  }
}

async function fetchAllAudioAnalysis(trackIds) {
  const CONCURRENCY = 3;
  const results = new Array(trackIds.length);
  let idx = 0;

  async function worker() {
    while (idx < trackIds.length) {
      const i = idx++;
      process.stdout.write(`\r  🔬 Analyzing track ${i + 1}/${trackIds.length}...`);
      results[i] = await fetchAudioAnalysis(trackIds[i]);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write("\n");
  return results;
}

async function createPlaylist(name, isPublic) {
  const res = await spotifyRequest("post",
    `https://api.spotify.com/v1/me/playlists`,
    { name, public: isPublic, description: `Sorted with TSP algorithm — ${SORT_MODES[SORT_MODE].label}` }
  );
  return res.id;
}

async function addTracks(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await spotifyRequest("post",
      `https://api.spotify.com/v1/playlists/${playlistId}/items`,
      { uris: uris.slice(i, i + 100) }
    );
  }
}

// ─── CAMELOT & TSP ────────────────────────────────────────────────────────────
function getCamelot(key, mode) {
  return SPOTIFY_TO_CAMELOT[`${key}_${mode}`] || "?";
}

function parseCamelot(val) {
  const m = val.match(/^(\d+)([AB])$/);
  return m ? [parseInt(m[1]), m[2]] : [99, "Z"];
}

function camelotDistance(n1, t1, n2, t2) {
  if (n1 === n2 && t1 === t2) return 0;
  if (n1 === n2) return 1;
  const diff = Math.min(Math.abs(n1 - n2), 12 - Math.abs(n1 - n2));
  if (t1 === t2 && diff === 1) return 1;
  if (t1 === t2 && diff <= 2) return 2;
  if (diff === 1) return 2;
  return diff + (t1 === t2 ? 0 : 1);
}

function tspSort(rows, wHarm, wBpm) {
  const bpms     = rows.map(r => r.bpm).filter(b => b > 0);
  const bpmRange = bpms.length > 1 ? Math.max(...bpms) - Math.min(...bpms) : 1;
  const used     = new Array(rows.length).fill(false);
  const order    = [0];
  used[0] = true;

  for (let _ = 0; _ < rows.length - 1; _++) {
    const last = order[order.length - 1];
    const { cn: n1, ct: t1, bpm: b1 } = rows[last];
    let bestCost = Infinity, bestIdx = -1;

    for (let i = 0; i < rows.length; i++) {
      if (used[i]) continue;
      const harm    = camelotDistance(n1, t1, rows[i].cn, rows[i].ct) / 6;
      const bpmDiff = rows[i].bpm - b1;
      let bpmCost   = b1 > 0 && rows[i].bpm > 0 ? Math.abs(bpmDiff) / bpmRange : 0;
      if (bpmDiff < 0) bpmCost *= 1.5;
      const cost = wHarm * harm + wBpm * bpmCost;
      if (cost < bestCost) { bestCost = cost; bestIdx = i; }
    }
    order.push(bestIdx);
    used[bestIdx] = true;
  }
  return order;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🎧 Spotify Playlist Pipeline");
  console.log("─────────────────────────────");
  console.log("Sort mode:", SORT_MODES[SORT_MODE].label);

  loadTokens();
  await ensureToken();

  const { w_harm, w_bpm, label } = SORT_MODES[SORT_MODE];
  const playlistId = extractPlaylistId(SOURCE_PLAYLIST);

  console.log(`\n📋 Fetching playlist: ${playlistId}`);
  const playlistInfo = await spotifyRequest("get",
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks.total`
  );
  const playlistName = NEW_PLAYLIST_NAME || `${playlistInfo.name} [Sorted]`;
  console.log(`✓ "${playlistInfo.name}" — ${playlistInfo.tracks.total} tracks`);

  console.log("⬇️  Fetching tracks...");
  const rawTracks = await fetchAllTracks(playlistId);
  console.log(`✓ ${rawTracks.length} tracks loaded`);

  const ids = rawTracks.map(t => t.track.id);

  console.log("🎼 Fetching audio features...");
  const features = await fetchAudioFeatures(ids);
  const audioFeaturesAvailable = features.some(f => f !== null);

  if (!audioFeaturesAvailable) {
    console.log("⚠️  Audio features unavailable (deprecated for apps created after Nov 2024).");
    console.log("   Harmonic/BPM sorting skipped — original track order preserved in CSV.");
  } else {
    console.log("✓ Audio features loaded");
  }

  const nullAnalysis = { keyConfidence: null, tempoConfidence: null, modeConfidence: null,
    endOfFadeIn: 0, startOfFadeOut: null, timeSignature: null, timeSigConfidence: null };
  let analyses = new Array(ids.length).fill(nullAnalysis);

  if (audioFeaturesAvailable) {
    console.log(`🔬 Fetching audio analysis (${ids.length} tracks)...`);
    analyses = await fetchAllAudioAnalysis(ids);
    console.log("✓ Audio analysis loaded");
  }

  const tracks = rawTracks.map((item, i) => {
    const t = item.track;
    const f = features[i] || {};
    const a = analyses[i] || nullAnalysis;
    const camelot    = getCamelot(f.key ?? -1, f.mode ?? -1);
    const [cn, ct]   = parseCamelot(camelot);
    const camelotKey = CAMELOT_TO_KEY[camelot] || "?";

    const keyConf   = a.keyConfidence   ?? null;
    const tempoConf = a.tempoConfidence ?? null;
    const modeConf  = a.modeConfidence  ?? null;

    const camelotReliable = keyConf !== null && modeConf !== null
      ? (keyConf >= 0.5 && modeConf >= 0.5 ? "✓" : "⚠ check") : "?";
    const bpmReliable = tempoConf !== null
      ? (tempoConf >= 0.5 ? "✓" : "⚠ check") : "?";

    return {
      id:           t.id,
      song:         t.name,
      artist:       t.artists.map(a => a.name).join(", "),
      album:        t.album.name,
      albumDate:    t.album.release_date,
      duration:     `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, "0")}`,
      bpm:          Math.round(f.tempo || 0),
      bpmReliable,
      tempoConf:    tempoConf !== null ? Math.round(tempoConf * 100) + "%" : "?",
      camelot,
      camelotReliable,
      keyConf:      keyConf  !== null ? Math.round(keyConf  * 100) + "%" : "?",
      modeConf:     modeConf !== null ? Math.round(modeConf * 100) + "%" : "?",
      key:          camelotKey,
      fadeIn:       a.endOfFadeIn   ? `${a.endOfFadeIn.toFixed(1)}s`   : "0s",
      fadeOut:      a.startOfFadeOut ? `${a.startOfFadeOut.toFixed(1)}s` : "?",
      energy:       f.energy           != null ? Math.round(f.energy           * 100) : "",
      dance:        f.danceability     != null ? Math.round(f.danceability     * 100) : "",
      valence:      f.valence          != null ? Math.round(f.valence          * 100) : "",
      acoustic:     f.acousticness     != null ? Math.round(f.acousticness     * 100) : "",
      instrumental: f.instrumentalness != null ? Math.round(f.instrumentalness * 100) : "",
      speech:       f.speechiness      != null ? Math.round(f.speechiness      * 100) : "",
      live:         f.liveness         != null ? Math.round(f.liveness         * 100) : "",
      loud:         f.loudness         != null ? f.loudness.toFixed(1) : "",
      popularity:   t.popularity,
      explicit:     t.explicit ? "Yes" : "No",
      spotifyId:    t.id,
      isrc:         t.external_ids?.isrc || "",
      addedAt:      item.added_at?.split("T")[0] || "",
      cn, ct,
    };
  });

  let sorted;
  if (audioFeaturesAvailable) {
    console.log(`\n🔀 Sorting — ${label} (harmony ${Math.round(w_harm * 100)}% / BPM ${Math.round(w_bpm * 100)}%)`);
    const order = tspSort(tracks, w_harm, w_bpm);
    sorted = order.map((i, idx) => ({ "#": idx + 1, ...tracks[i] }));

    const unreliable = sorted.filter(t => t.camelotReliable === "⚠ check" || t.bpmReliable === "⚠ check");
    if (unreliable.length > 0) {
      console.log(`\n⚠️  ${unreliable.length} track(s) with low confidence — verify manually:`);
      unreliable.forEach(t => {
        const issues = [];
        if (t.camelotReliable === "⚠ check") issues.push(`Camelot ${t.camelot} (key:${t.keyConf} mode:${t.modeConf})`);
        if (t.bpmReliable     === "⚠ check") issues.push(`BPM ${t.bpm} (conf:${t.tempoConf})`);
        console.log(`  #${t["#"]} ${t.song} — ${issues.join(", ")}`);
      });
    }
  } else {
    sorted = tracks.map((t, idx) => ({ "#": idx + 1, ...t }));
  }

  const csvPath = `./${playlistName.replace(/[^a-z0-9]/gi, "_")}_sorted.csv`;
  const csvRows = sorted.map(t => ({
    "#": t["#"], Song: t.song, Artist: t.artist, BPM: t.bpm,
    "BPM OK": t.bpmReliable, "BPM Conf": t.tempoConf,
    Camelot: t.camelot, "Camelot OK": t.camelotReliable,
    "Key Conf": t.keyConf, "Mode Conf": t.modeConf,
    Key: t.key, "Fade In": t.fadeIn, "Fade Out": t.fadeOut,
    Energy: t.energy, Dance: t.dance, Valence: t.valence,
    Acoustic: t.acoustic, Instrumental: t.instrumental,
    Speech: t.speech, Live: t.live, "Loud (Db)": t.loud,
    Popularity: t.popularity, Explicit: t.explicit,
    Duration: t.duration, Album: t.album, "Album Date": t.albumDate,
    "Added At": t.addedAt, "Spotify Track Id": t.spotifyId, ISRC: t.isrc,
  }));
  fs.writeFileSync(csvPath, stringify(csvRows, { header: true }));
  console.log(`\n✓ CSV saved: ${csvPath}`);

  console.log(`🎵 Creating Spotify playlist: "${playlistName}"...`);
  const newId = await createPlaylist(playlistName, NEW_PLAYLIST_PUBLIC);
  await addTracks(newId, sorted.map(t => `spotify:track:${t.spotifyId}`));

  console.log(`\n✅ Done!`);
  console.log(`📄 CSV:      ${csvPath}`);
  console.log(`🔗 Playlist: https://open.spotify.com/playlist/${newId}`);
  process.exit(0);
}

main().catch(err => {
  console.error("\n❌", err.response?.data || err.message);
  process.exit(1);
});
