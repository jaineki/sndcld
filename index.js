require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const admin = require("firebase-admin");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

console.log("FIREBASE_SERVICE_ACCOUNT exists:", !!process.env.FIREBASE_SERVICE_ACCOUNT);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

console.log("Project ID:", serviceAccount.project_id);
console.log("Client Email:", serviceAccount.client_email);

const db = getFirestore();
const auth = getAuth();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// CORS Configuration
const allowedOrigins = ['https://searchmusic.gt.tc', 'http://searchmusic.gt.tc', 'http://localhost:3000'];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(new Error('CORS policy violation'), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

app.use(express.static('public'));

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Middleware to verify Firebase ID Token
const verifyFirebaseToken = async (req, res, next) => {
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
app.post('/api/user/sync', verifyFirebaseToken, async (req, res) => {
    const { uid, email, displayName, photoURL, provider } = req.body;
    const userRef = db.collection('users').doc(uid);
    
    try {
        await userRef.set({
            uid,
            email,
            displayName,
            photoURL,
            provider,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastLogin: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        // Ensure subcollections exist or initialize if needed
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

// --- User Library Endpoints (Private Data) ---

app.get('/api/library/:collection', verifyFirebaseToken, async (req, res) => {
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

app.post('/api/library/:collection', verifyFirebaseToken, async (req, res) => {
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

// Catch-all to serve index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
