const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', 'data', 'restaurant.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    prepaid_enabled INTEGER DEFAULT 1,
    postpaid_enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'kitchen', 'waiter')),
    name TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    table_number INTEGER NOT NULL,
    qr_token TEXT NOT NULL UNIQUE,
    seats INTEGER DEFAULT 4,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
    UNIQUE(restaurant_id, table_number)
  );

  CREATE TABLE IF NOT EXISTS menu_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    restaurant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price REAL NOT NULL,
    image_url TEXT DEFAULT '',
    is_veg INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES menu_categories(id),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    table_id INTEGER NOT NULL,
    internal_status TEXT NOT NULL DEFAULT 'PLACED' CHECK(internal_status IN ('PLACED', 'PREPARING', 'READY', 'SERVED')),
    public_status TEXT NOT NULL DEFAULT 'Order placed',
    payment_mode TEXT NOT NULL CHECK(payment_mode IN ('PREPAID', 'POSTPAID')),
    total_amount REAL NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
    FOREIGN KEY (table_id) REFERENCES tables(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    menu_item_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    price_at_order REAL NOT NULL,
    notes TEXT DEFAULT '',
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    restaurant_id INTEGER NOT NULL,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    razorpay_signature TEXT,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'INR',
    status TEXT DEFAULT 'created' CHECK(status IN ('created', 'paid', 'failed', 'refunded')),
    verified INTEGER DEFAULT 0,
    payment_mode TEXT NOT NULL CHECK(payment_mode IN ('PREPAID', 'POSTPAID')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(internal_status);
  CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);
  CREATE INDEX IF NOT EXISTS idx_tables_token ON tables(qr_token);
  CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
  CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
`);

// ─── Seed Data ────────────────────────────────────────────────

function seedDatabase() {
  const restaurantCount = db.prepare('SELECT COUNT(*) as count FROM restaurants').get().count;
  if (restaurantCount > 0) return; // Already seeded

  console.log('🌱 Seeding database...');

  // Create restaurant
  const insertRestaurant = db.prepare(
    'INSERT INTO restaurants (name, description) VALUES (?, ?)'
  );
  const { lastInsertRowid: restaurantId } = insertRestaurant.run(
    'The Golden Plate',
    'Fine dining with a modern twist'
  );

  // Create admin user (password: admin123)
  const passwordHash = bcrypt.hashSync('admin123', 10);
  const insertUser = db.prepare(
    'INSERT INTO users (restaurant_id, username, password_hash, role, name) VALUES (?, ?, ?, ?, ?)'
  );
  insertUser.run(restaurantId, 'admin', passwordHash, 'admin', 'Restaurant Admin');
  insertUser.run(restaurantId, 'kitchen1', bcrypt.hashSync('kitchen123', 10), 'kitchen', 'Head Chef');
  insertUser.run(restaurantId, 'waiter1', bcrypt.hashSync('waiter123', 10), 'waiter', 'Main Waiter');

  // Create tables
  const insertTable = db.prepare(
    'INSERT INTO tables (restaurant_id, table_number, qr_token, seats) VALUES (?, ?, ?, ?)'
  );
  for (let i = 1; i <= 5; i++) {
    insertTable.run(restaurantId, i, uuidv4(), i <= 2 ? 2 : 4);
  }

  // Create menu categories
  const insertCategory = db.prepare(
    'INSERT INTO menu_categories (restaurant_id, name, description, sort_order) VALUES (?, ?, ?, ?)'
  );
  const { lastInsertRowid: startersId } = insertCategory.run(restaurantId, 'Starters', 'Begin your meal right', 1);
  const { lastInsertRowid: mainsId } = insertCategory.run(restaurantId, 'Main Course', 'Hearty and fulfilling', 2);
  const { lastInsertRowid: breadsId } = insertCategory.run(restaurantId, 'Breads', 'Fresh from the tandoor', 3);
  const { lastInsertRowid: beveragesId } = insertCategory.run(restaurantId, 'Beverages', 'Refreshing drinks', 4);
  const { lastInsertRowid: dessertsId } = insertCategory.run(restaurantId, 'Desserts', 'Sweet endings', 5);

  // Create menu items
  const insertItem = db.prepare(
    'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, is_veg, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  // Starters
  insertItem.run(startersId, restaurantId, 'Paneer Tikka', 'Marinated cottage cheese grilled in tandoor', 249, 1, 1);
  insertItem.run(startersId, restaurantId, 'Chicken Seekh Kebab', 'Spiced minced chicken skewers', 299, 0, 2);
  insertItem.run(startersId, restaurantId, 'Crispy Corn', 'Golden fried corn with spices', 199, 1, 3);
  insertItem.run(startersId, restaurantId, 'Fish Amritsari', 'Batter-fried fish with mint chutney', 349, 0, 4);
  insertItem.run(startersId, restaurantId, 'Veg Spring Rolls', 'Crispy rolls stuffed with vegetables', 179, 1, 5);

  // Main Course
  insertItem.run(mainsId, restaurantId, 'Butter Chicken', 'Creamy tomato-based chicken curry', 349, 0, 1);
  insertItem.run(mainsId, restaurantId, 'Paneer Butter Masala', 'Rich and creamy paneer curry', 299, 1, 2);
  insertItem.run(mainsId, restaurantId, 'Dal Makhani', 'Slow-cooked black lentils in cream', 249, 1, 3);
  insertItem.run(mainsId, restaurantId, 'Chicken Biryani', 'Fragrant basmati rice with spiced chicken', 399, 0, 4);
  insertItem.run(mainsId, restaurantId, 'Veg Biryani', 'Aromatic rice with seasonal vegetables', 299, 1, 5);
  insertItem.run(mainsId, restaurantId, 'Mutton Rogan Josh', 'Kashmiri-style aromatic mutton curry', 449, 0, 6);
  insertItem.run(mainsId, restaurantId, 'Palak Paneer', 'Cottage cheese in spinach gravy', 269, 1, 7);

  // Breads
  insertItem.run(breadsId, restaurantId, 'Butter Naan', 'Soft leavened bread with butter', 59, 1, 1);
  insertItem.run(breadsId, restaurantId, 'Garlic Naan', 'Naan with garlic and coriander', 79, 1, 2);
  insertItem.run(breadsId, restaurantId, 'Tandoori Roti', 'Whole wheat bread from tandoor', 39, 1, 3);
  insertItem.run(breadsId, restaurantId, 'Cheese Naan', 'Naan stuffed with melted cheese', 99, 1, 4);
  insertItem.run(breadsId, restaurantId, 'Laccha Paratha', 'Layered flaky bread', 69, 1, 5);

  // Beverages
  insertItem.run(beveragesId, restaurantId, 'Masala Chai', 'Traditional Indian spiced tea', 49, 1, 1);
  insertItem.run(beveragesId, restaurantId, 'Fresh Lime Soda', 'Sweet or salted lime soda', 79, 1, 2);
  insertItem.run(beveragesId, restaurantId, 'Mango Lassi', 'Creamy mango yogurt drink', 129, 1, 3);
  insertItem.run(beveragesId, restaurantId, 'Cold Coffee', 'Chilled blended coffee', 149, 1, 4);
  insertItem.run(beveragesId, restaurantId, 'Buttermilk', 'Spiced traditional chaas', 59, 1, 5);

  // Desserts
  insertItem.run(dessertsId, restaurantId, 'Gulab Jamun', 'Deep-fried milk dumplings in sugar syrup', 129, 1, 1);
  insertItem.run(dessertsId, restaurantId, 'Rasmalai', 'Soft paneer balls in sweetened milk', 149, 1, 2);
  insertItem.run(dessertsId, restaurantId, 'Kulfi', 'Traditional Indian ice cream', 99, 1, 3);
  insertItem.run(dessertsId, restaurantId, 'Brownie with Ice Cream', 'Warm chocolate brownie topped with vanilla', 199, 1, 4);

  console.log('✅ Database seeded successfully');
}

seedDatabase();

module.exports = db;
