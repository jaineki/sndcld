require('dotenv').config();
const express = require('express');
const session = require('express-session');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// JWT Middleware to protect routes
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ message: 'Access Denied: No Token Provided' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid Token' });
        req.user = user;
        next();
    });
};

// Login Route (Dummy for demonstration)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // In a real app, you'd verify against a database
    if (username === 'admin' && password === 'password') {
        const user = { name: username };
        const accessToken = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' });
        
        // Also set session
        req.session.user = user;
        
        res.json({ accessToken });
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
    }
});

// Secured SoundCloud Search Proxy
app.get('/api/search', authenticateToken, async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ message: 'Query is required' });

    try {
        const response = await axios.get(`https://api.ferdev.my.id/search/soundcloud`, {
            params: {
                query: query,
                apikey: process.env.EXTERNAL_API_KEY
            }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching from external API', error: error.message });
    }
});

// Secured SoundCloud Downloader Proxy
app.get('/api/download', authenticateToken, async (req, res) => {
    const { link } = req.query;
    if (!link) return res.status(400).json({ message: 'Link is required' });

    try {
        const response = await axios.get(`https://api.ferdev.my.id/downloader/soundcloud`, {
            params: {
                link: link,
                apikey: process.env.EXTERNAL_API_KEY
            }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching from external API', error: error.message });
    }
});

// Catch-all to serve index.html
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
