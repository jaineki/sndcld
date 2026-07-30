require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const axios = require('axios');
const { body, query, validationResult, matchedData } = require('express-validator');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// ==============================
// SECURITY CONFIGURATION
// ==============================

// 1. Remove X-Powered-By header
app.disable('x-powered-by');

// 2. Helmet middleware for secure HTTP headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:", "via.placeholder.com"],
            fontSrc: ["'self'", "cdnjs.cloudflare.com"],
            connectSrc: ["'self'", "api.ferdev.my.id"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
        }
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    frameguard: {
        action: 'deny'
    },
    noSniff: true,
    referrerPolicy: {
        policy: 'strict-origin-when-cross-origin'
    }
}));

// 3. Strict CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',') 
    : ['http://localhost:3000', 'https://jayspotifyweb.onrender.com/'];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Length', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    credentials: true,
    maxAge: 86400 // 24 hours
}));

// 4. Rate Limiting
// Global rate limiter
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
        success: false,
        message: 'Too many requests from this IP, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true // Don't count successful requests towards limit
});

// API-specific rate limiter (stricter)
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    message: {
        success: false,
        message: 'API rate limit exceeded. Please wait a moment before trying again.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Apply rate limiters
app.use('/api', globalLimiter);
app.use('/api/search', apiLimiter);
app.use('/api/download', apiLimiter);

// 5. Compression for performance
app.use(compression({
    threshold: 1024, // Only compress responses above 1KB
    level: 6 // Balanced compression level
}));

// 6. Logging (without exposing secrets)
app.use(morgan('combined', {
    skip: function(req, res) { 
        return res.statusCode < 400; // Only log errors in production
    },
    stream: process.stderr
}));

// Detailed logging in development
if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
}

// 7. Body parsing middleware with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==============================
// STATIC FILE SERVING
// ==============================

// Secure static file serving
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1y',
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
        // Prevent caching of HTML files
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        // Security headers for static files
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

// Disable directory listing
app.use('/public', (req, res, next) => {
    res.status(403).json({
        success: false,
        message: 'Access denied'
    });
});

// Prevent access to sensitive files
app.use(['/.env', '/package.json', '/.gitignore', '/.env.example'], (req, res) => {
    res.status(403).json({
        success: false,
        message: 'Access denied'
    });
});

// ==============================
// INPUT VALIDATION MIDDLEWARE
// ==============================

const validateSearchQuery = [
    query('query')
        .trim()
        .isString()
        .withMessage('Search query must be a string')
        .isLength({ min: 1, max: 200 })
        .withMessage('Search query must be between 1 and 200 characters')
        .matches(/^[a-zA-Z0-9\s\-_\.]+$/)
        .withMessage('Search query contains invalid characters')
        .escape()
];

const validateDownloadLink = [
    query('link')
        .trim()
        .isURL({ protocols: ['https'], require_protocol: true })
        .withMessage('Invalid SoundCloud URL')
        .matches(/^https:\/\/(soundcloud\.com|on\.soundcloud\.com)\//)
        .withMessage('Invalid SoundCloud domain')
        .isLength({ max: 500 })
        .withMessage('URL is too long')
];

// Validation error handler middleware
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors.array().map(err => err.msg)
        });
    }
    next();
};

// ==============================
// API ROUTES
// ==============================

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is healthy',
        timestamp: new Date().toISOString()
    });
});

// Search endpoint
app.get('/api/search',
    validateSearchQuery,
    handleValidationErrors,
    async (req, res, next) => {
        try {
            const { query } = matchedData(req);
            const apiKey = process.env.SOUNDCLOUD_API_KEY;
            
            if (!apiKey) {
                throw new Error('API key not configured');
            }

            const searchUrl = 'https://api.ferdev.my.id/search/soundcloud';
            
            const response = await axios.get(searchUrl, {
                params: {
                    query: query,
                    apikey: apiKey
                },
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; JayBoholMusic/1.0)'
                }
            });

            // Sanitize and format response
            const data = response.data;
            
            // Check if we got a valid response
            if (data.succes !== undefined && data.result) {
                // Transform the response to our format
                const results = data.result.map(track => ({
                    title: track.title || 'Unknown Title',
                    url: track.url || '',
                    thumbnail: track.thumbnail || 'https://via.placeholder.com/150',
                    author: track.author || 'Unknown Artist',
                    duration: track.duration || 0
                }));

                res.json({
                    success: true,
                    message: `Found ${results.length} tracks`,
                    data: results
                });
            } else {
                // Handle unexpected response format
                res.json({
                    success: true,
                    message: 'No tracks found',
                    data: []
                });
            }

        } catch (error) {
            next(error); // Pass to error handler
        }
    }
);

// Download endpoint
app.get('/api/download',
    validateDownloadLink,
    handleValidationErrors,
    async (req, res, next) => {
        try {
            const { link } = matchedData(req);
            const apiKey = process.env.SOUNDCLOUD_API_KEY;
            
            if (!apiKey) {
                throw new Error('API key not configured');
            }

            const downloadUrl = 'https://api.ferdev.my.id/downloader/soundcloud';
            
            const response = await axios.get(downloadUrl, {
                params: {
                    link: link,
                    apikey: apiKey
                },
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; JayBoholMusic/1.0)'
                }
            });

            const data = response.data;

            if (data.success && data.result) {
                // Format the response
                const trackInfo = {
                    title: data.result.title || 'Unknown Title',
                    author: data.result.author || 'Unknown Artist',
                    thumbnail: data.result.thumbnail || 'https://via.placeholder.com/150',
                    downloadUrl: data.result.downloadUrl || '',
                    duration: data.result.duration || 0
                };

                res.json({
                    success: true,
                    message: 'Track information retrieved successfully',
                    data: trackInfo
                });
            } else {
                // Handle unsuccessful response
                res.status(404).json({
                    success: false,
                    message: 'Could not retrieve track information'
                });
            }

        } catch (error) {
            next(error);
        }
    }
);

// ==============================
// CENTRALIZED ERROR HANDLING
// ==============================

// Global error handler middleware
app.use((err, req, res, next) => {
    // Log error (but hide sensitive details)
    console.error('Error occurred:', {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        ip: req.ip,
        error: err.message
    });

    // Determine status code
    let statusCode = 500;
    let message = 'An internal server error occurred';

    if (err.response) {
        // Axios error
        statusCode = err.response.status || 500;
        message = err.response.data?.message || err.message || 'External service error';
    } else if (err.code === 'ECONNABORTED') {
        statusCode = 504;
        message = 'Request timeout';
    } else if (err.message === 'API key not configured') {
        statusCode = 500;
        message = 'Service configuration error';
    } else if (err.message.includes('Not allowed by CORS')) {
        statusCode = 403;
        message = 'Access denied';
    }

    // Send clean error response
    res.status(statusCode).json({
        success: false,
        message: message
    });
});

// Handle 404 errors
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    });
});

// ==============================
// UNCAUGHT EXCEPTION HANDLING
// ==============================

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    // Log error but keep process alive
    // In production, you might want to restart the process
});

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});

// ==============================
// START SERVER
// ==============================

app.listen(PORT, () => {
    console.log(`🚀 Jay Bohol SoundCloud Music Server running on port ${PORT}`);
    console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔒 Security: ${process.env.NODE_ENV === 'production' ? 'Enabled' : 'Development mode'}`);
});

// Export app for testing
module.exports = app;
