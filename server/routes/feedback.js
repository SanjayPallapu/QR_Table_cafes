const express = require('express');
const router = express.Router();
const db = require('../db');

// POST /api/feedback — Submit feedback from customer
router.post('/', async (req, res) => {
    try {
        const { table_token, order_id, rating, comment } = req.body;

        if (!table_token || !rating) {
            return res.status(400).json({ error: 'table_token and rating are required' });
        }

        // Validate table
        const table = await db.prepare(
            'SELECT id, restaurant_id FROM tables WHERE qr_token = ? AND active = 1'
        ).get(table_token);
        if (!table) return res.status(404).json({ error: 'Invalid table' });

        // Insert feedback
        const result = await db.prepare(
            'INSERT INTO feedback (restaurant_id, order_id, table_id, rating, comment) VALUES (?, ?, ?, ?, ?)'
        ).run(table.restaurant_id, order_id || null, table.id, rating, comment || '');

        res.json({ success: true, feedback_id: result.lastInsertRowid });
    } catch (err) {
        console.error('Feedback error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/feedback — Get feedback for admin
const { authenticateToken, requireRole } = require('../middleware/auth');

router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const feedbacks = await db.prepare(
            `SELECT f.*, t.table_number 
             FROM feedback f 
             LEFT JOIN tables t ON f.table_id = t.id 
             WHERE f.restaurant_id = ? 
             ORDER BY f.created_at DESC LIMIT 100`
        ).all(req.user.restaurant_id);

        // Summary stats
        const stats = await db.prepare(
            `SELECT COUNT(*) as total, ROUND(AVG(rating), 1) as avg_rating,
                    SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive,
                    SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative
             FROM feedback WHERE restaurant_id = ?`
        ).get(req.user.restaurant_id);

        res.json({ feedbacks, stats });
    } catch (err) {
        console.error('Feedback fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
