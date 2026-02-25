require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Root redirect — visitors without a QR token go to staff login
app.get('/', (req, res) => {
    res.redirect('/staff');
});

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Initialize database (runs migrations + seed on first load)
require('./db');

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/tables', require('./routes/tables'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/sse', require('./routes/sse'));

// ─── HTML Route Handlers ──────────────────────────────────────

// Customer ordering page (from QR scan)
app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Order tracking
app.get('/track', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Pay bill
app.get('/pay', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Staff login
app.get('/staff', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'staff.html'));
});

// Kitchen dashboard
app.get('/kitchen', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'kitchen.html'));
});

// Waiter dashboard
app.get('/waiter', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'waiter.html'));
});

// Admin panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// DB health check (debug)
app.get('/api/health/db', async (req, res) => {
    try {
        const db = require('./db');
        const supabaseUrl = process.env.SUPABASE_URL || 'NOT SET';
        const result = await db.query('SELECT COUNT(*) as count FROM users');
        res.json({
            status: 'connected',
            db_host: supabaseUrl,
            users_count: result.rows[0].count,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        const supabaseUrl = process.env.SUPABASE_URL || 'NOT SET';
        res.status(500).json({
            status: 'error',
            db_host: supabaseUrl,
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'API endpoint not found' });
    } else {
        res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`\n🍽️  QR Restaurant Server running on http://localhost:${PORT}`);
    console.log(`\n   Customer:  http://localhost:${PORT}/order?token=<qr_token>`);
    console.log(`   Kitchen:   http://localhost:${PORT}/kitchen`);
    console.log(`   Waiter:    http://localhost:${PORT}/waiter`);
    console.log(`   Admin:     http://localhost:${PORT}/admin`);
    console.log(`   Staff:     http://localhost:${PORT}/staff\n`);
});

module.exports = app;
