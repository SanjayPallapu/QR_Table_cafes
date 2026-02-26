const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const orderEvents = require('../utils/events');

// Internal → Public status mapping
const STATUS_MAP = {
    'PLACED': 'Order placed',
    'PREPARING': 'Being prepared',
    'READY': 'Almost ready',
    'SERVED': 'Served'
};

// ─── Create Order (Postpaid or after Prepaid verification) ────

// POST /api/orders
router.post('/', async (req, res) => {
    try {
        const { table_token, items, payment_mode, notes } = req.body;

        if (!table_token || !items || !items.length || !payment_mode) {
            return res.status(400).json({ error: 'table_token, items, and payment_mode are required' });
        }

        if (!['PREPAID', 'POSTPAID'].includes(payment_mode)) {
            return res.status(400).json({ error: 'payment_mode must be PREPAID or POSTPAID' });
        }

        // Validate table
        const table = await db.prepare(
            'SELECT id, restaurant_id FROM tables WHERE qr_token = ? AND active = 1'
        ).get(table_token);
        if (!table) return res.status(404).json({ error: 'Invalid table' });

        // For PREPAID, this endpoint should only be called after payment verification
        // The payments/verify route calls this internally
        if (payment_mode === 'PREPAID' && !req._internalCall) {
            return res.status(400).json({ error: 'Prepaid orders must go through payment verification first' });
        }

        // Validate and calculate total
        let totalAmount = 0;
        const orderItems = [];

        for (const item of items) {
            const menuItem = await db.prepare(
                'SELECT id, name, price FROM menu_items WHERE id = ? AND restaurant_id = ? AND active = 1'
            ).get(item.menu_item_id, table.restaurant_id);

            if (!menuItem) {
                return res.status(400).json({ error: `Menu item ${item.menu_item_id} not found or inactive` });
            }

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

        // Create order
        const result = await db.prepare(
            `INSERT INTO orders (restaurant_id, table_id, internal_status, public_status, payment_mode, total_amount, notes)
         VALUES (?, ?, 'PLACED', 'Order placed', ?, ?, ?)`
        ).run(table.restaurant_id, table.id, payment_mode, totalAmount, notes || '');

        const orderId = result.lastInsertRowid;

        // Insert order items
        for (const oi of orderItems) {
            await db.prepare(
                'INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price_at_order, notes) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(orderId, oi.menu_item_id, oi.item_name, oi.quantity, oi.price_at_order, oi.notes);
        }

        // Get order with items
        const order = await getOrderById(orderId);

        // Emit event for kitchen
        orderEvents.emit('new-order', {
            restaurant_id: table.restaurant_id,
            order
        });

        res.status(201).json({
            order_id: orderId,
            public_status: 'Order placed',
            total_amount: totalAmount,
            payment_mode
        });
    } catch (err) {
        console.error('Order create error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Add items to existing POSTPAID order ─────────────────────

// POST /api/orders/:id/add-items
router.post('/:id/add-items', async (req, res) => {
    try {
        const { table_token, items } = req.body;
        const orderId = req.params.id;

        if (!table_token || !items || !items.length) {
            return res.status(400).json({ error: 'table_token and items are required' });
        }

        // Validate order belongs to this table
        const table = await db.prepare(
            'SELECT id, restaurant_id FROM tables WHERE qr_token = ? AND active = 1'
        ).get(table_token);
        if (!table) return res.status(404).json({ error: 'Invalid table' });

        const order = await db.prepare(
            'SELECT id, total_amount, internal_status FROM orders WHERE id = ? AND table_id = ? AND payment_mode = ?'
        ).get(orderId, table.id, 'POSTPAID');
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.internal_status === 'SERVED') {
            return res.status(400).json({ error: 'Cannot add items to a served order' });
        }

        // Validate and price new items
        let additionalAmount = 0;
        const newItems = [];
        for (const item of items) {
            const menuItem = await db.prepare(
                'SELECT id, name, price FROM menu_items WHERE id = ? AND restaurant_id = ? AND active = 1'
            ).get(item.menu_item_id, table.restaurant_id);
            if (!menuItem) return res.status(400).json({ error: `Item ${item.menu_item_id} not found` });
            const qty = item.quantity || 1;
            additionalAmount += menuItem.price * qty;
            newItems.push({
                menu_item_id: menuItem.id,
                item_name: menuItem.name,
                quantity: qty,
                price_at_order: menuItem.price,
                notes: item.notes || ''
            });
        }

        // Insert new items
        for (const oi of newItems) {
            await db.prepare(
                'INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price_at_order, notes) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(orderId, oi.menu_item_id, oi.item_name, oi.quantity, oi.price_at_order, oi.notes);
        }

        // Update order total
        const newTotal = order.total_amount + additionalAmount;
        await db.prepare('UPDATE orders SET total_amount = ? WHERE id = ?').run(newTotal, orderId);

        const updatedOrder = await getOrderById(orderId);
        orderEvents.emit('order-updated', {
            restaurant_id: table.restaurant_id,
            order_id: parseInt(orderId),
            internal_status: order.internal_status,
            public_status: updatedOrder.public_status,
            table_number: updatedOrder.table_number
        });

        res.json({
            order_id: parseInt(orderId),
            total_amount: newTotal,
            added_items: newItems.length,
            public_status: updatedOrder.public_status
        });
    } catch (err) {
        console.error('Add items error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Get order (public - customer) ────────────────────────────

// GET /api/orders/:id?token=<table_token>
router.get('/:id', async (req, res) => {
    try {
        const { token } = req.query;
        const order = await db.prepare(
            `SELECT o.id, o.table_id, o.public_status, o.payment_mode, o.total_amount, o.created_at,
              t.table_number
       FROM orders o
       JOIN tables t ON o.table_id = t.id
       WHERE o.id = ?`
        ).get(req.params.id);

        if (!order) return res.status(404).json({ error: 'Order not found' });

        // If token provided, validate it matches the table
        if (token) {
            const table = await db.prepare('SELECT id FROM tables WHERE qr_token = ?').get(token);
            if (!table || table.id !== order.table_id) {
                return res.status(403).json({ error: 'Access denied' });
            }
        }

        const items = await db.prepare(
            'SELECT item_name, quantity, price_at_order, notes FROM order_items WHERE order_id = ?'
        ).all(req.params.id);

        // Check payment status
        const payment = await db.prepare(
            'SELECT status, verified FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(req.params.id);

        res.json({
            id: order.id,
            table_number: order.table_number,
            public_status: order.public_status,
            payment_mode: order.payment_mode,
            total_amount: order.total_amount,
            created_at: order.created_at,
            items,
            payment_status: payment ? payment.status : (order.payment_mode === 'POSTPAID' ? 'pending' : null)
        });
    } catch (err) {
        console.error('Order get error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Kitchen feed ─────────────────────────────────────────────

// GET /api/orders/feed/kitchen
router.get('/feed/kitchen', authenticateToken, requireRole('kitchen', 'admin'), async (req, res) => {
    try {
        const orders = await db.prepare(
            `SELECT o.*, t.table_number
       FROM orders o
       JOIN tables t ON o.table_id = t.id
       WHERE o.restaurant_id = ? AND o.internal_status IN ('PLACED', 'PREPARING')
       ORDER BY o.created_at ASC`
        ).all(req.user.restaurant_id);

        const result = await Promise.all(orders.map(async order => {
            const items = await db.prepare(
                'SELECT item_name, quantity, price_at_order, notes FROM order_items WHERE order_id = ?'
            ).all(order.id);
            return { ...order, items };
        }));

        res.json(result);
    } catch (err) {
        console.error('Kitchen feed error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Waiter feed ──────────────────────────────────────────────

// GET /api/orders/feed/waiter
router.get('/feed/waiter', authenticateToken, requireRole('waiter', 'admin'), async (req, res) => {
    try {
        const orders = await db.prepare(
            `SELECT o.*, t.table_number
       FROM orders o
       JOIN tables t ON o.table_id = t.id
       WHERE o.restaurant_id = ? AND o.internal_status = 'READY'
       ORDER BY o.updated_at ASC`
        ).all(req.user.restaurant_id);

        const result = await Promise.all(orders.map(async order => {
            const items = await db.prepare(
                'SELECT item_name, quantity, price_at_order, notes FROM order_items WHERE order_id = ?'
            ).all(order.id);
            return { ...order, items };
        }));

        res.json(result);
    } catch (err) {
        console.error('Waiter feed error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Admin: all orders ────────────────────────────────────────

// GET /api/orders/feed/all
router.get('/feed/all', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { date, status } = req.query;
        let query = `SELECT o.*, t.table_number FROM orders o JOIN tables t ON o.table_id = t.id WHERE o.restaurant_id = ?`;
        const params = [req.user.restaurant_id];

        if (date) {
            query += ` AND date(o.created_at) = ?`;
            params.push(date);
        }
        if (status) {
            query += ` AND o.internal_status = ?`;
            params.push(status);
        }

        query += ` ORDER BY o.created_at DESC LIMIT 100`;

        const orders = await db.prepare(query).all(...params);
        const result = await Promise.all(orders.map(async order => {
            const items = await db.prepare(
                'SELECT item_name, quantity, price_at_order, notes FROM order_items WHERE order_id = ?'
            ).all(order.id);
            const payment = await db.prepare(
                'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1'
            ).get(order.id);
            return { ...order, items, payment };
        }));

        res.json(result);
    } catch (err) {
        console.error('All orders error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Update order status ──────────────────────────────────────

// PATCH /api/orders/:id/status
router.patch('/:id/status', authenticateToken, requireRole('kitchen', 'waiter', 'admin'), async (req, res) => {
    try {
        const { internal_status } = req.body;

        if (!['PLACED', 'PREPARING', 'READY', 'SERVED'].includes(internal_status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const order = await db.prepare(
            'SELECT * FROM orders WHERE id = ? AND restaurant_id = ?'
        ).get(req.params.id, req.user.restaurant_id);

        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Kitchen can only set PREPARING or READY
        if (req.user.role === 'kitchen' && !['PREPARING', 'READY'].includes(internal_status)) {
            return res.status(403).json({ error: 'Kitchen can only set PREPARING or READY' });
        }

        // Waiter can only set SERVED
        if (req.user.role === 'waiter' && internal_status !== 'SERVED') {
            return res.status(403).json({ error: 'Waiter can only set SERVED' });
        }

        const public_status = STATUS_MAP[internal_status];

        await db.prepare(
            `UPDATE orders SET internal_status = ?, public_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(internal_status, public_status, req.params.id);

        // Emit event
        orderEvents.emit('order-updated', {
            restaurant_id: req.user.restaurant_id,
            order_id: parseInt(req.params.id),
            internal_status,
            public_status,
            table_number: (await db.prepare('SELECT table_number FROM tables WHERE id = ?').get(order.table_id))?.table_number
        });

        res.json({ success: true, internal_status, public_status });
    } catch (err) {
        console.error('Status update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Helper ───────────────────────────────────────────────────

async function getOrderById(orderId) {
    const order = await db.prepare(
        `SELECT o.*, t.table_number FROM orders o JOIN tables t ON o.table_id = t.id WHERE o.id = ?`
    ).get(orderId);
    if (!order) return null;
    order.items = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    return order;
}

module.exports = router;
module.exports.getOrderById = getOrderById;
module.exports.STATUS_MAP = STATUS_MAP;
