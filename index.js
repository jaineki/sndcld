require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

// --- Firebase Admin Initialization ---
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Handle JSON string from environment variable (Render)
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        // Fallback to local file for development
        serviceAccount = require('./serviceAccountKey.json');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    console.log("Firebase Admin Initialized Successfully");
} catch (error) {
    console.error("Firebase Admin Initialization Error:", error.message);
}

const db = admin.firestore();
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
        res.status(401).json({ error: 'Invalid token' });
    }
};

// --- API Endpoints ---

// User Profile Sync
app.post('/api/user/sync', verifyToken, async (req, res) => {
    const { uid, email, displayName, photoURL, provider } = req.body;
    try {
        await db.collection('users').doc(uid).set({
            uid, email, displayName, photoURL, provider,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastLogin: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ success: true });
    } catch (error) {
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
        res.status(500).json({ message: 'Download error', error: error.message });
    }
});

// --- User Data Persistence (History, Favorites, Playlists) ---

// Get User Library Collection
app.get('/api/user/:collection', verifyToken, async (req, res) => {
    const { collection } = req.params;
    const uid = req.user.uid;
    try {
        const snapshot = await db.collection('users').doc(uid).collection(collection).orderBy('createdAt', 'desc').get();
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add to Library Collection (History, Favorites, etc.)
app.post('/api/user/:collection', verifyToken, async (req, res) => {
    const { collection } = req.params;
    const uid = req.user.uid;
    const item = req.body;
    try {
        const docRef = await db.collection('users').doc(uid).collection(collection).add({
            ...item,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ id: docRef.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Playlist Management
app.post('/api/user/playlists/create', verifyToken, async (req, res) => {
    const { name } = req.body;
    const uid = req.user.uid;
    try {
        const docRef = await db.collection('users').doc(uid).collection('playlists').add({
            name,
            songs: [],
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ id: docRef.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/playlists/add-song', verifyToken, async (req, res) => {
    const { playlistId, song } = req.body;
    const uid = req.user.uid;
    try {
        const playlistRef = db.collection('users').doc(uid).collection('playlists').doc(playlistId);
        await playlistRef.update({
            songs: admin.firestore.FieldValue.arrayUnion({
                ...song,
                addedAt: new Date().toISOString()
            })
        });
        res.json({ success: true });
    } catch (error) {
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
