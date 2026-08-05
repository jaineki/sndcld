require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

// --- Firebase Admin Initialization ---
const serviceAccount = {
  "type": "service_account",
  "project_id": "mp3-and-users",
  "private_key_id": "5351802006a246b29aab9b628adfd156f2e101e6",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCeYEax3VvM8kwI\nlmcFCtD4RWwjbzHTIwCMGqegM51zE3XLLjRIXTExJiCq31uIJqCh+LqpPbwJA2Ag\nbP48ZFMnRebBXkNUvBa4/75A3Aia2Aq+GKPJpiCkwHYDXDZYNHB8zUUokoEfDPQr\nwiLDgCaaNQyLj6DWmk1fuEUgX3Y0EwpMyOj20TB9rHL9ugJRP1Mu0qYYHakGEtja\n9h8C0HVMdpP2KYszfY4r9J2VnLA0wG+wbx9DXFIpcGEZMPs7Sx9ZN5BSfXPGBt9j\nfJ6wchSlF/wgz6rr9kdMD4ANw+ngiRsl6dwsfltp4bKzJ2sPJQSRTlHCA0WZ5xTH\nWxF6zGJ5AgMBAAECggEACLCnsGLBAsHYwi/efzxUswq8IEWdqkQlZ4qe3/91CDdt\nIzTp0X6rkFLTQAz5bMMR1VFcjKTCiIwS3jSczpuCpIkFXF7buu6HIKeHvO9V2Yk5\nLa0Ub6AZ8nBNCWop4TUfZvmsbcl8JEQFsdD5L1j8xUFb6tx6qsvUqwflYx1Z0wmS\nUj10YaogybF+t2n2IPouL0ysdcaDRFe3V30siMJIa7L/pSEtaa9cryKzlBBCqbe9\nS/4q/O8tSyD8Ar04KwvQxqP+MUJRPsXzNBviiaocE1/iTOWjNjAh8wrJ7ZjnV5Xn\n8EVWHeaWnDCL/klfb77omFj3puPjSt7tQ6N69BY8sQKBgQDJ7SL+9GYR5a6KMm+L\nWVy6f5Kuz7lVGmhTifYp6JBz+S9BzvwUvqWngp/Z6HjtbQFz/GY7BMglmJgtkmpc\nocYVzHdtyD8bpTVRVJgOmQSRxW5qDPajzNvBfSRAx5cleOHCsjn71SOdMHp//kwt\nbXVfo0WiAyPP/ZjlFkiKA4UaawKBgQDIyZhX/WYanqngL8Ng1R9PZUsWt4WSFHWT\n5VLSOV+Hl2C2GE+835LR+xnpEWMRhKf83IJFslKFPz2jLCJj64gurbphYg5Tfo/r\nUCr+wNB77wrW7x43ixMb750nU6RMxUBLxHfkqr075Ajt4JzBZW9DmDWtwy1UGN9n\nm2CnY9R3qwKBgQDBIG49PNE2wt9Jy+1FcQWwVf2b9o7Cp4wqgiQPdyBZ23VoUqhk\nyuazLMroZmDqbDxci4XXYr5uvuCljYju6ccD6Fg9hq1dKoixLeB07cMiDJuLELUA\nexmfmKoIzxxvuYrrZPzyMKtsVwaCzlxbgnolK4qY5rnk3x7R1JsybSVr2wKBgQCZ\nRBlAATOxWi+963euMMDnsCBzRL921Jszu7dOtXDQZaLzHPew6tB97LjIifcfZi18\n/S2L2iTXhYCdT5EoyJ95Ui+VKm5ZGaDuNJG9SJ1cHQofKwPbzhNWHb/ORzCBUYhU\nzbHfIN22G8kdG3lMvwsBg+xlqTiumxXdVmOfIrsKZQKBgDP5p/lRKjFWV031NYcG\nEU68KFt3wu+5jbWEsMJweWzPm+Qgj2ckSZz1IrP/JjJH2M0BbP7ibs4EnLJKWhm2\nd1A9kcmGpTOvVNH5VayCHKRHnqc5A8SVEiHHrqTkzJpbnj+jGDpUM++AxH8RUyck\nMcuWQXcEDlJRzkKsyEhzUMNj\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@mp3-and-users.iam.gserviceaccount.com",
  "client_id": "106982718206576352010",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40mp3-and-users.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://mp3-and-users-default-rtdb.asia-southeast1.firebasedatabase.app'
    });
    console.log("Firebase Admin (Realtime Database) Initialized Successfully");
} catch (error) {
    console.error("Firebase Admin Initialization Error:", error.message);
}

// Use Realtime Database (fast, no lag for writes)
const rtdb = admin.database();
const auth = admin.auth();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// CORS Configuration
const allowedOrigins = ['https://searchmusic.gt.tc', 'http://searchmusic.gt.tc', 'https://jayspotifyweb.onrender.com', 'http://localhost:3000'];
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

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'jay-music-secret-7d8d',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
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

// Get User Collection (recentlyPlayed, favorites, etc.)
app.get('/api/user/:collection', verifyToken, async (req, res) => {
    const { collection } = req.params;
    const uid = req.user.uid;
    try {
        const snapshot = await rtdb.ref(`users/${uid}/${collection}`).orderByChild('createdAt').limitToLast(100).get();
        const data = [];
        snapshot.forEach(child => {
            data.push({ id: child.key, ...child.val() });
        });
        data.reverse(); // Most recent first
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

// Structure:
// users/{uid}/playlists/{playlistId} -> { name, createdAt }
// playlistSongs/{playlistId}/{position} -> { songId, songData, addedAt }

// Create a new playlist (FAST - direct write to Realtime DB)
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

// Add a song to a playlist (FAST - direct write to Realtime DB)
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

        // Build clean song object
        const songData = {
            songId: song.songId || song.url || Date.now().toString(),
            title: song.title || 'Unknown',
            artist: song.artist || song.author || '',
            artwork: song.thumbnail || song.artwork || '',
            streamUrl: song.url || '',
            addedAt: new Date().toISOString(),
            position: position
        };

        // Write to playlistSongs/{playlistId}/{position}
        await rtdb.ref(`playlistSongs/${playlistId}/${position}`).set(songData);

        console.log(`Song added to playlist: ${playlistId} position: ${position}`);
        res.json({ success: true, position, song: songData });
    } catch (error) {
        console.error("Add song error:", error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

// Get all playlists for a user (FAST - one read)
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

        // For each playlist, get song count from playlistSongs
        for (const pl of playlists) {
            const songsSnapshot = await rtdb.ref(`playlistSongs/${pl.id}`).get();
            pl.songs = songsSnapshot.exists() ? songsSnapshot.val() : {};
            pl.songCount = songsSnapshot.exists() ? Object.keys(pl.songs).length : 0;
        }

        // Sort by createdAt descending (newest first)
        playlists.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json(playlists);
    } catch (error) {
        console.error("Playlists fetch error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get songs in a specific playlist (FAST)
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
        songs.sort((a, b) => a.position - b.position);

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
        // Delete playlistSongs first
        await rtdb.ref(`playlistSongs/${playlistId}`).remove();
        // Delete playlist
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
        // Find and remove the song
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

// Create playlist and add song in ONE request (FAST - avoids double round-trip)
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
        // Step 1: Create playlist
        const playlistRef = rtdb.ref(`users/${uid}/playlists`).push();
        const playlistId = playlistRef.key;
        
        await playlistRef.set({
            name: name.trim(),
            createdAt: new Date().toISOString()
        });

        // Step 2: Add song in one atomic operation using multi-path update
        const songData = {
            songId: song.songId || song.url || Date.now().toString(),
            title: song.title || 'Unknown',
            artist: song.artist || song.author || '',
            artwork: song.thumbnail || song.artwork || '',
            streamUrl: song.url || '',
            addedAt: new Date().toISOString(),
            position: 0
        };

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
