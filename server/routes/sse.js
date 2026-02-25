const express = require('express');
const router = express.Router();
const orderEvents = require('../utils/events');

// ─── SSE: Kitchen stream ──────────────────────────────────────

router.get('/kitchen', (req, res) => {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    // Send initial keepalive
    res.write('event: connected\ndata: {"status":"connected"}\n\n');

    const onNewOrder = (data) => {
        if (data.restaurant_id == restaurant_id) {
            res.write(`event: new-order\ndata: ${JSON.stringify(data.order)}\n\n`);
        }
    };

    const onOrderUpdated = (data) => {
        if (data.restaurant_id == restaurant_id) {
            res.write(`event: order-updated\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };

    orderEvents.on('new-order', onNewOrder);
    orderEvents.on('order-updated', onOrderUpdated);

    // Call waiter events
    const onCallWaiter = (data) => {
        if (data.restaurant_id == restaurant_id) {
            res.write(`event: call-waiter\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };
    orderEvents.on('call-waiter', onCallWaiter);

    // Keepalive every 30 seconds
    const keepalive = setInterval(() => {
        res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(keepalive);
        orderEvents.off('new-order', onNewOrder);
        orderEvents.off('order-updated', onOrderUpdated);
        orderEvents.off('call-waiter', onCallWaiter);
    });
});

// ─── SSE: Waiter stream ───────────────────────────────────────

router.get('/waiter', (req, res) => {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    res.write('event: connected\ndata: {"status":"connected"}\n\n');

    const onOrderUpdated = (data) => {
        if (data.restaurant_id == restaurant_id) {
            res.write(`event: order-updated\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };

    const onNewOrder = (data) => {
        if (data.restaurant_id == restaurant_id) {
            res.write(`event: new-order\ndata: ${JSON.stringify(data.order)}\n\n`);
        }
    };

    // Call waiter events
    const onCallWaiter = (data) => {
        if (data.restaurant_id == restaurant_id) {
            res.write(`event: call-waiter\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };

    orderEvents.on('order-updated', onOrderUpdated);
    orderEvents.on('new-order', onNewOrder);
    orderEvents.on('call-waiter', onCallWaiter);

    const keepalive = setInterval(() => {
        res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(keepalive);
        orderEvents.off('order-updated', onOrderUpdated);
        orderEvents.off('new-order', onNewOrder);
        orderEvents.off('call-waiter', onCallWaiter);
    });
});

// ─── SSE: Customer order tracking ─────────────────────────────

router.get('/order/:orderId', (req, res) => {
    const { orderId } = req.params;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    res.write('event: connected\ndata: {"status":"connected"}\n\n');

    const onOrderUpdated = (data) => {
        if (data.order_id == orderId) {
            // Only send public_status to customer
            res.write(`event: status-update\ndata: ${JSON.stringify({
                order_id: data.order_id,
                public_status: data.public_status
            })}\n\n`);
        }
    };

    orderEvents.on('order-updated', onOrderUpdated);

    const keepalive = setInterval(() => {
        res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(keepalive);
        orderEvents.off('order-updated', onOrderUpdated);
    });
});

module.exports = router;
