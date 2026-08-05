require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
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
        databaseURL: dbUrl
    });
    console.log("Firebase Admin (Realtime Database) Initialized Successfully");
    console.log("Database URL:", dbUrl);
} catch (error) {
    console.error("Firebase Admin Initialization Error:", error.message);
    process.exit(1);
}

const rtdb = admin.database();
const auth = admin.auth();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

// --- API Endpoints ---

// User Profile Sync (Realtime DB)
app.post('/api/user/sync', verifyToken, async (req, res) => {
    const { uid, email, displayName, photoURL, provider } = req.body;
    try {
        const userRef = rtdb.ref(`users/${uid}`);
        await userRef.update({
            uid,
            email,
            displayName,
            photoURL,
            provider,
            updatedAt: new Date().toISOString(),
            lastLogin: new Date().toISOString()
        });
        res.json({ success: true });
    } catch (error) {
        console.error("User sync error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// SoundCloud Search Proxy
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

// SoundCloud Downloader Proxy
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

// --- USER DATA (Realtime DB) ---
// FIX: Read data directly without orderByChild to avoid index requirement
// Data is sorted client-side after retrieval

// Get User Collection (recentlyPlayed, favorites, etc.)
app.get('/api/user/:collection', verifyToken, async (req, res) => {
    const { collection } = req.params;
    const uid = req.user.uid;
    try {
        // Read all data without orderByChild (avoids index error)
        const snapshot = await rtdb.ref(`users/${uid}/${collection}`).get();
        const data = [];
        
        if (snapshot.exists()) {
            snapshot.forEach(child => {
                const val = child.val();
                data.push({ id: child.key, ...val });
            });
        }
        
        // Sort client-side by createdAt descending (newest first)
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

// --- PLAYLIST MANAGEMENT (Realtime DB - FAST) ---

// Create a new playlist
app.post('/api/user/playlists/create', verifyToken, async (req, res) => {
    const { name } = req.body;
    const uid = req.user.uid;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Playlist name is required' });
    }

    try {
        const playlistRef = rtdb.ref(`users/${uid}/playlists`).push();
        const playlistId = playlistRef.key;
        
        await playlistRef.set({
            name: name.trim(),
            createdAt: new Date().toISOString()
        });

        // Initialize empty PlaylistSongs entry
        await rtdb.ref(`playlistSongs/${playlistId}`).set({});

        console.log(`Playlist created: ${name} (id: ${playlistId}) for user: ${uid}`);
        res.json({
            success: true,
            id: playlistId,
            playlist: {
                id: playlistId,
                name: name.trim(),
                createdAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error("Playlist creation error:", error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

// Add a song to a playlist
app.post('/api/user/playlists/add-song', verifyToken, async (req, res) => {
    const { playlistId, song } = req.body;
    const uid = req.user.uid;

    if (!playlistId) {
        return res.status(400).json({ error: 'Playlist ID is required' });
    }
    if (!song) {
        return res.status(400).json({ error: 'Song data is required' });
    }

    try {
        // Verify playlist belongs to user
        const playlistRef = rtdb.ref(`users/${uid}/playlists/${playlistId}`);
        const snapshot = await playlistRef.get();

        if (!snapshot.exists()) {
            return res.status(404).json({ error: 'Playlist not found', success: false });
        }

        // Get current song count to determine position
        const songsRef = rtdb.ref(`playlistSongs/${playlistId}`);
        const songsSnapshot = await songsRef.get();
        let position = 0;
        if (songsSnapshot.exists()) {
            const songsData = songsSnapshot.val();
            position = Object.keys(songsData).length;
        }

        const songData = {
            songId: song.songId || song.url || Date.now().toString(),
            title: song.title || 'Unknown',
            artist: song.artist || song.author || '',
            artwork: song.thumbnail || song.artwork || '',
            streamUrl: song.url || '',
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

// Get all playlists for a user (FAST - direct read, no index needed)
app.get('/api/user/playlists', verifyToken, async (req, res) => {
    const uid = req.user.uid;
    try {
        // Read playlists directly without orderByChild
        const snapshot = await rtdb.ref(`users/${uid}/playlists`).get();
        const playlists = [];
        
        if (snapshot.exists()) {
            snapshot.forEach(child => {
                playlists.push({ id: child.key, ...child.val() });
            });
        }

        // For each playlist, get song count from playlistSongs
        for (const pl of playlists) {
            const songsSnapshot = await rtdb.ref(`playlistSongs/${pl.id}`).get();
            pl.songs = songsSnapshot.exists() ? songsSnapshot.val() : {};
            pl.songCount = songsSnapshot.exists() ? Object.keys(pl.songs).length : 0;
        }

        // Sort client-side by createdAt descending (newest first)
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
        // Verify playlist belongs to user
        const playlistRef = rtdb.ref(`users/${uid}/playlists/${playlistId}`);
        const snapshot = await playlistRef.get();
        
        if (!snapshot.exists()) {
            return res.status(404).json({ error: 'Playlist not found' });
        }

        // Get songs
        const songsRef = rtdb.ref(`playlistSongs/${playlistId}`);
        const songsSnapshot = await songsRef.get();
        
        const songs = [];
        if (songsSnapshot.exists()) {
            songsSnapshot.forEach(child => {
                songs.push({ position: child.key, ...child.val() });
            });
        }

        // Sort by position
        songs.sort((a, b) => (a.position || 0) - (b.position || 0));

        res.json({ playlist: { id: playlistId, ...snapshot.val() }, songs });
    } catch (error) {
        console.error("Get playlist songs error:", error.message);
        res.status(500).json({ error: error.message });
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

// Create playlist and add song in ONE request (FAST)
app.post('/api/user/playlists/create-and-add', verifyToken, async (req, res) => {
    const { name, song } = req.body;
    const uid = req.user.uid;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Playlist name is required' });
    }
    if (!song) {
        return res.status(400).json({ error: 'Song data is required' });
    }

    try {
        const playlistRef = rtdb.ref(`users/${uid}/playlists`).push();
        const playlistId = playlistRef.key;

        const songData = {
            songId: song.songId || song.url || Date.now().toString(),
            title: song.title || 'Unknown',
            artist: song.artist || song.author || '',
            artwork: song.thumbnail || song.artwork || '',
            streamUrl: song.url || '',
            addedAt: new Date().toISOString(),
            position: 0
        };

        // Atomic multi-path update
        await rtdb.ref().update({
            [`users/${uid}/playlists/${playlistId}`]: {
                name: name.trim(),
                createdAt: new Date().toISOString()
            },
            [`playlistSongs/${playlistId}/0`]: songData
        });

        console.log(`Playlist + song created: ${playlistId} for user: ${uid}`);
        res.json({ success: true, id: playlistId, song: songData });
    } catch (error) {
        console.error("Create and add error:", error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

// Catch-all to serve index.html
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
