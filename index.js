require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const admin = require('firebase-admin');

// --- Firebase Admin Initialization from Environment Variables ---
const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL || '')}`,
    universe_domain: "googleapis.com"
};

// Validate required env vars
const requiredVars = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_CLIENT_ID',
    'EXTERNAL_API_KEY'
];

const missingVars = requiredVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    console.error("ERROR: Missing required environment variables:", missingVars.join(', '));
    process.exit(1);
}

try {
    const dbUrl = process.env.FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id}-default-rtdb.asia-southeast1.firebasedatabase.app`;
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: dbUrl,
        storageBucket: `${serviceAccount.project_id}.firebasestorage.app`
    });
    console.log("Firebase Admin (Realtime Database + Storage) Initialized Successfully");
    console.log("Database URL:", dbUrl);
    console.log("Storage Bucket:", serviceAccount.project_id + ".firebasestorage.app");
} catch (error) {
    console.error("Firebase Admin Initialization Error:", error.message);
    process.exit(1);
}

const rtdb = admin.database();
const auth = admin.auth();
const storage = admin.storage();
const bucket = storage.bucket();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// CORS
const allowedOrigins = [
    'https://searchmusic.gt.tc',
    'http://searchmusic.gt.tc',
    'https://jayspotifyweb.onrender.com',
    'http://localhost:3000',
    process.env.ALLOWED_ORIGIN
].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('CORS policy violation'), false);
        }
    },
    credentials: true
}));

app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'jay-music-secret-7d8d',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Middleware to verify Firebase ID Token
const verifyToken = async (req, res, next) => {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error("Token verification error:", error.message);
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ============================================================
// *** CRITICAL: SPECIFIC ROUTES MUST BE REGISTERED FIRST ***
// ============================================================

// --- SoundCloud Search Proxy ---
app.get('/api/search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ message: 'Query is required' });

    try {
        const response = await axios.get(`https://api.ferdev.my.id/search/soundcloud`, {
            params: { query, apikey: process.env.EXTERNAL_API_KEY }
        });
        res.json(response.data);
    } catch (error) {
        console.error("Search error:", error.message);
        res.status(500).json({ message: 'Search error', error: error.message });
    }
});

// --- SoundCloud Download Proxy ---
app.get('/api/download', async (req, res) => {
    const { link } = req.query;
    if (!link) return res.status(400).json({ message: 'Link is required' });

    try {
        const response = await axios.get(`https://api.ferdev.my.id/downloader/soundcloud`, {
            params: { link, apikey: process.env.EXTERNAL_API_KEY }
        });
        res.json(response.data);
    } catch (error) {
        console.error("Download error:", error.message);
        res.status(500).json({ message: 'Download error', error: error.message });
    }
});

// --- MP3 STORAGE & CACHING ---

/**
 * Generate a deduplication key from song info.
 * Uses lowercase "title by artist" to avoid duplicates.
 * e.g. "umaasa by calein" → only stored once
 */
function getSongKey(title, artist) {
    return `${(title || '').trim().toLowerCase()}||${(artist || '').trim().toLowerCase()}`.replace(/[^a-z0-9||]/g, '');
}

/**
 * Download MP3 from external API and upload to Firebase Storage.
 * Returns the permanent Firebase Storage URL.
 */
async function cacheMp3InStorage(songKey, title, artist, scUrl) {
    // Check if already cached
    const mp3Ref = rtdb.ref(`cachedSongs/${songKey}`);
    const cached = await mp3Ref.get();
    if (cached.exists()) {
        const cachedData = cached.val();
        // Verify the storage URL is still valid by checking file exists
        const file = bucket.file(cachedData.storagePath);
        const [exists] = await file.exists();
        if (exists) {
            console.log(`[CACHE HIT] "${songKey}" already in Firebase Storage`);
            return { storageUrl: cachedData.storageUrl, storagePath: cachedData.storagePath, cached: true };
        }
        console.log(`[CACHE MISS] "${songKey}" file missing from storage, re-downloading...`);
    }

    // Download MP3 from external API
    console.log(`[DOWNLOADING] "${songKey}" from SoundCloud...`);
    const downloadResponse = await axios.get(`https://api.ferdev.my.id/downloader/soundcloud`, {
        params: { link: scUrl, apikey: process.env.EXTERNAL_API_KEY }
    });

    const data = downloadResponse.data;
    if (!data || !data.result) {
        throw new Error('Failed to get download URL from external API');
    }

    const mp3Url = data.result.downloadUrl || data.result.url;
    if (!mp3Url) {
        throw new Error('No download URL in API response');
    }

    // Download the actual MP3 file
    const mp3Response = await axios({
        method: 'GET',
        url: mp3Url,
        responseType: 'arraybuffer',
        timeout: 60000
    });

    // Create temp file
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `${songKey.replace(/[^a-z0-9]/g, '_')}.mp3`);
    fs.writeFileSync(tempFile, Buffer.from(mp3Response.data));
    console.log(`[TEMP FILE] Saved to: ${tempFile} (${(mp3Response.data.length / 1024 / 1024).toFixed(2)} MB)`);

    // Upload to Firebase Storage
    const storagePath = `songs/${songKey}.mp3`;
    const file = bucket.file(storagePath);
    await file.save(fs.readFileSync(tempFile), {
        metadata: {
            contentType: 'audio/mpeg',
            metadata: {
                title: title || 'Unknown',
                artist: artist || 'Unknown'
            }
        },
        public: false
    });

    // Get the download URL
    const [downloadUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 365 * 24 * 60 * 60 * 1000 // 1 year expiry
    });

    // Clean up temp file
    fs.unlinkSync(tempFile);

    // Save to Realtime DB for deduplication
    await mp3Ref.set({
        title: title,
        artist: artist,
        storageUrl: downloadUrl,
        storagePath: storagePath,
        cachedAt: new Date().toISOString()
    });

    console.log(`[UPLOADED] "${songKey}" to Firebase Storage → ${storagePath}`);

    // Clean up old temp files (keep disk space)
    try {
        const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.mp3') && f.startsWith('jay_'));
        files.forEach(f => {
            const stat = fs.statSync(path.join(tempDir, f));
            if (Date.now() - stat.mtimeMs > 3600000) { // Older than 1 hour
                fs.unlinkSync(path.join(tempDir, f));
            }
        });
    } catch (e) {}

    return { storageUrl: downloadUrl, storagePath, cached: false };
}

// --- PLAYLIST ROUTES ---

// Get all playlists for a user
app.get('/api/user/playlists', verifyToken, async (req, res) => {
    const uid = req.user.uid;
    try {
        const snapshot = await rtdb.ref(`users/${uid}/playlists`).get();
        const playlists = [];
        
        if (snapshot.exists()) {
            snapshot.forEach(child => {
                playlists.push({ id: child.key, ...child.val() });
            });
        }

        for (const pl of playlists) {
            const songsSnapshot = await rtdb.ref(`playlistSongs/${pl.id}`).get();
            pl.songs = songsSnapshot.exists() ? songsSnapshot.val() : {};
            pl.songCount = songsSnapshot.exists() ? Object.keys(pl.songs).length : 0;
        }

        playlists.sort((a, b) => {
            const dateA = a.createdAt || '';
            const dateB = b.createdAt || '';
            return dateB.localeCompare(dateA);
        });

        res.json(playlists);
    } catch (error) {
        console.error("Playlists fetch error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get songs in a specific playlist
app.get('/api/user/playlists/:playlistId/songs', verifyToken, async (req, res) => {
    const { playlistId } = req.params;
    const uid = req.user.uid;
    try {
        const playlistRef = rtdb.ref(`users/${uid}/playlists/${playlistId}`);
        const snapshot = await playlistRef.get();
        
        if (!snapshot.exists()) {
            return res.status(404).json({ error: 'Playlist not found' });
        }

        const songsRef = rtdb.ref(`playlistSongs/${playlistId}`);
        const songsSnapshot = await songsRef.get();
        
        const songs = [];
        if (songsSnapshot.exists()) {
            songsSnapshot.forEach(child => {
                songs.push({ position: child.key, ...child.val() });
            });
        }

        songs.sort((a, b) => (a.position || 0) - (b.position || 0));

        res.json({ playlist: { id: playlistId, ...snapshot.val() }, songs });
    } catch (error) {
        console.error("Get playlist songs error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Create a new playlist
app.post('/api/user/playlists/create', verifyToken, async (req, res) => {
    const { name } = req.body;
    const uid = req.user.uid;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Playlist name is required', success: false });
    }

    try {
        const playlistRef = rtdb.ref(`users/${uid}/playlists`).push();
        const playlistId = playlistRef.key;
        
        await playlistRef.set({
            name: name.trim(),
            createdAt: new Date().toISOString()
        });

        await rtdb.ref(`playlistSongs/${playlistId}`).set({});

        console.log(`Playlist created: ${name} (id: ${playlistId}) for user: ${uid}`);
        res.json({
            success: true,
            id: playlistId,
            playlist: { id: playlistId, name: name.trim(), createdAt: new Date().toISOString() }
        });
    } catch (error) {
        console.error("Playlist creation error:", error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

// Add a song to an existing playlist
app.post('/api/user/playlists/add-song', verifyToken, async (req, res) => {
    const { playlistId, song } = req.body;
    const uid = req.user.uid;

    if (!playlistId) return res.status(400).json({ error: 'Playlist ID is required', success: false });
    if (!song) return res.status(400).json({ error: 'Song data is required', success: false });

    try {
        const playlistRef = rtdb.ref(`users/${uid}/playlists/${playlistId}`);
        const snapshot = await playlistRef.get();
        if (!snapshot.exists()) {
            return res.status(404).json({ error: 'Playlist not found', success: false });
        }

        // Check if this song is already in the playlist (deduplicate within playlist)
        const songsRef = rtdb.ref(`playlistSongs/${playlistId}`);
        const songsSnapshot = await songsRef.get();
        if (songsSnapshot.exists()) {
            const songsData = songsSnapshot.val();
            const songKey = getSongKey(song.title, song.artist || song.author);
            for (const [, existing] of Object.entries(songsData)) {
                const existingKey = getSongKey(existing.title, existing.artist);
                if (existingKey === songKey) {
                    return res.json({ success: true, message: 'Song already in this playlist', alreadyExists: true });
                }
            }
        }

        let position = 0;
        if (songsSnapshot.exists()) {
            position = Object.keys(songsSnapshot.val()).length;
        }

        const songData = {
            songId: song.songId || song.url || Date.now().toString(),
            title: song.title || 'Unknown',
            artist: song.artist || song.author || '',
            artwork: song.thumbnail || song.artwork || '',
            streamUrl: song.url || '',
            scUrl: song.url || '', // Keep original SoundCloud URL for caching
            addedAt: new Date().toISOString(),
            position: position
        };

        await rtdb.ref(`playlistSongs/${playlistId}/${position}`).set(songData);

        console.log(`Song added to playlist: ${playlistId} position: ${position}`);
        res.json({ success: true, position, song: songData });
    } catch (error) {
        console.error("Add song error:", error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

// Create playlist and add song in ONE request
app.post('/api/user/playlists/create-and-add', verifyToken, async (req, res) => {
    const { name, song } = req.body;
    const uid = req.user.uid;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Playlist name is required', success: false });
    if (!song) return res.status(400).json({ error: 'Song data is required', success: false });

    try {
        const playlistRef = rtdb.ref(`users/${uid}/playlists`).push();
        const playlistId = playlistRef.key;

        const songData = {
            songId: song.songId || song.url || Date.now().toString(),
            title: song.title || 'Unknown',
            artist: song.artist || song.author || '',
            artwork: song.thumbnail || song.artwork || '',
            streamUrl: song.url || '',
            scUrl: song.url || '',
            addedAt: new Date().toISOString(),
            position: 0
        };

        await rtdb.ref().update({
            [`users/${uid}/playlists/${playlistId}`]: { name: name.trim(), createdAt: new Date().toISOString() },
            [`playlistSongs/${playlistId}/0`]: songData
        });

        console.log(`Playlist + song created: ${playlistId} for user: ${uid}`);
        res.json({ success: true, id: playlistId, song: songData });
    } catch (error) {
        console.error("Create and add error:", error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

// Delete a playlist
app.delete('/api/user/playlists/:playlistId', verifyToken, async (req, res) => {
    const { playlistId } = req.params;
    const uid = req.user.uid;
    try {
        await rtdb.ref(`playlistSongs/${playlistId}`).remove();
        await rtdb.ref(`users/${uid}/playlists/${playlistId}`).remove();
        res.json({ success: true });
    } catch (error) {
        console.error("Delete playlist error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Remove a song from a playlist
app.post('/api/user/playlists/remove-song', verifyToken, async (req, res) => {
    const { playlistId, songId } = req.body;
    const uid = req.user.uid;
    try {
        const songsRef = rtdb.ref(`playlistSongs/${playlistId}`);
        const songsSnapshot = await songsRef.get();
        
        if (!songsSnapshot.exists()) {
            return res.json({ success: true, message: 'Playlist already empty' });
        }

        const songsData = songsSnapshot.val();
        for (const [key, song] of Object.entries(songsData)) {
            if (song.songId === songId) {
                await rtdb.ref(`playlistSongs/${playlistId}/${key}`).remove();
                break;
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Remove song error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- SONG CACHING ENDPOINT ---
// When user plays a song, this endpoint downloads + stores the MP3 in Firebase Storage
// Returns a permanent URL that works forever for playlist playback
app.post('/api/user/cache-song', verifyToken, async (req, res) => {
    const { title, artist, scUrl } = req.body;
    
    if (!title || !scUrl) {
        return res.status(400).json({ error: 'Title and SoundCloud URL are required', success: false });
    }

    try {
        const songKey = getSongKey(title, artist);
        console.log(`[CACHE] Request to cache: "${songKey}"`);
        
        const result = await cacheMp3InStorage(songKey, title, artist, scUrl);
        
        res.json({
            success: true,
            cached: result.cached,
            storageUrl: result.storageUrl,
            storagePath: result.storagePath,
            title,
            artist
        });
    } catch (error) {
        console.error("[CACHE ERROR]", error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

// Get a cached song's permanent URL (for playlist playback)
app.post('/api/user/get-cached-url', verifyToken, async (req, res) => {
    const { title, artist, scUrl } = req.body;
    
    if (!title) {
        return res.status(400).json({ error: 'Title is required', success: false });
    }

    try {
        const songKey = getSongKey(title, artist);
        console.log(`[GET-CACHED] Looking for: "${songKey}"`);
        
        // Check if cached
        const mp3Ref = rtdb.ref(`cachedSongs/${songKey}`);
        const cached = await mp3Ref.get();
        
        if (cached.exists()) {
            const cachedData = cached.val();
            // Verify file still exists in storage
            const file = bucket.file(cachedData.storagePath);
            const [exists] = await file.exists();
            if (exists) {
                // Get fresh signed URL (old one may have expired)
                const [downloadUrl] = await file.getSignedUrl({
                    action: 'read',
                    expires: Date.now() + 365 * 24 * 60 * 60 * 1000
                });
                
                console.log(`[GET-CACHED] Found "${songKey}" - returning permanent URL`);
                res.json({ success: true, storageUrl: downloadUrl, cached: true });
                return;
            }
        }
        
        // Not cached yet - download and cache it
        console.log(`[GET-CACHED] "${songKey}" not in cache, downloading...`);
        const result = await cacheMp3InStorage(songKey, title, artist, scUrl);
        res.json({ success: true, storageUrl: result.storageUrl, cached: result.cached });
        
    } catch (error) {
        console.error("[GET-CACHED ERROR]", error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

// --- USER COLLECTION ROUTES (REGISTERED LAST) ---

// Get User Collection (recentlyPlayed, favorites, etc.)
app.get('/api/user/:collection', verifyToken, async (req, res) => {
    const { collection } = req.params;
    const uid = req.user.uid;
    try {
        const snapshot = await rtdb.ref(`users/${uid}/${collection}`).get();
        const data = [];
        
        if (snapshot.exists()) {
            snapshot.forEach(child => {
                data.push({ id: child.key, ...child.val() });
            });
        }
        
        data.sort((a, b) => {
            const dateA = a.createdAt || '';
            const dateB = b.createdAt || '';
            return dateB.localeCompare(dateA);
        });

        res.json(data);
    } catch (error) {
        console.error("Collection fetch error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Add to User Collection (recentlyPlayed, favorites, etc.)
app.post('/api/user/:collection', verifyToken, async (req, res) => {
    const { collection } = req.params;
    const uid = req.user.uid;
    const item = req.body;
    try {
        const ref = rtdb.ref(`users/${uid}/${collection}`).push();
        await ref.set({
            ...item,
            createdAt: new Date().toISOString()
        });
        res.json({ id: ref.key });
    } catch (error) {
        console.error("Collection add error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// User Profile Sync
app.post('/api/user/sync', verifyToken, async (req, res) => {
    const { uid, email, displayName, photoURL, provider } = req.body;
    try {
        const userRef = rtdb.ref(`users/${uid}`);
        await userRef.update({
            uid, email, displayName, photoURL, provider,
            updatedAt: new Date().toISOString(),
            lastLogin: new Date().toISOString()
        });
        res.json({ success: true });
    } catch (error) {
        console.error("User sync error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Catch-all to serve index.html
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
