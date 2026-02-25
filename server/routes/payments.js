const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');
const orderEvents = require('../utils/events');

let Razorpay;
try {
    Razorpay = require('razorpay');
} catch (e) {
    console.warn('⚠️  Razorpay module not loaded — payment features will use mock mode');
}

function getRazorpayInstance() {
    if (!Razorpay) return null;
    if (!process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID === 'rzp_test_placeholder') return null;
    return new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
}

// ─── Create Razorpay Order ────────────────────────────────────

// POST /api/payments/create-order
router.post('/create-order', async (req, res) => {
    try {
        const { amount, table_token, items, payment_mode, notes, order_id } = req.body;

        if (!table_token) {
            return res.status(400).json({ error: 'table_token is required' });
        }
        if (!order_id && (!items || !items.length)) {
            return res.status(400).json({ error: 'Either order_id or items are required' });
        }

        // Validate table
        const table = db.prepare(
            'SELECT id, restaurant_id FROM tables WHERE qr_token = ? AND active = 1'
        ).get(table_token);
        if (!table) return res.status(404).json({ error: 'Invalid table' });

        // If paying for an existing order, just use its total
        let serverAmount = 0;

        if (order_id) {
            // Postpaid bill: look up order amount from database
            const existingOrder = await db.prepare(
                'SELECT total_amount FROM orders WHERE id = ? AND table_id = ?'
            ).get(order_id, table.id);
            if (!existingOrder) return res.status(404).json({ error: 'Order not found for this table' });
            serverAmount = existingOrder.total_amount;
        } else if (items && items.length) {
            // New prepaid order: calculate from items
            for (const item of items) {
                const menuItem = await db.prepare(
                    'SELECT price FROM menu_items WHERE id = ? AND active = 1'
                ).get(item.menu_item_id);
                if (!menuItem) return res.status(400).json({ error: `Item ${item.menu_item_id} not found` });
                serverAmount += menuItem.price * (item.quantity || 1);
            }
        } else {
            return res.status(400).json({ error: 'Either order_id or items are required' });
        }

        const amountInPaise = Math.round(serverAmount * 100);

        const razorpay = getRazorpayInstance();

        if (razorpay) {
            // Real Razorpay order
            const rpOrder = await razorpay.orders.create({
                amount: amountInPaise,
                currency: 'INR',
                receipt: `order_${Date.now()}`,
                notes: {
                    table_id: table.id.toString(),
                    restaurant_id: table.restaurant_id.toString()
                }
            });

            // Store payment record
            const result = await db.prepare(
                `INSERT INTO payments (restaurant_id, razorpay_order_id, amount, payment_mode, status)
         VALUES (?, ?, ?, ?, 'created')`
            ).run(table.restaurant_id, rpOrder.id, serverAmount, payment_mode || 'PREPAID');

            res.json({
                razorpay_order_id: rpOrder.id,
                amount: amountInPaise,
                currency: 'INR',
                key_id: process.env.RAZORPAY_KEY_ID,
                payment_id: result.lastInsertRowid
            });
        } else {
            // Mock mode for development
            const mockOrderId = `order_mock_${Date.now()}`;
            const result = await db.prepare(
                `INSERT INTO payments (restaurant_id, razorpay_order_id, amount, payment_mode, status)
         VALUES (?, ?, ?, ?, 'created')`
            ).run(table.restaurant_id, mockOrderId, serverAmount, payment_mode || 'PREPAID');

            res.json({
                razorpay_order_id: mockOrderId,
                amount: amountInPaise,
                currency: 'INR',
                key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock',
                payment_id: result.lastInsertRowid,
                mock_mode: true
            });
        }
    } catch (err) {
        console.error('Payment order error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Verify Payment ───────────────────────────────────────────

// POST /api/payments/verify
router.post('/verify', async (req, res) => {
    try {
        const { razorpay_payment_id, razorpay_order_id, razorpay_signature, table_token, items, payment_mode, notes, order_id } = req.body;

        if (!razorpay_order_id) {
            return res.status(400).json({ error: 'razorpay_order_id is required' });
        }

        // Validate table
        const table = await db.prepare(
            'SELECT id, restaurant_id FROM tables WHERE qr_token = ? AND active = 1'
        ).get(table_token);
        if (!table) return res.status(404).json({ error: 'Invalid table' });

        const payment = await db.prepare(
            'SELECT * FROM payments WHERE razorpay_order_id = ?'
        ).get(razorpay_order_id);
        if (!payment) return res.status(404).json({ error: 'Payment record not found' });

        const razorpay = getRazorpayInstance();
        let verified = false;

        if (razorpay && razorpay_signature) {
            // Real signature verification
            const body = razorpay_order_id + '|' + razorpay_payment_id;
            const expectedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                .update(body)
                .digest('hex');

            verified = expectedSignature === razorpay_signature;
        } else if (razorpay_order_id.startsWith('order_mock_')) {
            // Mock mode - auto-verify
            verified = true;
        }

        if (!verified) {
            // Payment failed
            await db.prepare(
                `UPDATE payments SET status = 'failed', razorpay_payment_id = ?, razorpay_signature = ?, updated_at = CURRENT_TIMESTAMP
         WHERE razorpay_order_id = ?`
            ).run(razorpay_payment_id || '', razorpay_signature || '', razorpay_order_id);

            return res.status(400).json({ error: 'Payment verification failed', verified: false });
        }

        // Payment verified!
        await db.prepare(
            `UPDATE payments SET status = 'paid', verified = 1, razorpay_payment_id = ?, razorpay_signature = ?, updated_at = CURRENT_TIMESTAMP
       WHERE razorpay_order_id = ?`
        ).run(razorpay_payment_id || 'mock_pay_' + Date.now(), razorpay_signature || '', razorpay_order_id);

        // For POSTPAID: Just mark the existing order as paid
        if (payment_mode === 'POSTPAID' && order_id) {
            await db.prepare('UPDATE payments SET order_id = ? WHERE razorpay_order_id = ?').run(order_id, razorpay_order_id);
            return res.json({
                verified: true,
                order_id: order_id,
                message: 'Payment verified. Bill is closed.'
            });
        }

        // For PREPAID: NOW create the order (order only reaches kitchen after payment)
        if (!items || !items.length) {
            return res.status(400).json({ error: 'Items required for prepaid order creation' });
        }

        // Calculate total server-side
        let totalAmount = 0;
        const orderItems = [];
        for (const item of items) {
            const menuItem = await db.prepare(
                'SELECT id, name, price FROM menu_items WHERE id = ? AND restaurant_id = ? AND active = 1'
            ).get(item.menu_item_id, table.restaurant_id);
            if (!menuItem) continue;
            const qty = item.quantity || 1;
            totalAmount += menuItem.price * qty;
            orderItems.push({
                menu_item_id: menuItem.id,
                item_name: menuItem.name,
                quantity: qty,
                price_at_order: menuItem.price,
                notes: item.notes || ''
            });
        }

        // Create order in transaction
        const createOrder = db.transaction(() => {
            const result = db.prepare(
                `INSERT INTO orders (restaurant_id, table_id, internal_status, public_status, payment_mode, total_amount, notes)
         VALUES (?, ?, 'PLACED', 'Order placed', 'PREPAID', ?, ?)`
            ).run(table.restaurant_id, table.id, totalAmount, notes || '');

            const newOrderId = result.lastInsertRowid;

            const insertItem = db.prepare(
                'INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price_at_order, notes) VALUES (?, ?, ?, ?, ?, ?)'
            );
            for (const oi of orderItems) {
                insertItem.run(newOrderId, oi.menu_item_id, oi.item_name, oi.quantity, oi.price_at_order, oi.notes);
            }

            // Link payment to order
            db.prepare('UPDATE payments SET order_id = ? WHERE razorpay_order_id = ?').run(newOrderId, razorpay_order_id);

            return newOrderId;
        });

        const newOrderId = createOrder();

        // Get full order for event
        const order = await db.prepare(
            `SELECT o.*, t.table_number FROM orders o JOIN tables t ON o.table_id = t.id WHERE o.id = ?`
        ).get(newOrderId);
        order.items = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(newOrderId);

        // Emit event for kitchen
        orderEvents.emit('new-order', {
            restaurant_id: table.restaurant_id,
            order
        });

        res.json({
            verified: true,
            order_id: newOrderId,
            public_status: 'Order placed',
            total_amount: totalAmount,
            message: 'Payment verified. Your order has been placed!'
        });
    } catch (err) {
        console.error('Payment verify error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Admin: payment reports ───────────────────────────────────

const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/payments/report
router.get('/report', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { date } = req.query;
        let query = `SELECT p.*, o.table_id, t.table_number
                 FROM payments p
                 LEFT JOIN orders o ON p.order_id = o.id
                 LEFT JOIN tables t ON o.table_id = t.id
                 WHERE p.restaurant_id = ?`;
        const params = [req.user.restaurant_id];

        if (date) {
            query += ` AND date(p.created_at) = ?`;
            params.push(date);
        }

        query += ` ORDER BY p.created_at DESC LIMIT 100`;

        const payments = await db.prepare(query).all(...params);

        // Summary
        const todayPayments = await db.prepare(
            `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM payments WHERE restaurant_id = ? AND verified = 1 AND date(created_at) = date('now')`
        ).get(req.user.restaurant_id);

        res.json({
            payments,
            today_summary: todayPayments
        });
    } catch (err) {
        console.error('Payment report error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
