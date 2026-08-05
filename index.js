require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

// --- Firebase Admin Initialization with User Provided Service Account ---
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
