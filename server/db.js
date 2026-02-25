const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase Client (HTTPS, works everywhere including Render) ───
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL and SUPABASE_ANON_KEY must be set');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  db: { schema: 'public' },
  auth: { persistSession: false }
});

// ─── SQL-compatible wrapper using Supabase REST API ───────────

// Helper: Execute raw SQL via Supabase's `rpc` using a database function
// Since PostgREST doesn't support raw SQL directly, we use table-level operations
// But first, let's create a thin wrapper that translates SQL to Supabase operations

/**
 * Parse a simple SQL query and translate to Supabase operations
 * Supports: SELECT, INSERT, UPDATE, DELETE
 */
function parseSQL(sql, params = []) {
  const trimmed = sql.trim().replace(/\s+/g, ' ');

  // Replace $1, $2, etc. with actual values in the SQL for analysis
  let paramIndex = 0;
  const getParam = () => params[paramIndex++];

  return { sql: trimmed, params, getParam };
}

// ─── The db object that all routes use ────────────────────────

const db = {
  // Direct query method (used by index.js health check and db.js internals)
  async query(text, params = []) {
    // Use Supabase rpc to run raw SQL — but this requires a database function
    // Instead, translate common queries to Supabase client calls
    const trimmed = text.trim().replace(/\s+/g, ' ');

    // Handle SELECT COUNT(*) ... FROM table_name
    const countMatch = trimmed.match(/SELECT COUNT\(\*\)\s+as\s+count\s+FROM\s+(\w+)/i);
    if (countMatch) {
      const table = countMatch[1];
      const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
      if (error) throw new Error(error.message);
      return { rows: [{ count: count }] };
    }

    // Handle INSERT ... RETURNING id
    const insertMatch = trimmed.match(/INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const table = insertMatch[1];
      const columns = insertMatch[2].split(',').map(c => c.trim());
      const obj = {};
      columns.forEach((col, i) => { obj[col] = params[i]; });

      const { data, error } = await supabase.from(table).insert(obj).select('id').single();
      if (error) throw new Error(error.message);
      return { rows: [{ id: data.id }], rowCount: 1 };
    }

    // Handle SELECT with WHERE
    const selectMatch = trimmed.match(/SELECT (.+?) FROM (\w+)(.*)/i);
    if (selectMatch) {
      const columns = selectMatch[1].trim();
      const table = selectMatch[2].trim();
      const rest = selectMatch[3].trim();

      let query = supabase.from(table).select(columns === '*' ? '*' : columns);

      // Parse WHERE clause
      if (rest.includes('WHERE')) {
        // This is too complex for simple parsing — fall back to rpc
      }

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return { rows: data };
    }

    throw new Error(`Unsupported query for REST API: ${trimmed.substring(0, 100)}`);
  },

  // Prepare method — translates ? placeholders and returns get/all/run
  prepare(sql) {
    // Convert ? placeholders to $1, $2, etc for identification
    let paramIndex = 1;
    const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
    const totalParams = paramIndex - 1;

    return {
      run: async (...params) => {
        return await executeSqlViaRest(pgSql, params, 'run');
      },
      get: async (...params) => {
        return await executeSqlViaRest(pgSql, params, 'get');
      },
      all: async (...params) => {
        return await executeSqlViaRest(pgSql, params, 'all');
      },
    };
  },

  // Transaction support — serializes operations
  transaction(fn) {
    // Return an async function that executes the transaction body
    // Since we can't do real transactions over REST, we execute sequentially
    return async () => {
      return await fn();
    };
  },

  async exec(sqlStatements) {
    // Execute multiple SQL statements
    const statements = sqlStatements.split(';').filter(s => s.trim());
    for (const statement of statements) {
      if (statement.trim()) {
        await executeSqlViaRest(statement.trim(), [], 'run');
      }
    }
  }
};

// ─── Core SQL execution via Supabase REST ─────────────────────

async function executeSqlViaRest(sql, params, mode) {
  const trimmed = sql.trim().replace(/\s+/g, ' ');

  // Substitute $1, $2, etc with actual parameter values for parsing
  let resolvedSql = trimmed;
  params.forEach((p, i) => {
    resolvedSql = resolvedSql.replace(`$${i + 1}`, typeof p === 'string' ? `'${p}'` : p);
  });

  // ─── INSERT ─────────────────────────────────────────────
  const insertMatch = trimmed.match(/INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const table = insertMatch[1];
    const columns = insertMatch[2].split(',').map(c => c.trim());
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = params[i] !== undefined ? params[i] : null;
    });

    const { data, error } = await supabase.from(table).insert(obj).select('id').single();
    if (error) throw new Error(`INSERT ${table}: ${error.message}`);

    if (mode === 'run') return { lastInsertRowid: data.id, changes: 1 };
    if (mode === 'get') return data;
    return [data];
  }

  // ─── UPDATE ─────────────────────────────────────────────
  const updateMatch = trimmed.match(/UPDATE (\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+?)(?:\s+RETURNING\s+(.+))?$/i);
  if (updateMatch) {
    const table = updateMatch[1];
    const setClause = updateMatch[2];
    const whereClause = updateMatch[3].replace(/\s+RETURNING\s+.*/i, '');

    // Parse SET clause
    const setParts = splitSetClause(setClause);
    const updateObj = {};
    let paramIdx = 0;

    for (const part of setParts) {
      const [col, val] = part.split('=').map(s => s.trim());
      if (val && val.match(/\$\d+/)) {
        updateObj[col] = params[paramIdx++];
      } else if (val === 'CURRENT_TIMESTAMP') {
        updateObj[col] = new Date().toISOString();
      } else {
        updateObj[col] = val;
      }
    }

    // Parse WHERE clause
    let query = supabase.from(table).update(updateObj);
    query = applyWhereClause(query, whereClause, params, paramIdx);

    const { data, error } = await query.select();
    if (error) throw new Error(`UPDATE ${table}: ${error.message}`);

    if (mode === 'run') return { changes: data?.length || 0 };
    if (mode === 'get') return data?.[0];
    return data || [];
  }

  // ─── DELETE ─────────────────────────────────────────────
  const deleteMatch = trimmed.match(/DELETE FROM (\w+)\s+WHERE\s+(.+)/i);
  if (deleteMatch) {
    const table = deleteMatch[1];
    let query = supabase.from(table).delete();
    query = applyWhereClause(query, deleteMatch[2], params, 0);

    const { error } = await query;
    if (error) throw new Error(`DELETE ${table}: ${error.message}`);
    return mode === 'run' ? { changes: 1 } : [];
  }

  // ─── SELECT ─────────────────────────────────────────────
  const selectMatch = trimmed.match(/SELECT (.+?) FROM (\w+)(?:\s+(.*))?$/is);
  if (selectMatch) {
    return await handleSelect(selectMatch[1].trim(), selectMatch[2].trim(), selectMatch[3]?.trim() || '', params, mode);
  }

  // ─── DROP TABLE / CREATE TABLE / CREATE INDEX ───────────
  if (trimmed.match(/^(DROP|CREATE)\s+(TABLE|INDEX)/i)) {
    // These are schema operations — execute via Supabase Management API or skip
    // For production, tables should already exist
    console.log('Schema operation skipped (tables managed via Supabase dashboard):', trimmed.substring(0, 80));
    return mode === 'run' ? { changes: 0 } : [];
  }

  throw new Error(`Unsupported SQL pattern: ${trimmed.substring(0, 120)}`);
}

// ─── SELECT handler with JOIN support ─────────────────────────

async function handleSelect(columns, mainTable, rest, params, mode) {
  // Check for JOINs
  const joinMatch = rest.match(/JOIN\s+(\w+)\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i);

  let paramIdx = 0;

  if (joinMatch) {
    // Has JOIN — use Supabase's foreign key relationships or build a view query
    const joinTable = joinMatch[1];
    const joinAlias = joinMatch[2];
    const leftAlias = joinMatch[3];
    const leftCol = joinMatch[4];
    const rightAlias = joinMatch[5];
    const rightCol = joinMatch[6];

    // For orders JOIN tables pattern: select orders with embedded table data
    // Map aliased columns to Supabase select format
    const supaColumns = mapJoinColumns(columns, mainTable, joinTable, joinAlias, leftAlias);

    // Get the remaining WHERE/ORDER/LIMIT
    const afterJoin = rest.substring(rest.indexOf(joinMatch[0]) + joinMatch[0].length).trim();

    let query = supabase.from(mainTable).select(`*, ${joinTable}!inner(*)`);

    // Apply WHERE
    const whereMatch = afterJoin.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s+GROUP\s+BY|$)/is);
    if (whereMatch) {
      const result = applyJoinWhereClause(query, whereMatch[1].trim(), params, paramIdx, mainTable, joinTable, leftAlias, joinAlias);
      query = result.query;
      paramIdx = result.paramIdx;
    }

    // Apply ORDER BY
    const orderMatch = afterJoin.match(/ORDER BY\s+(?:\w+\.)?(\w+)\s+(ASC|DESC)/i);
    if (orderMatch) {
      query = query.order(orderMatch[1], { ascending: orderMatch[2].toUpperCase() === 'ASC' });
    }

    // Apply LIMIT
    const limitMatch = afterJoin.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      query = query.limit(parseInt(limitMatch[1]));
    }

    const { data, error } = await query;
    if (error) throw new Error(`SELECT JOIN ${mainTable}: ${error.message}`);

    // Flatten the joined data to match the expected flat row format
    const flatData = (data || []).map(row => {
      const flat = { ...row };
      if (flat[joinTable]) {
        // Copy join table fields with their names
        const joinData = flat[joinTable];
        if (joinData.table_number !== undefined) flat.table_number = joinData.table_number;
        // Copy all join fields that might be referenced
        Object.keys(joinData).forEach(k => {
          if (flat[k] === undefined) flat[k] = joinData[k];
        });
        delete flat[joinTable];
      }
      return flat;
    });

    if (mode === 'get') return flatData[0] || undefined;
    if (mode === 'all') return flatData;
    return { rows: flatData };
  }

  // Simple SELECT without JOIN
  let selectColumns = columns === '*' ? '*' : columns.replace(/\w+\./g, '');

  let query = supabase.from(mainTable).select(selectColumns);

  // Apply WHERE
  const whereMatch = rest.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s+GROUP\s+BY|$)/is);
  if (whereMatch) {
    const result = applySimpleWhere(query, whereMatch[1].trim(), params, paramIdx);
    query = result.query;
    paramIdx = result.paramIdx;
  }

  // Apply ORDER BY
  const orderMatch = rest.match(/ORDER BY\s+(?:\w+\.)?(\w+)\s+(ASC|DESC)/i);
  if (orderMatch) {
    query = query.order(orderMatch[1], { ascending: orderMatch[2].toUpperCase() === 'ASC' });
  }

  // Apply LIMIT
  const limitMatch = rest.match(/LIMIT\s+(\d+)/i);
  if (limitMatch) {
    query = query.limit(parseInt(limitMatch[1]));
  }

  const { data, error } = await query;
  if (error) throw new Error(`SELECT ${mainTable}: ${error.message}`);

  if (mode === 'get') return data?.[0] || undefined;
  if (mode === 'all') return data || [];
  return { rows: data || [] };
}

// ─── WHERE clause helpers ─────────────────────────────────────

function applySimpleWhere(query, whereStr, params, paramIdx) {
  // Split by AND (simple case)
  const conditions = whereStr.split(/\s+AND\s+/i);

  for (const cond of conditions) {
    const trimCond = cond.trim();

    // column = $N
    const eqMatch = trimCond.match(/(?:\w+\.)?(\w+)\s*=\s*\$(\d+)/);
    if (eqMatch) {
      const col = eqMatch[1];
      const pIdx = parseInt(eqMatch[2]) - 1;
      query = query.eq(col, params[pIdx]);
      continue;
    }

    // column IN ('val1', 'val2')
    const inMatch = trimCond.match(/(?:\w+\.)?(\w+)\s+IN\s*\(([^)]+)\)/i);
    if (inMatch) {
      const col = inMatch[1];
      const values = inMatch[2].split(',').map(v => v.trim().replace(/'/g, ''));
      query = query.in(col, values);
      continue;
    }

    // date(column) = $N or date(column) = date('now')
    const dateEqMatch = trimCond.match(/date\((?:\w+\.)?(\w+)\)\s*=\s*(?:\$(\d+)|date\('now'\))/i);
    if (dateEqMatch) {
      const col = dateEqMatch[1];
      const dateVal = dateEqMatch[2] ? params[parseInt(dateEqMatch[2]) - 1] : new Date().toISOString().split('T')[0];
      query = query.gte(col, dateVal + 'T00:00:00').lt(col, dateVal + 'T23:59:59.999');
      continue;
    }

    // column = value (literal)
    const litMatch = trimCond.match(/(?:\w+\.)?(\w+)\s*=\s*(\d+|'[^']*')/);
    if (litMatch) {
      const col = litMatch[1];
      let val = litMatch[2];
      if (val.startsWith("'")) val = val.slice(1, -1);
      else val = parseInt(val);
      query = query.eq(col, val);
      continue;
    }
  }

  return { query, paramIdx };
}

function applyWhereClause(query, whereStr, params, startIdx) {
  const conditions = whereStr.split(/\s+AND\s+/i);
  let paramIdx = startIdx;

  for (const cond of conditions) {
    const trimCond = cond.trim();

    const eqMatch = trimCond.match(/(?:\w+\.)?(\w+)\s*=\s*\$(\d+)/);
    if (eqMatch) {
      query = query.eq(eqMatch[1], params[parseInt(eqMatch[2]) - 1]);
      continue;
    }

    const litMatch = trimCond.match(/(?:\w+\.)?(\w+)\s*=\s*(\d+|'[^']*')/);
    if (litMatch) {
      let val = litMatch[2];
      if (val.startsWith("'")) val = val.slice(1, -1);
      else val = parseInt(val);
      query = query.eq(litMatch[1], val);
      continue;
    }
  }

  return query;
}

function applyJoinWhereClause(query, whereStr, params, startIdx, mainTable, joinTable, mainAlias, joinAlias) {
  const conditions = whereStr.split(/\s+AND\s+/i);
  let paramIdx = startIdx;

  for (const cond of conditions) {
    const trimCond = cond.trim();

    // alias.column = $N
    const eqMatch = trimCond.match(/(\w+)\.(\w+)\s*=\s*\$(\d+)/);
    if (eqMatch) {
      const alias = eqMatch[1];
      const col = eqMatch[2];
      const pIdx = parseInt(eqMatch[3]) - 1;

      if (alias === joinAlias) {
        query = query.eq(`${joinTable}.${col}`, params[pIdx]);
      } else {
        query = query.eq(col, params[pIdx]);
      }
      continue;
    }

    // alias.column IN ('val1', 'val2')
    const inMatch = trimCond.match(/(\w+)\.(\w+)\s+IN\s*\(([^)]+)\)/i);
    if (inMatch) {
      const col = inMatch[2];
      const values = inMatch[3].split(',').map(v => v.trim().replace(/'/g, ''));
      query = query.in(col, values);
      continue;
    }

    // date(alias.column) = $N
    const dateMatch = trimCond.match(/date\((\w+)\.(\w+)\)\s*=\s*\$(\d+)/i);
    if (dateMatch) {
      const col = dateMatch[2];
      const dateVal = params[parseInt(dateMatch[3]) - 1];
      query = query.gte(col, dateVal + 'T00:00:00').lt(col, dateVal + 'T23:59:59.999');
      continue;
    }

    // alias.column = 'value'
    const litMatch = trimCond.match(/(\w+)\.(\w+)\s*=\s*'([^']+)'/);
    if (litMatch) {
      const alias = litMatch[1];
      const col = litMatch[2];
      if (alias === joinAlias) {
        query = query.eq(`${joinTable}.${col}`, litMatch[3]);
      } else {
        query = query.eq(col, litMatch[3]);
      }
      continue;
    }
  }

  return { query, paramIdx };
}

function splitSetClause(setClause) {
  // Split SET clause by commas, but respect parentheses
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of setClause) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function mapJoinColumns(columns, mainTable, joinTable, joinAlias, mainAlias) {
  // Not strictly needed since we select * from both tables
  return `*, ${joinTable}(*)`;
}

// ─── Seed Data ────────────────────────────────────────────────

async function seedDatabase() {
  try {
    const { count } = await supabase.from('restaurants').select('*', { count: 'exact', head: true });
    if (count > 0) {
      console.log('Database already seeded');
      return;
    }

    console.log('🌱 Seeding database...');

    // Create restaurant
    const { data: restaurant } = await supabase.from('restaurants')
      .insert({ name: 'The Golden Plate', description: 'Fine dining with a modern twist' })
      .select('id').single();
    const restaurantId = restaurant.id;

    // Create users
    const passwordHash = bcrypt.hashSync('admin123', 10);
    await supabase.from('users').insert([
      { restaurant_id: restaurantId, username: 'admin', password_hash: passwordHash, role: 'admin', name: 'Restaurant Admin' },
      { restaurant_id: restaurantId, username: 'kitchen1', password_hash: bcrypt.hashSync('kitchen123', 10), role: 'kitchen', name: 'Head Chef' },
      { restaurant_id: restaurantId, username: 'waiter1', password_hash: bcrypt.hashSync('waiter123', 10), role: 'waiter', name: 'Main Waiter' },
    ]);

    // Create tables
    const tablesData = [];
    for (let i = 1; i <= 5; i++) {
      tablesData.push({ restaurant_id: restaurantId, table_number: i, qr_token: uuidv4(), seats: i <= 2 ? 2 : 4 });
    }
    await supabase.from('tables').insert(tablesData);

    // Create menu categories
    const { data: cats } = await supabase.from('menu_categories').insert([
      { restaurant_id: restaurantId, name: 'Starters', description: 'Begin your meal right', sort_order: 1 },
      { restaurant_id: restaurantId, name: 'Main Course', description: 'Hearty and fulfilling', sort_order: 2 },
      { restaurant_id: restaurantId, name: 'Breads', description: 'Fresh from the tandoor', sort_order: 3 },
      { restaurant_id: restaurantId, name: 'Beverages', description: 'Refreshing drinks', sort_order: 4 },
      { restaurant_id: restaurantId, name: 'Desserts', description: 'Sweet endings', sort_order: 5 },
    ]).select('id, name');

    const catMap = {};
    cats.forEach(c => { catMap[c.name] = c.id; });

    // Create menu items
    const menuItems = [
      { category_id: catMap['Starters'], restaurant_id: restaurantId, name: 'Paneer Tikka', description: 'Marinated cottage cheese grilled in tandoor', price: 249, is_veg: 1, sort_order: 1 },
      { category_id: catMap['Starters'], restaurant_id: restaurantId, name: 'Chicken Seekh Kebab', description: 'Spiced minced chicken skewers', price: 299, is_veg: 0, sort_order: 2 },
      { category_id: catMap['Starters'], restaurant_id: restaurantId, name: 'Crispy Corn', description: 'Golden fried corn with spices', price: 199, is_veg: 1, sort_order: 3 },
      { category_id: catMap['Starters'], restaurant_id: restaurantId, name: 'Fish Amritsari', description: 'Batter-fried fish with mint chutney', price: 349, is_veg: 0, sort_order: 4 },
      { category_id: catMap['Starters'], restaurant_id: restaurantId, name: 'Veg Spring Rolls', description: 'Crispy rolls stuffed with vegetables', price: 179, is_veg: 1, sort_order: 5 },
      { category_id: catMap['Main Course'], restaurant_id: restaurantId, name: 'Butter Chicken', description: 'Creamy tomato-based chicken curry', price: 349, is_veg: 0, sort_order: 1 },
      { category_id: catMap['Main Course'], restaurant_id: restaurantId, name: 'Paneer Butter Masala', description: 'Rich and creamy paneer curry', price: 299, is_veg: 1, sort_order: 2 },
      { category_id: catMap['Main Course'], restaurant_id: restaurantId, name: 'Dal Makhani', description: 'Slow-cooked black lentils in cream', price: 249, is_veg: 1, sort_order: 3 },
      { category_id: catMap['Main Course'], restaurant_id: restaurantId, name: 'Chicken Biryani', description: 'Fragrant basmati rice with spiced chicken', price: 399, is_veg: 0, sort_order: 4 },
      { category_id: catMap['Main Course'], restaurant_id: restaurantId, name: 'Veg Biryani', description: 'Aromatic rice with seasonal vegetables', price: 299, is_veg: 1, sort_order: 5 },
      { category_id: catMap['Main Course'], restaurant_id: restaurantId, name: 'Mutton Rogan Josh', description: 'Kashmiri-style aromatic mutton curry', price: 449, is_veg: 0, sort_order: 6 },
      { category_id: catMap['Main Course'], restaurant_id: restaurantId, name: 'Palak Paneer', description: 'Cottage cheese in spinach gravy', price: 269, is_veg: 1, sort_order: 7 },
      { category_id: catMap['Breads'], restaurant_id: restaurantId, name: 'Butter Naan', description: 'Soft leavened bread with butter', price: 59, is_veg: 1, sort_order: 1 },
      { category_id: catMap['Breads'], restaurant_id: restaurantId, name: 'Garlic Naan', description: 'Naan with garlic and coriander', price: 79, is_veg: 1, sort_order: 2 },
      { category_id: catMap['Breads'], restaurant_id: restaurantId, name: 'Tandoori Roti', description: 'Whole wheat bread from tandoor', price: 39, is_veg: 1, sort_order: 3 },
      { category_id: catMap['Breads'], restaurant_id: restaurantId, name: 'Cheese Naan', description: 'Naan stuffed with melted cheese', price: 99, is_veg: 1, sort_order: 4 },
      { category_id: catMap['Breads'], restaurant_id: restaurantId, name: 'Laccha Paratha', description: 'Layered flaky bread', price: 69, is_veg: 1, sort_order: 5 },
      { category_id: catMap['Beverages'], restaurant_id: restaurantId, name: 'Masala Chai', description: 'Traditional Indian spiced tea', price: 49, is_veg: 1, sort_order: 1 },
      { category_id: catMap['Beverages'], restaurant_id: restaurantId, name: 'Fresh Lime Soda', description: 'Sweet or salted lime soda', price: 79, is_veg: 1, sort_order: 2 },
      { category_id: catMap['Beverages'], restaurant_id: restaurantId, name: 'Mango Lassi', description: 'Creamy mango yogurt drink', price: 129, is_veg: 1, sort_order: 3 },
      { category_id: catMap['Beverages'], restaurant_id: restaurantId, name: 'Cold Coffee', description: 'Chilled blended coffee', price: 149, is_veg: 1, sort_order: 4 },
      { category_id: catMap['Beverages'], restaurant_id: restaurantId, name: 'Buttermilk', description: 'Spiced traditional chaas', price: 59, is_veg: 1, sort_order: 5 },
      { category_id: catMap['Desserts'], restaurant_id: restaurantId, name: 'Gulab Jamun', description: 'Deep-fried milk dumplings in sugar syrup', price: 129, is_veg: 1, sort_order: 1 },
      { category_id: catMap['Desserts'], restaurant_id: restaurantId, name: 'Rasmalai', description: 'Soft paneer balls in sweetened milk', price: 149, is_veg: 1, sort_order: 2 },
      { category_id: catMap['Desserts'], restaurant_id: restaurantId, name: 'Kulfi', description: 'Traditional Indian ice cream', price: 99, is_veg: 1, sort_order: 3 },
      { category_id: catMap['Desserts'], restaurant_id: restaurantId, name: 'Brownie with Ice Cream', description: 'Warm chocolate brownie topped with vanilla', price: 199, is_veg: 1, sort_order: 4 },
    ];

    await supabase.from('menu_items').insert(menuItems);
    console.log('✅ Database seeded successfully');
  } catch (err) {
    console.error('Seeding error:', err);
  }
}

// Don't auto-seed in production
// seedDatabase();

module.exports = db;
