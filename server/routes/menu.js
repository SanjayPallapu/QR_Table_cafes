const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

// ─── Public: Get menu for a restaurant ────────────────────────

// GET /api/menu/:restaurantId
router.get('/:restaurantId', async (req, res) => {
    try {
        const { restaurantId } = req.params;

        const restaurant = await db.prepare('SELECT id, name, description, prepaid_enabled, postpaid_enabled FROM restaurants WHERE id = ?').get(restaurantId);
        if (!restaurant) {
            return res.status(404).json({ error: 'Restaurant not found' });
        }

        const categories = await db.prepare(
            'SELECT id, name, description, sort_order FROM menu_categories WHERE restaurant_id = ? AND active = 1 ORDER BY sort_order'
        ).all(restaurantId);

        const items = await db.prepare(
            'SELECT id, category_id, name, description, price, image_url, is_veg, is_bestseller, is_spicy, allergen_tags, prep_time_mins, customizations, sort_order FROM menu_items WHERE restaurant_id = ? AND active = 1 ORDER BY sort_order'
        ).all(restaurantId);

        // Group items by category
        const menuCategories = categories.map(cat => ({
            ...cat,
            items: items.filter(item => item.category_id === cat.id)
        }));

        res.json({
            restaurant,
            categories: menuCategories
        });
    } catch (err) {
        console.error('Menu fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Admin: Category CRUD ─────────────────────────────────────

// POST /api/menu/categories
router.post('/categories', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { name, description, sort_order } = req.body;
        if (!name) return res.status(400).json({ error: 'Category name is required' });

        const result = await db.prepare(
            'INSERT INTO menu_categories (restaurant_id, name, description, sort_order) VALUES (?, ?, ?, ?)'
        ).run(req.user.restaurant_id, name, description || '', sort_order || 0);

        const category = await db.prepare('SELECT * FROM menu_categories WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(category);
    } catch (err) {
        console.error('Category create error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/menu/categories/:id
router.put('/categories/:id', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { name, description, sort_order, active } = req.body;
        const cat = await db.prepare('SELECT * FROM menu_categories WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.user.restaurant_id);
        if (!cat) return res.status(404).json({ error: 'Category not found' });

        await db.prepare(
            'UPDATE menu_categories SET name = ?, description = ?, sort_order = ?, active = ? WHERE id = ?'
        ).run(name || cat.name, description ?? cat.description, sort_order ?? cat.sort_order, active ?? cat.active, req.params.id);

        const updated = await db.prepare('SELECT * FROM menu_categories WHERE id = ?').get(req.params.id);
        res.json(updated);
    } catch (err) {
        console.error('Category update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/menu/categories/:id
router.delete('/categories/:id', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const cat = await db.prepare('SELECT * FROM menu_categories WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.user.restaurant_id);
        if (!cat) return res.status(404).json({ error: 'Category not found' });

        // Soft delete - just deactivate
        await db.prepare('UPDATE menu_categories SET active = 0 WHERE id = ?').run(req.params.id);
        await db.prepare('UPDATE menu_items SET active = 0 WHERE category_id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Category delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Admin: Item CRUD ─────────────────────────────────────────

// GET /api/menu/items/all (admin - includes inactive)
router.get('/items/all', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const items = await db.prepare(
            'SELECT mi.*, mc.name as category_name FROM menu_items mi JOIN menu_categories mc ON mi.category_id = mc.id WHERE mi.restaurant_id = ? ORDER BY mc.sort_order, mi.sort_order'
        ).all(req.user.restaurant_id);
        res.json(items);
    } catch (err) {
        console.error('Items fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/menu/items
router.post('/items', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { category_id, name, description, price, image_url, is_veg, sort_order } = req.body;
        if (!category_id || !name || price === undefined) {
            return res.status(400).json({ error: 'category_id, name, and price are required' });
        }

        const result = await db.prepare(
            'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, image_url, is_veg, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(category_id, req.user.restaurant_id, name, description || '', price, image_url || '', is_veg ?? 1, sort_order || 0);

        const item = await db.prepare('SELECT * FROM menu_items WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(item);
    } catch (err) {
        console.error('Item create error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/menu/items/:id
router.put('/items/:id', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { category_id, name, description, price, image_url, is_veg, active, sort_order } = req.body;
        const item = await db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.user.restaurant_id);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        await db.prepare(
            `UPDATE menu_items SET category_id = ?, name = ?, description = ?, price = ?, image_url = ?, is_veg = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(
            category_id || item.category_id, name || item.name, description ?? item.description,
            price ?? item.price, image_url ?? item.image_url, is_veg ?? item.is_veg,
            active ?? item.active, sort_order ?? item.sort_order, req.params.id
        );

        const updated = await db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
        res.json(updated);
    } catch (err) {
        console.error('Item update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/menu/items/:id
router.delete('/items/:id', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const item = await db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.user.restaurant_id);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        await db.prepare('UPDATE menu_items SET active = 0 WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Item delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
