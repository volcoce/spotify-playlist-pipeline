import express from "express";
import axios from "axios";
import fs from "fs";
import { stringify } from "csv-stringify/sync";
import open from "open";
import "dotenv/config";

// ─── CONFIG — edit .env file, not here ────────────────────────────────────────
const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = "http://127.0.0.1:8888/callback";
const PORT          = 8888;
const SCOPES        = "playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private";

const SOURCE_PLAYLIST     = process.env.SOURCE_PLAYLIST;
const SORT_MODE           = process.env.SORT_MODE || "listen";
const NEW_PLAYLIST_NAME   = process.env.NEW_PLAYLIST_NAME || "";
const NEW_PLAYLIST_PUBLIC = process.env.NEW_PLAYLIST_PUBLIC === "true";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env");
  process.exit(1);
}
if (!SOURCE_PLAYLIST) {
  console.error("❌ Missing SOURCE_PLAYLIST in .env");
  process.exit(1);
}
// ──────────────────────────────────────────────────────────────────────────────

const SORT_MODES = {
  dj:         { w_harm: 0.70, w_bpm: 0.30, label: "DJ Set" },
  listen:     { w_harm: 0.50, w_bpm: 0.50, label: "Écoute active" },
  adrenaline: { w_harm: 0.30, w_bpm: 0.70, label: "Adrénaline" },
};

const CAMELOT_TO_KEY = {
  "1A":"G#m","1B":"B","2A":"Ebm","2B":"F#","3A":"Bbm","3B":"Db",
  "4A":"Fm","4B":"Ab","5A":"Cm","5B":"Eb","6A":"Gm","6B":"Bb",
  "7A":"Dm","7B":"F","8A":"Am","8B":"C","9A":"Em","9B":"G",
  "10A":"Bm","10B":"D","11A":"F#m","11B":"A","12A":"C#m","12B":"E",
};

// Spotify Camelot: map from Spotify key (0-11) + mode (0=minor,1=major)
const SPOTIFY_TO_CAMELOT = {
  "0_1":"8B","1_1":"3B","2_1":"10B","3_1":"5B","4_1":"12B","5_1":"7B",
  "6_1":"2B","7_1":"9B","8_1":"4B","9_1":"11B","10_1":"6B","11_1":"1B",
  "0_0":"5A","1_0":"12A","2_0":"7A","3_0":"2A","4_0":"9A","5_0":"4A",
  "6_0":"11A","7_0":"6A","8_0":"1A","9_0":"8A","10_0":"3A","11_0":"10A",
};

const KEY_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MODE_NAMES = { 0: "Minor", 1: "Major" };

const app = express();
let accessToken = null;

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function getAuthURL() {
  return `https://accounts.spotify.com/authorize?${new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code",
    redirect_uri: REDIRECT_URI, scope: SCOPES,
  })}`;
}

async function getAccessToken(code) {
  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
    { headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    }}
  );
  return res.data.access_token;
}

// ─── SPOTIFY HELPERS ──────────────────────────────────────────────────────────
const spotify = (method, url, data) => axios({ method, url, data,
  headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
}).then(r => r.data);

function extractPlaylistId(input) {
  const m = input.match(/playlist\/([a-zA-Z0-9]+)/);
  return m ? m[1] : input.trim();
}

async function fetchAllTracks(playlistId) {
  let tracks = [], url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const res = await spotify("get", url);
    tracks = tracks.concat(res.items.filter(i => i.track && i.track.id));
    url = res.next;
  }
  return tracks;
}

async function fetchAudioFeatures(trackIds) {
  const features = [];
  for (let i = 0; i < trackIds.length; i += 100) {
    const chunk = trackIds.slice(i, i + 100);
    const res = await spotify("get",
      `https://api.spotify.com/v1/audio-features?ids=${chunk.join(",")}`
    );
    features.push(...res.audio_features);
  }
  return features;
}

// Fetch audio analysis for a single track (key/tempo confidence + fade points)
async function fetchAudioAnalysis(trackId) {
  try {
    const res = await spotify("get", `https://api.spotify.com/v1/audio-analysis/${trackId}`);
    return {
      keyConfidence:       res.track?.key_confidence   ?? null,
      tempoConfidence:     res.track?.tempo_confidence  ?? null,
      modeConfidence:      res.track?.mode_confidence   ?? null,
      endOfFadeIn:         res.track?.end_of_fade_in    ?? 0,
      startOfFadeOut:      res.track?.start_of_fade_out ?? null,
      timeSignature:       res.track?.time_signature    ?? null,
      timeSigConfidence:   res.track?.time_signature_confidence ?? null,
    };
  } catch {
    return { keyConfidence: null, tempoConfidence: null, modeConfidence: null,
             endOfFadeIn: 0, startOfFadeOut: null, timeSignature: null, timeSigConfidence: null };
  }
}

// Fetch analysis for all tracks with concurrency limit (avoid rate limiting)
async function fetchAllAudioAnalysis(trackIds) {
  const CONCURRENCY = 3; // max parallel requests
  const results = new Array(trackIds.length);
  let idx = 0;

  async function worker() {
    while (idx < trackIds.length) {
      const i = idx++;
      process.stdout.write(`\r  🔬 Analyzing track ${i + 1}/${trackIds.length}...`);
      results[i] = await fetchAudioAnalysis(trackIds[i]);
      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 100));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write("\n");
  return results;
}

// Confidence label helper
function confidenceLabel(val) {
  if (val === null) return "?";
  if (val >= 0.8) return "✓ high";
  if (val >= 0.5) return "~ medium";
  return "⚠ low";
}

async function getMe() {
  return spotify("get", "https://api.spotify.com/v1/me");
}

async function createPlaylist(userId, name, isPublic) {
  const res = await spotify("post",
    `https://api.spotify.com/v1/users/${userId}/playlists`,
    { name, public: isPublic, description: `Sorted with TSP algorithm — ${SORT_MODES[SORT_MODE].label}` }
  );
  return res.id;
}

async function addTracks(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await spotify("post",
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
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
  const bpms = rows.map(r => r.bpm);
  const bpmRange = Math.max(...bpms) - Math.min(...bpms) || 1;
  const used = new Array(rows.length).fill(false);
  const order = [0]; used[0] = true;

  for (let _ = 0; _ < rows.length - 1; _++) {
    const last = order[order.length - 1];
    const { cn: n1, ct: t1, bpm: b1 } = rows[last];
    let bestCost = Infinity, bestIdx = -1;

    for (let i = 0; i < rows.length; i++) {
      if (used[i]) continue;
      const harm = camelotDistance(n1, t1, rows[i].cn, rows[i].ct) / 6;
      const bpmDiff = rows[i].bpm - b1;
      let bpmCost = Math.abs(bpmDiff) / bpmRange;
      if (bpmDiff < 0) bpmCost *= 1.5;
      const cost = wHarm * harm + wBpm * bpmCost;
      if (cost < bestCost) { bestCost = cost; bestIdx = i; }
    }
    order.push(bestIdx); used[bestIdx] = true;
  }
  return order;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  const { w_harm, w_bpm, label } = SORT_MODES[SORT_MODE];
  const playlistId = extractPlaylistId(SOURCE_PLAYLIST);

  console.log(`\n🎧 Fetching playlist: ${playlistId}`);
  const playlistInfo = await spotify("get", `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks.total`);
  const playlistName = NEW_PLAYLIST_NAME || `${playlistInfo.name} [Sorted]`;
  console.log(`✓ "${playlistInfo.name}" — ${playlistInfo.tracks.total} tracks`);

  console.log("⬇️  Fetching tracks...");
  const rawTracks = await fetchAllTracks(playlistId);
  console.log(`✓ ${rawTracks.length} tracks loaded`);

  console.log("🎼 Fetching audio features...");
  const ids = rawTracks.map(t => t.track.id);
  const features = await fetchAudioFeatures(ids);
  console.log("✓ Audio features loaded");

  console.log(`🔬 Fetching audio analysis (${ids.length} tracks)...`);
  const analyses = await fetchAllAudioAnalysis(ids);
  console.log("✓ Audio analysis loaded");

  // Build track objects
  const tracks = rawTracks.map((item, i) => {
    const t = item.track;
    const f = features[i] || {};
    const a = analyses[i] || {};
    const camelot = getCamelot(f.key ?? -1, f.mode ?? -1);
    const [cn, ct] = parseCamelot(camelot);
    const camelotKey = CAMELOT_TO_KEY[camelot] || "?";

    // Flag unreliable key/BPM
    const keyConf   = a.keyConfidence   ?? null;
    const tempoConf = a.tempoConfidence ?? null;
    const modeConf  = a.modeConfidence  ?? null;
    const camelotReliable = keyConf !== null && modeConf !== null
      ? (keyConf >= 0.5 && modeConf >= 0.5 ? "✓" : "⚠ check")
      : "?";
    const bpmReliable = tempoConf !== null
      ? (tempoConf >= 0.5 ? "✓" : "⚠ check")
      : "?";

    // Fade points
    const fadeIn  = a.endOfFadeIn   ? `${a.endOfFadeIn.toFixed(1)}s`   : "0s";
    const fadeOut = a.startOfFadeOut ? `${a.startOfFadeOut.toFixed(1)}s` : "?";

    return {
      id: t.id,
      song: t.name,
      artist: t.artists.map(a => a.name).join(", "),
      album: t.album.name,
      albumDate: t.album.release_date,
      duration: `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, "0")}`,
      bpm: Math.round(f.tempo || 0),
      bpmReliable,
      tempoConf: tempoConf !== null ? Math.round(tempoConf * 100) + "%" : "?",
      camelot,
      camelotReliable,
      keyConf:  keyConf  !== null ? Math.round(keyConf  * 100) + "%" : "?",
      modeConf: modeConf !== null ? Math.round(modeConf * 100) + "%" : "?",
      key: camelotKey,
      fadeIn,
      fadeOut,
      energy: f.energy != null ? Math.round(f.energy * 100) : "",
      dance: f.danceability != null ? Math.round(f.danceability * 100) : "",
      valence: f.valence != null ? Math.round(f.valence * 100) : "",
      acoustic: f.acousticness != null ? Math.round(f.acousticness * 100) : "",
      instrumental: f.instrumentalness != null ? Math.round(f.instrumentalness * 100) : "",
      speech: f.speechiness != null ? Math.round(f.speechiness * 100) : "",
      live: f.liveness != null ? Math.round(f.liveness * 100) : "",
      loud: f.loudness != null ? f.loudness.toFixed(1) : "",
      popularity: t.popularity,
      explicit: t.explicit ? "Yes" : "No",
      spotifyId: t.id,
      isrc: t.external_ids?.isrc || "",
      addedAt: item.added_at?.split("T")[0] || "",
      cn, ct,
    };
  });

  // TSP sort
  console.log(`🔀 Sorting — mode: ${label} (harmony ${Math.round(w_harm*100)}% / BPM ${Math.round(w_bpm*100)}%)`);
  const order = tspSort(tracks, w_harm, w_bpm);
  const sorted = order.map((i, idx) => ({ "#": idx + 1, ...tracks[i] }));

  // Warn about unreliable tracks
  const unreliable = sorted.filter(t => t.camelotReliable === "⚠ check" || t.bpmReliable === "⚠ check");
  if (unreliable.length > 0) {
    console.log(`\n⚠️  ${unreliable.length} track(s) with low confidence — verify manually:`);
    unreliable.forEach(t => {
      const issues = [];
      if (t.camelotReliable === "⚠ check") issues.push(`Camelot ${t.camelot} (key:${t.keyConf} mode:${t.modeConf})`);
      if (t.bpmReliable     === "⚠ check") issues.push(`BPM ${t.bpm} (conf:${t.tempoConf})`);
      console.log(`  #${t["#"]} ${t.song} — ${issues.join(", ")}`);
    });
    console.log("");
  }

  // Write CSV
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
  console.log(`✓ CSV saved: ${csvPath}`);

  // Create Spotify playlist
  console.log(`🎵 Creating Spotify playlist: "${playlistName}"...`);
  const me = await getMe();
  const newId = await createPlaylist(me.id, playlistName, NEW_PLAYLIST_PUBLIC);
  const uris = sorted.map(t => `spotify:track:${t.spotifyId}`);
  await addTracks(newId, uris);

  console.log(`\n✅ Done!`);
  console.log(`📄 CSV: ${csvPath}`);
  console.log(`🔗 Playlist: https://open.spotify.com/playlist/${newId}`);
  process.exit(0);
}

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) { res.send(`❌ ${error}`); process.exit(1); }
  try {
    accessToken = await getAccessToken(code);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:2rem">
      <h2>✅ Authenticated!</h2><p>Check your terminal.</p></body></html>`);
    await run();
  } catch (err) {
    console.error("❌", err.response?.data || err.message);
    process.exit(1);
  }
});

app.listen(PORT, () => {
  console.log("\n🎧 Spotify Pipeline — fetch → sort → create");
  console.log("────────────────────────────────────────────");
  console.log("Sort mode:", SORT_MODES[SORT_MODE].label);
  console.log("Opening Spotify login...");
  open(getAuthURL());
});
