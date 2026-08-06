require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const admin = require('firebase-admin');
const mongoose = require('mongoose');

// --- MongoDB Connection ---
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log("MongoDB Connected Successfully"))
        .catch(err => console.error("MongoDB Connection Error:", err));
} else {
    console.warn("MONGODB_URI not found in environment variables");
}

// Define MongoDB Schemas
const userSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    email: String,
    status: { type: String, default: 'free' }, // free, starter, popular, premium
    expiresAt: Date,
    dailySearches: { type: Number, default: 0 },
    dailyPlays: { type: Number, default: 0 },
    lastActivity: { type: Date, default: Date.now }
});

const cachedSongSchema = new mongoose.Schema({
    songKey: { type: String, required: true, unique: true },
    title: String,
    artist: String,
    storageUrl: String,
    storagePath: String,
    artwork: String,
    cachedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const CachedSong = mongoose.model('CachedSong', cachedSongSchema);

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
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Middleware to verify Firebase ID Token and sync/check user status
const verifyToken = async (req, res, next) => {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.user = decodedToken;

        // Sync with MongoDB
        let user = await User.findOne({ uid: decodedToken.uid });
        if (!user) {
            // Check if admin pre-registered this email
            user = await User.findOne({ email: decodedToken.email });
            if (user) {
                // Link the UID to the pre-registered email
                user.uid = decodedToken.uid;
                await user.save();
            } else {
                // New user
                user = await User.create({ 
                    uid: decodedToken.uid, 
                    email: decodedToken.email || '' 
                });
            }
        }

        // Reset daily limits if it's a new day
        const now = new Date();
        const last = new Date(user.lastActivity);
        if (now.toDateString() !== last.toDateString()) {
            user.dailySearches = 0;
            user.dailyPlays = 0;
        }
        
        // Check if subscription expired
        if (user.status !== 'free' && user.expiresAt && new Date(user.expiresAt) < now) {
            user.status = 'free';
        }

        user.lastActivity = now;
        await user.save();
        req.userProfile = user;

        next();
    } catch (error) {
        console.error("Token verification error:", error.message);
        res.status(401).json({ error: 'Invalid token' });
    }
};

// Middleware to check daily limits
const checkLimits = (type) => async (req, res, next) => {
    const user = req.userProfile;
    if (user.status !== 'free') return next(); // No limits for paid users

    if (type === 'search' && user.dailySearches >= 5) {
        return res.status(403).json({ error: "Daily search limit reached. Upgrade to unlock unlimited!" });
    }
    if (type === 'play' && user.dailyPlays >= 5) {
        return res.status(403).json({ error: "Daily play limit reached. Upgrade to unlock unlimited!" });
    }
    next();
};

// ============================================================
// *** CRITICAL: SPECIFIC ROUTES MUST BE REGISTERED FIRST ***
// ============================================================

// --- SoundCloud Search Proxy ---
app.get('/api/search', verifyToken, checkLimits('search'), async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ message: 'Query is required' });

    console.log(`[SEARCH] Query: "${query}" for user: ${req.userProfile.email}`);

    try {
        const response = await axios.get(`https://rest-apins.vercel.app/api/search/soundcloud`, {
            params: { q: query, limit: 10 },
            timeout: 15000
        });
        
        if (response.data && response.data.success) {
            // Transform results to match the previous API format for frontend compatibility
            const results = (response.data.result || []).map(item => ({
                url: item.url,
                title: item.title,
                author: item.user || 'SoundCloud',
                thumbnail: '', // New API doesn't seem to provide thumbnails in search
                duration: item.duration,
                plays: item.plays
            }));

            // Increment search count for free users
            if (req.userProfile.status === 'free') {
                req.userProfile.dailySearches += 1;
                await req.userProfile.save();
            }
            console.log(`[SEARCH] Found ${results.length} results`);
            res.json({ success: true, result: results });
        } else {
            console.warn(`[SEARCH] API returned success=false:`, response.data);
            res.json(response.data);
        }
    } catch (error) {
        console.error("Search error:", error.message);
        res.status(500).json({ message: 'Search error', error: error.message });
    }
});

// --- SoundCloud Download Proxy ---
app.get('/api/download', verifyToken, checkLimits('play'), async (req, res) => {
    const { link, title, artist } = req.query;
    if (!link) return res.status(400).json({ message: 'Link is required' });

    try {
        // If title/artist provided, check cache first (MongoDB)
        if (title) {
            const songKey = getSongKey(title, artist || '');
            const cachedSong = await CachedSong.findOne({ songKey });
            
            if (cachedSong) {
                const file = bucket.file(cachedSong.storagePath);
                const [exists] = await file.exists();
                if (exists) {
                    const [downloadUrl] = await file.getSignedUrl({
                        action: 'read',
                        expires: Date.now() + 365 * 24 * 60 * 60 * 1000
                    });
                    
                    // Increment play count for free users
                    if (req.userProfile.status === 'free') {
                        req.userProfile.dailyPlays += 1;
                        await req.userProfile.save();
                    }

                    console.log(`[CACHE HIT] Serving "${songKey}" from Storage`);
                    return res.json({ 
                        success: true, 
                        result: { 
                            title: cachedSong.title, 
                            author: cachedSong.artist, 
                            downloadUrl: downloadUrl,
                            thumbnail: cachedSong.artwork || ''
                        } 
                    });
                }
            }
        }

        // Use the new downloader API
        const response = await axios.post(`https://rest-apins.vercel.app/api/downloader/soundcloud-v2`, {
            url: link
        }, { timeout: 30000 });
        
        // Background cache if successful
        if (response.data.success && response.data.result && title) {
            const result = response.data.result;
            const songKey = getSongKey(title, artist || result.author || result.user);
            cacheMp3InStorage(songKey, title, artist || result.author || result.user, link).catch(e => console.error("BG Cache Error:", e.message));
        }

        // Increment play count for free users
        if (req.userProfile.status === 'free') {
            req.userProfile.dailyPlays += 1;
            await req.userProfile.save();
        }

        // Transform response to match frontend expectations
        const result = response.data.result || {};
        res.json({
            success: response.data.success,
            result: {
                title: result.title || title,
                author: result.user || result.author || artist || 'SoundCloud',
                downloadUrl: result.downloadUrl || result.url,
                thumbnail: result.thumbnail || ''
            }
        });
    } catch (error) {
        console.error("Download error:", error.message);
        res.status(500).json({ message: 'Download error', error: error.message });
    }
});

// --- ADMIN AUTH ---
const ADMIN_USER = "selov";
const ADMIN_PASS = "selovasx2024";

const isAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.status(401).json({ error: "Unauthorized" });
    }
};

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.isAdmin = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Invalid credentials" });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
    res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// --- ADMIN MANAGEMENT ---
app.get('/api/admin/songs', isAdmin, async (req, res) => {
    try {
        const songs = await CachedSong.find().sort({ cachedAt: -1 });
        res.json(songs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/songs/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const song = await CachedSong.findById(id);
        if (song) {
            if (song.storagePath) {
                await bucket.file(song.storagePath).delete().catch(() => {});
            }
            await CachedSong.findByIdAndDelete(id);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const users = await User.find().sort({ lastActivity: -1 });
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/users/update-status', isAdmin, async (req, res) => {
    const { uid, email, status, days } = req.body;
    try {
        const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
        const query = uid ? { uid } : { email };
        
        const user = await User.findOneAndUpdate(
            query, 
            { status, expiresAt }, 
            { upsert: true, new: true }
        );
        
        console.log(`[ADMIN] Updated user ${user.email} to ${status} (expires: ${expiresAt})`);
        res.json({ success: true, user });
    } catch (error) {
        console.error("Update status error:", error.message);
        res.status(500).json({ error: error.message });
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
    // Check if already cached in MongoDB
    const cachedSong = await CachedSong.findOne({ songKey });
    if (cachedSong) {
        // Verify the storage URL is still valid by checking file exists
        const file = bucket.file(cachedSong.storagePath);
        const [exists] = await file.exists();
        if (exists) {
            console.log(`[CACHE HIT] "${songKey}" already in MongoDB & Storage`);
            return { storageUrl: cachedSong.storageUrl, storagePath: cachedSong.storagePath, cached: true };
        }
        console.log(`[CACHE MISS] "${songKey}" file missing from storage, re-downloading...`);
    }

    // Download MP3 from external API
    console.log(`[DOWNLOADING] "${songKey}" from SoundCloud...`);
    const downloadResponse = await axios.post(`https://rest-apins.vercel.app/api/downloader/soundcloud-v2`, {
        url: scUrl
    });

    const data = downloadResponse.data;
    if (!data || !data.result) {
        throw new Error('Failed to get download URL from external API');
    }

    const result = data.result;
    const mp3Url = result.downloadUrl || result.url;
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

    // Save to MongoDB for deduplication
    await CachedSong.findOneAndUpdate(
        { songKey },
        {
            songKey,
            title,
            artist,
            storageUrl: downloadUrl,
            storagePath,
            artwork: '', // You can add thumbnail here if available
            cachedAt: new Date()
        },
        { upsert: true }
    );

    console.log(`[UPLOADED] "${songKey}" to Firebase Storage & MongoDB → ${storagePath}`);

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
    const user = req.userProfile;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Playlist name is required', success: false });
    }

    try {
        // Check playlist limits
        const playlistsSnapshot = await rtdb.ref(`users/${uid}/playlists`).get();
        const count = playlistsSnapshot.exists() ? Object.keys(playlistsSnapshot.val()).length : 0;
        
        if (user.status === 'free') {
            return res.status(403).json({ error: 'Free users cannot create playlists. Upgrade to Starter!', success: false });
        } else if (user.status === 'starter' && count >= 2) {
            return res.status(403).json({ error: 'Starter plan limit reached (2 playlists). Upgrade to Popular for unlimited!', success: false });
        }

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
        
        // Check if cached (MongoDB)
        const cachedSong = await CachedSong.findOne({ songKey });
        
        if (cachedSong) {
            const file = bucket.file(cachedSong.storagePath);
            const [exists] = await file.exists();
            if (exists) {
                const [downloadUrl] = await file.getSignedUrl({
                    action: 'read',
                    expires: Date.now() + 365 * 24 * 60 * 60 * 1000
                });
                
                console.log(`[GET-CACHED] Found "${songKey}" in MongoDB - returning permanent URL`);
                res.json({ success: true, storageUrl: downloadUrl, cached: true });
                return;
            }
        }
        
        // Not cached yet - download and cache it
        console.log(`[GET-CACHED] "${songKey}" not in MongoDB, downloading...`);
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
