const express = require('express');
const router = express.Router();
const db = require('../db');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireRole } = require('../middleware/auth');

// ─── Public: Validate QR token ────────────────────────────────

// GET /api/tables/validate/:token
router.get('/validate/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const table = await db.prepare(
            `SELECT t.id, t.table_number, t.seats, t.restaurant_id,
              r.name as restaurant_name, r.description as restaurant_description,
              r.prepaid_enabled, r.postpaid_enabled
       FROM tables t
       JOIN restaurants r ON t.restaurant_id = r.id
       WHERE t.qr_token = ? AND t.active = 1`
        ).get(token);

        if (!table) {
            return res.status(404).json({ error: 'Invalid or inactive table' });
        }

        // Check for active unpaid postpaid orders on this table
        const activeOrder = await db.prepare(
            `SELECT o.id, o.public_status, o.payment_mode, o.total_amount, o.created_at
       FROM orders o
       WHERE o.table_id = ? AND o.payment_mode = 'POSTPAID'
       AND o.internal_status != 'SERVED'
       ORDER BY o.created_at DESC LIMIT 1`
        ).get(table.id);

        // Check for unpaid postpaid orders that are served (waiting for payment)
        const unpaidOrder = await db.prepare(
            `SELECT o.id, o.total_amount, o.created_at
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id AND p.verified = 1
       WHERE o.table_id = ? AND o.payment_mode = 'POSTPAID'
       AND o.internal_status = 'SERVED' AND p.id IS NULL
       ORDER BY o.created_at DESC LIMIT 1`
        ).get(table.id);

        res.json({
            table_id: table.id,
            table_number: table.table_number,
            seats: table.seats,
            restaurant_id: table.restaurant_id,
            restaurant_name: table.restaurant_name,
            restaurant_description: table.restaurant_description,
            prepaid_enabled: table.prepaid_enabled,
            postpaid_enabled: table.postpaid_enabled,
            active_order: activeOrder || null,
            unpaid_order: unpaidOrder || null
        });
    } catch (err) {
        console.error('Table validate error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Admin: Table management ──────────────────────────────────

// GET /api/tables
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const tables = await db.prepare(
            'SELECT * FROM tables WHERE restaurant_id = ? ORDER BY table_number'
        ).all(req.user.restaurant_id);
        res.json(tables);
    } catch (err) {
        console.error('Tables list error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/tables
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { table_number, seats } = req.body;
        if (!table_number) return res.status(400).json({ error: 'Table number is required' });

        const existing = await db.prepare(
            'SELECT id FROM tables WHERE restaurant_id = ? AND table_number = ?'
        ).get(req.user.restaurant_id, table_number);
        if (existing) return res.status(409).json({ error: 'Table number already exists' });

        const qr_token = uuidv4();
        const result = await db.prepare(
            'INSERT INTO tables (restaurant_id, table_number, qr_token, seats) VALUES (?, ?, ?, ?)'
        ).run(req.user.restaurant_id, table_number, qr_token, seats || 4);

        const table = await db.prepare('SELECT * FROM tables WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(table);
    } catch (err) {
        console.error('Table create error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/tables/:id
router.put('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { table_number, seats, active } = req.body;
        const table = await db.prepare('SELECT * FROM tables WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.user.restaurant_id);
        if (!table) return res.status(404).json({ error: 'Table not found' });

        if (table_number && table_number !== table.table_number) {
            const existing = await db.prepare(
                'SELECT id FROM tables WHERE restaurant_id = ? AND table_number = ? AND id != ?'
            ).get(req.user.restaurant_id, table_number, req.params.id);
            if (existing) return res.status(409).json({ error: 'Table number already exists' });
        }

        await db.prepare(
            'UPDATE tables SET table_number = ?, seats = ?, active = ? WHERE id = ?'
        ).run(table_number || table.table_number, seats ?? table.seats, active ?? table.active, req.params.id);

        const updated = await db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
        res.json(updated);
    } catch (err) {
        console.error('Table update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/tables/:id
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const table = await db.prepare('SELECT * FROM tables WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.user.restaurant_id);
        if (!table) return res.status(404).json({ error: 'Table not found' });

        await db.prepare('UPDATE tables SET active = 0 WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Table delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/tables/:id/qr — Generate QR code image
router.get('/:id/qr', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const table = await db.prepare('SELECT * FROM tables WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.user.restaurant_id);
        if (!table) return res.status(404).json({ error: 'Table not found' });

        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const qrUrl = `${baseUrl}/order?token=${table.qr_token}`;

        const qrImage = await QRCode.toDataURL(qrUrl, {
            width: 400,
            margin: 2,
            color: { dark: '#1a1a2e', light: '#ffffff' }
        });

        res.json({
            table_number: table.table_number,
            qr_token: table.qr_token,
            qr_url: qrUrl,
            qr_image: qrImage
        });
    } catch (err) {
        console.error('QR generate error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/tables/:id/regenerate-qr
router.post('/:id/regenerate-qr', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const table = await db.prepare('SELECT * FROM tables WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.user.restaurant_id);
        if (!table) return res.status(404).json({ error: 'Table not found' });

        const newToken = uuidv4();
        await db.prepare('UPDATE tables SET qr_token = ? WHERE id = ?').run(newToken, req.params.id);

        const updated = await db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
        res.json(updated);
    } catch (err) {
        console.error('QR regenerate error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/tables/call-waiter — Customer calls waiter
router.post('/call-waiter', async (req, res) => {
    try {
        const { table_token } = req.body;
        if (!table_token) return res.status(400).json({ error: 'Table token required' });

        const table = await db.prepare(
            'SELECT t.id, t.table_number, t.restaurant_id FROM tables t WHERE t.qr_token = ? AND t.active = 1'
        ).get(table_token);

        if (!table) return res.status(404).json({ error: 'Invalid table' });

        // Emit SSE event to waiter/kitchen dashboards
        const orderEvents = require('../utils/events');
        orderEvents.emit('call-waiter', {
            restaurant_id: table.restaurant_id,
            table_id: table.id,
            table_number: table.table_number,
            timestamp: new Date().toISOString()
        });

        res.json({ success: true, message: 'Waiter notified' });
    } catch (err) {
        console.error('Call waiter error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
