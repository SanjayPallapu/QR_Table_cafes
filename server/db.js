const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const dns = require('dns');

// Force IPv4 DNS resolution (Render's IPv6 can't reach Supabase direct host)
dns.setDefaultResultOrder('ipv4first');

// Detect if using Supabase pooler (pgBouncer) — it doesn't support prepared statements
const isPooler = (process.env.DATABASE_URL || '').includes('pooler.supabase.com');

// Create connection pool with SSL for Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // pgBouncer in transaction mode doesn't support prepared statements
  ...(isPooler && { prepare: false }),
});

// Export a query helper with both async and prepare methods
const db = {
  // Async query method
  async query(text, params) {
    const client = await pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  },

  // Prepare method that returns an object with sync-style methods
  prepare(sql) {
    // Convert ? placeholders to $1, $2, etc for PostgreSQL
    let paramIndex = 1;
    const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

    return {
      run: (...params) => {
        return new Promise(async (resolve, reject) => {
          try {
            const result = await db.query(pgSql + ' RETURNING id', params);
            resolve({ lastInsertRowid: result.rows[0]?.id || result.rowCount });
          } catch (err) {
            reject(err);
          }
        });
      },
      get: (...params) => {
        return new Promise(async (resolve, reject) => {
          try {
            const result = await db.query(pgSql, params);
            resolve(result.rows[0]);
          } catch (err) {
            reject(err);
          }
        });
      },
      all: (...params) => {
        return new Promise(async (resolve, reject) => {
          try {
            const result = await db.query(pgSql, params);
            resolve(result.rows);
          } catch (err) {
            reject(err);
          }
        });
      },
    };
  },

  async exec(sqlStatements) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const statements = sqlStatements.split(';').filter(s => s.trim());
      for (const statement of statements) {
        if (statement.trim()) {
          await client.query(statement);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

// ─── Schema Setup ────────────────────────────────────────────

async function initializeDatabase() {
  try {
    // Drop existing tables (for fresh start)
    await db.exec(`
      DROP TABLE IF EXISTS order_items CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS menu_items CASCADE;
      DROP TABLE IF EXISTS menu_categories CASCADE;
      DROP TABLE IF EXISTS tables CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS restaurants CASCADE;
    `);

    // Create tables
    await db.exec(`
      CREATE TABLE restaurants (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        prepaid_enabled INTEGER DEFAULT 1,
        postpaid_enabled INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'kitchen', 'waiter')),
        name TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE tables (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
        table_number INTEGER NOT NULL,
        qr_token TEXT NOT NULL UNIQUE,
        seats INTEGER DEFAULT 4,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(restaurant_id, table_number)
      );

      CREATE TABLE menu_categories (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE menu_items (
        id SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES menu_categories(id),
        restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        price REAL NOT NULL,
        image_url TEXT DEFAULT '',
        is_veg INTEGER DEFAULT 1,
        active INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
        table_id INTEGER NOT NULL REFERENCES tables(id),
        internal_status TEXT NOT NULL DEFAULT 'PLACED' CHECK(internal_status IN ('PLACED', 'PREPARING', 'READY', 'SERVED')),
        public_status TEXT NOT NULL DEFAULT 'Order placed',
        payment_mode TEXT NOT NULL CHECK(payment_mode IN ('PREPAID', 'POSTPAID')),
        total_amount REAL NOT NULL DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        price_at_order REAL NOT NULL,
        notes TEXT DEFAULT ''
      );

      CREATE TABLE payments (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id),
        restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
        razorpay_order_id TEXT,
        razorpay_payment_id TEXT,
        razorpay_signature TEXT,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'INR',
        status TEXT DEFAULT 'created' CHECK(status IN ('created', 'paid', 'failed', 'refunded')),
        verified INTEGER DEFAULT 0,
        payment_mode TEXT NOT NULL CHECK(payment_mode IN ('PREPAID', 'POSTPAID')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
      CREATE INDEX idx_orders_status ON orders(internal_status);
      CREATE INDEX idx_orders_table ON orders(table_id);
      CREATE INDEX idx_tables_token ON tables(qr_token);
      CREATE INDEX idx_menu_items_category ON menu_items(category_id);
      CREATE INDEX idx_payments_order ON payments(order_id);
    `);

    console.log('✅ Database schema created successfully');
    await seedDatabase();

  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// ─── Seed Data ────────────────────────────────────────────────

async function seedDatabase() {
  try {
    const restaurantCount = await db.query('SELECT COUNT(*) as count FROM restaurants');
    if (restaurantCount.rows[0].count > 0) {
      console.log('Database already seeded');
      return;
    }

    console.log('🌱 Seeding database...');

    // Create restaurant
    const restaurantResult = await db.query(
      'INSERT INTO restaurants (name, description) VALUES ($1, $2) RETURNING id',
      ['The Golden Plate', 'Fine dining with a modern twist']
    );
    const restaurantId = restaurantResult.rows[0].id;

    // Create admin user (password: admin123)
    const passwordHash = bcrypt.hashSync('admin123', 10);
    await db.query(
      'INSERT INTO users (restaurant_id, username, password_hash, role, name) VALUES ($1, $2, $3, $4, $5)',
      [restaurantId, 'admin', passwordHash, 'admin', 'Restaurant Admin']
    );
    await db.query(
      'INSERT INTO users (restaurant_id, username, password_hash, role, name) VALUES ($1, $2, $3, $4, $5)',
      [restaurantId, 'kitchen1', bcrypt.hashSync('kitchen123', 10), 'kitchen', 'Head Chef']
    );
    await db.query(
      'INSERT INTO users (restaurant_id, username, password_hash, role, name) VALUES ($1, $2, $3, $4, $5)',
      [restaurantId, 'waiter1', bcrypt.hashSync('waiter123', 10), 'waiter', 'Main Waiter']
    );

    // Create tables
    for (let i = 1; i <= 5; i++) {
      await db.query(
        'INSERT INTO tables (restaurant_id, table_number, qr_token, seats) VALUES ($1, $2, $3, $4)',
        [restaurantId, i, uuidv4(), i <= 2 ? 2 : 4]
      );
    }

    // Create menu categories
    const startResult = await db.query(
      'INSERT INTO menu_categories (restaurant_id, name, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [restaurantId, 'Starters', 'Begin your meal right', 1]
    );
    const startersId = startResult.rows[0].id;

    const mainResult = await db.query(
      'INSERT INTO menu_categories (restaurant_id, name, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [restaurantId, 'Main Course', 'Hearty and fulfilling', 2]
    );
    const mainsId = mainResult.rows[0].id;

    const breadsResult = await db.query(
      'INSERT INTO menu_categories (restaurant_id, name, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [restaurantId, 'Breads', 'Fresh from the tandoor', 3]
    );
    const breadsId = breadsResult.rows[0].id;

    const beveragesResult = await db.query(
      'INSERT INTO menu_categories (restaurant_id, name, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [restaurantId, 'Beverages', 'Refreshing drinks', 4]
    );
    const beveragesId = beveragesResult.rows[0].id;

    const dessertsResult = await db.query(
      'INSERT INTO menu_categories (restaurant_id, name, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [restaurantId, 'Desserts', 'Sweet endings', 5]
    );
    const dessertsId = dessertsResult.rows[0].id;

    // Create menu items
    const menuItems = [
      // Starters
      [startersId, restaurantId, 'Paneer Tikka', 'Marinated cottage cheese grilled in tandoor', 249, 1, 1],
      [startersId, restaurantId, 'Chicken Seekh Kebab', 'Spiced minced chicken skewers', 299, 0, 2],
      [startersId, restaurantId, 'Crispy Corn', 'Golden fried corn with spices', 199, 1, 3],
      [startersId, restaurantId, 'Fish Amritsari', 'Batter-fried fish with mint chutney', 349, 0, 4],
      [startersId, restaurantId, 'Veg Spring Rolls', 'Crispy rolls stuffed with vegetables', 179, 1, 5],
      // Main Course
      [mainsId, restaurantId, 'Butter Chicken', 'Creamy tomato-based chicken curry', 349, 0, 1],
      [mainsId, restaurantId, 'Paneer Butter Masala', 'Rich and creamy paneer curry', 299, 1, 2],
      [mainsId, restaurantId, 'Dal Makhani', 'Slow-cooked black lentils in cream', 249, 1, 3],
      [mainsId, restaurantId, 'Chicken Biryani', 'Fragrant basmati rice with spiced chicken', 399, 0, 4],
      [mainsId, restaurantId, 'Veg Biryani', 'Aromatic rice with seasonal vegetables', 299, 1, 5],
      [mainsId, restaurantId, 'Mutton Rogan Josh', 'Kashmiri-style aromatic mutton curry', 449, 0, 6],
      [mainsId, restaurantId, 'Palak Paneer', 'Cottage cheese in spinach gravy', 269, 1, 7],
      // Breads
      [breadsId, restaurantId, 'Butter Naan', 'Soft leavened bread with butter', 59, 1, 1],
      [breadsId, restaurantId, 'Garlic Naan', 'Naan with garlic and coriander', 79, 1, 2],
      [breadsId, restaurantId, 'Tandoori Roti', 'Whole wheat bread from tandoor', 39, 1, 3],
      [breadsId, restaurantId, 'Cheese Naan', 'Naan stuffed with melted cheese', 99, 1, 4],
      [breadsId, restaurantId, 'Laccha Paratha', 'Layered flaky bread', 69, 1, 5],
      // Beverages
      [beveragesId, restaurantId, 'Masala Chai', 'Traditional Indian spiced tea', 49, 1, 1],
      [beveragesId, restaurantId, 'Fresh Lime Soda', 'Sweet or salted lime soda', 79, 1, 2],
      [beveragesId, restaurantId, 'Mango Lassi', 'Creamy mango yogurt drink', 129, 1, 3],
      [beveragesId, restaurantId, 'Cold Coffee', 'Chilled blended coffee', 149, 1, 4],
      [beveragesId, restaurantId, 'Buttermilk', 'Spiced traditional chaas', 59, 1, 5],
      // Desserts
      [dessertsId, restaurantId, 'Gulab Jamun', 'Deep-fried milk dumplings in sugar syrup', 129, 1, 1],
      [dessertsId, restaurantId, 'Rasmalai', 'Soft paneer balls in sweetened milk', 149, 1, 2],
      [dessertsId, restaurantId, 'Kulfi', 'Traditional Indian ice cream', 99, 1, 3],
      [dessertsId, restaurantId, 'Brownie with Ice Cream', 'Warm chocolate brownie topped with vanilla', 199, 1, 4],
    ];

    for (const item of menuItems) {
      await db.query(
        'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, is_veg, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        item
      );
    }

    console.log('✅ Database seeded successfully');
  } catch (err) {
    console.error('Seeding error:', err);
  }
}

// Initialize database only if explicitly needed, disabled for production safety
// initializeDatabase();

module.exports = db;
