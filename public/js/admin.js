// ─── Admin Panel JS ───────────────────────────────────────────

(function () {
    'use strict';

    const token = localStorage.getItem('staff_token');
    const user = JSON.parse(localStorage.getItem('staff_user') || 'null');

    if (!token || !user || user.role !== 'admin') {
        window.location.href = '/staff';
        return;
    }

    document.getElementById('admin-name').textContent = user.name || 'Administrator';

    let menuData = null;
    let tables = [];
    let currentTab = 'menu';

    // ─── Init ────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', () => {
        loadMenu();
        loadTables();
        // Set today's date for orders filter
        document.getElementById('orders-date').value = new Date().toISOString().split('T')[0];
    });

    // ─── Tab Switching ───────────────────────────────────────

    window.switchTab = function (tab) {
        currentTab = tab;
        document.querySelectorAll('.admin-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });
        document.querySelectorAll('.admin-content').forEach(c => c.classList.add('hidden'));
        document.getElementById(`tab-${tab}`).classList.remove('hidden');

        if (tab === 'orders') loadOrders();
        if (tab === 'settings') loadSettings();
    };

    // ─── Menu Management ────────────────────────────────────

    async function loadMenu() {
        try {
            const resp = await fetch(`/api/menu/${user.restaurant_id}`);
            menuData = await resp.json();
            renderMenuAdmin();
        } catch (err) {
            console.error('Load menu error:', err);
        }
    }

    function renderMenuAdmin() {
        const container = document.getElementById('menu-content');
        if (!menuData || !menuData.categories.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div>No menu items yet. Add a category to get started.</div></div>';
            return;
        }

        container.innerHTML = menuData.categories.map(cat => `
      <div style="margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <span style="font-weight:700;font-size:1rem">${cat.name}</span>
            <span style="color:var(--text-muted);font-size:0.8rem;margin-left:8px">${cat.items.length} items</span>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" onclick="editCategory(${cat.id}, '${cat.name.replace(/'/g, "\\'")}')">Edit</button>
            <button class="btn btn-sm" style="background:var(--danger);color:white;padding:6px 12px;border:none;border-radius:var(--radius-sm);cursor:pointer;font-family:var(--font-sans);font-size:0.8rem;font-weight:600" onclick="deleteCategory(${cat.id})">Delete</button>
          </div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Price</th>
              <th>Type</th>
              <th>Active</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${cat.items.map(item => `
              <tr>
                <td>
                  <div style="font-weight:600;color:var(--text-primary)">${item.name}</div>
                  <div style="font-size:0.75rem;color:var(--text-muted)">${item.description}</div>
                </td>
                <td style="font-weight:600;color:var(--accent)">₹${item.price}</td>
                <td>${item.is_veg ? '<span style="color:var(--success)">● Veg</span>' : '<span style="color:var(--danger)">▲ Non-veg</span>'}</td>
                <td>
                  <label class="toggle">
                    <input type="checkbox" ${item.active ? 'checked' : ''} onchange="toggleItem(${item.id}, this.checked)">
                    <span class="toggle-slider"></span>
                  </label>
                </td>
                <td>
                  <button class="btn btn-secondary btn-sm" onclick='editItem(${JSON.stringify(item).replace(/'/g, "\\'")})'>Edit</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('');
    }

    window.toggleItem = async function (id, active) {
        try {
            await fetch(`/api/menu/items/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ active: active ? 1 : 0 })
            });
            showToast(`Item ${active ? 'enabled' : 'disabled'}`, 'success');
        } catch (err) {
            showToast('Failed to update', 'error');
        }
    };

    window.showAddCategoryModal = function () {
        showModal('Add Category', `
      <div class="form-group">
        <label class="form-label">Category Name</label>
        <input class="form-input" type="text" id="modal-cat-name" placeholder="e.g., Starters, Soups">
      </div>
      <div class="form-group">
        <label class="form-label">Sort Order</label>
        <input class="form-input" type="number" id="modal-cat-order" value="0" min="0">
      </div>
    `, async () => {
            const name = document.getElementById('modal-cat-name').value;
            if (!name) return showToast('Name is required', 'error');

            await fetch('/api/menu/categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ name, sort_order: parseInt(document.getElementById('modal-cat-order').value) || 0 })
            });

            closeModal();
            loadMenu();
            showToast('Category added', 'success');
        });
    };

    window.editCategory = function (id, name) {
        showModal('Edit Category', `
      <div class="form-group">
        <label class="form-label">Category Name</label>
        <input class="form-input" type="text" id="modal-cat-name" value="${name}">
      </div>
    `, async () => {
            await fetch(`/api/menu/categories/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ name: document.getElementById('modal-cat-name').value })
            });
            closeModal();
            loadMenu();
            showToast('Category updated', 'success');
        });
    };

    window.deleteCategory = async function (id) {
        if (!confirm('Delete this category and all its items?')) return;
        await fetch(`/api/menu/categories/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        loadMenu();
        showToast('Category deleted', 'success');
    };

    window.showAddItemModal = function () {
        const catOptions = menuData.categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        showModal('Add Menu Item', `
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-input" id="modal-item-cat">${catOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Item Name</label>
        <input class="form-input" type="text" id="modal-item-name" placeholder="e.g., Butter Chicken">
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <input class="form-input" type="text" id="modal-item-desc" placeholder="Brief description">
      </div>
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1">
          <label class="form-label">Price (₹)</label>
          <input class="form-input" type="number" id="modal-item-price" min="0" step="1">
        </div>
        <div class="form-group" style="flex:1">
          <label class="form-label">Type</label>
          <select class="form-input" id="modal-item-veg">
            <option value="1">Veg</option>
            <option value="0">Non-veg</option>
          </select>
        </div>
      </div>
    `, async () => {
            const data = {
                category_id: parseInt(document.getElementById('modal-item-cat').value),
                name: document.getElementById('modal-item-name').value,
                description: document.getElementById('modal-item-desc').value,
                price: parseFloat(document.getElementById('modal-item-price').value),
                is_veg: parseInt(document.getElementById('modal-item-veg').value)
            };

            if (!data.name || !data.price) return showToast('Name and price required', 'error');

            await fetch('/api/menu/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(data)
            });
            closeModal();
            loadMenu();
            showToast('Item added', 'success');
        });
    };

    window.editItem = function (item) {
        if (typeof item === 'string') item = JSON.parse(item);
        const catOptions = menuData.categories.map(c =>
            `<option value="${c.id}" ${c.id === item.category_id ? 'selected' : ''}>${c.name}</option>`
        ).join('');

        showModal('Edit Menu Item', `
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-input" id="modal-item-cat">${catOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Item Name</label>
        <input class="form-input" type="text" id="modal-item-name" value="${item.name}">
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <input class="form-input" type="text" id="modal-item-desc" value="${item.description || ''}">
      </div>
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1">
          <label class="form-label">Price (₹)</label>
          <input class="form-input" type="number" id="modal-item-price" value="${item.price}" min="0">
        </div>
        <div class="form-group" style="flex:1">
          <label class="form-label">Type</label>
          <select class="form-input" id="modal-item-veg">
            <option value="1" ${item.is_veg ? 'selected' : ''}>Veg</option>
            <option value="0" ${!item.is_veg ? 'selected' : ''}>Non-veg</option>
          </select>
        </div>
      </div>
    `, async () => {
            await fetch(`/api/menu/items/${item.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    category_id: parseInt(document.getElementById('modal-item-cat').value),
                    name: document.getElementById('modal-item-name').value,
                    description: document.getElementById('modal-item-desc').value,
                    price: parseFloat(document.getElementById('modal-item-price').value),
                    is_veg: parseInt(document.getElementById('modal-item-veg').value)
                })
            });
            closeModal();
            loadMenu();
            showToast('Item updated', 'success');
        });
    };

    // ─── Tables Management ──────────────────────────────────

    async function loadTables() {
        try {
            const resp = await fetch('/api/tables', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            tables = await resp.json();
            renderTables();
        } catch (err) {
            console.error('Load tables error:', err);
        }
    }

    function renderTables() {
        const container = document.getElementById('tables-content');
        if (!tables.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🪑</div><div>No tables yet.</div></div>';
            return;
        }

        container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Table #</th>
            <th>Seats</th>
            <th>Status</th>
            <th>QR Code</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tables.map(t => `
            <tr>
              <td style="font-weight:700;font-size:1.1rem;color:var(--accent)">${t.table_number}</td>
              <td>${t.seats}</td>
              <td>${t.active
                ? '<span style="color:var(--success);font-weight:600">Active</span>'
                : '<span style="color:var(--text-muted);font-weight:600">Inactive</span>'
            }</td>
              <td>
                <button class="btn btn-secondary btn-sm" onclick="showQR(${t.id})">📱 View QR</button>
              </td>
              <td>
                <div style="display:flex;gap:6px">
                  <button class="btn btn-secondary btn-sm" onclick="editTable(${t.id}, ${t.table_number}, ${t.seats})">Edit</button>
                  <label class="toggle" style="margin-top:4px">
                    <input type="checkbox" ${t.active ? 'checked' : ''} onchange="toggleTable(${t.id}, this.checked)">
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    }

    window.showAddTableModal = function () {
        showModal('Add Table', `
      <div class="form-group">
        <label class="form-label">Table Number</label>
        <input class="form-input" type="number" id="modal-table-num" min="1">
      </div>
      <div class="form-group">
        <label class="form-label">Seats</label>
        <input class="form-input" type="number" id="modal-table-seats" value="4" min="1">
      </div>
    `, async () => {
            const num = parseInt(document.getElementById('modal-table-num').value);
            const seats = parseInt(document.getElementById('modal-table-seats').value);
            if (!num) return showToast('Table number required', 'error');

            const resp = await fetch('/api/tables', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ table_number: num, seats })
            });

            if (resp.ok) {
                closeModal();
                loadTables();
                showToast('Table added', 'success');
            } else {
                const data = await resp.json();
                showToast(data.error || 'Failed', 'error');
            }
        });
    };

    window.editTable = function (id, num, seats) {
        showModal('Edit Table', `
      <div class="form-group">
        <label class="form-label">Table Number</label>
        <input class="form-input" type="number" id="modal-table-num" value="${num}" min="1">
      </div>
      <div class="form-group">
        <label class="form-label">Seats</label>
        <input class="form-input" type="number" id="modal-table-seats" value="${seats}" min="1">
      </div>
    `, async () => {
            await fetch(`/api/tables/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    table_number: parseInt(document.getElementById('modal-table-num').value),
                    seats: parseInt(document.getElementById('modal-table-seats').value)
                })
            });
            closeModal();
            loadTables();
            showToast('Table updated', 'success');
        });
    };

    window.toggleTable = async function (id, active) {
        await fetch(`/api/tables/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ active: active ? 1 : 0 })
        });
        showToast(`Table ${active ? 'activated' : 'deactivated'}`, 'success');
    };

    window.showQR = async function (tableId) {
        try {
            const resp = await fetch(`/api/tables/${tableId}/qr`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await resp.json();

            showModal(`QR Code — Table ${data.table_number}`, `
        <div class="qr-display">
          <img src="${data.qr_image}" class="qr-image" alt="QR Code for Table ${data.table_number}">
          <p style="font-weight:600;margin-bottom:4px">Table ${data.table_number}</p>
          <div class="qr-url">${data.qr_url}</div>
          <div style="margin-top:16px;display:flex;gap:8px;justify-content:center">
            <button class="btn btn-primary btn-sm" onclick="downloadQR('${data.qr_image}', ${data.table_number})">⬇ Download</button>
            <button class="btn btn-secondary btn-sm" onclick="printQR('${data.qr_image}', ${data.table_number})">🖨 Print</button>
          </div>
        </div>
      `, null);
        } catch (err) {
            showToast('Failed to generate QR', 'error');
        }
    };

    window.downloadQR = function (dataUrl, tableNum) {
        const link = document.createElement('a');
        link.download = `table-${tableNum}-qr.png`;
        link.href = dataUrl;
        link.click();
    };

    window.printQR = function (dataUrl, tableNum) {
        const win = window.open('', '_blank');
        win.document.write(`
      <html><head><title>Table ${tableNum} QR</title></head>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:Arial">
        <img src="${dataUrl}" style="width:300px">
        <h2 style="margin-top:20px">Table ${tableNum}</h2>
        <p style="color:#666">Scan to order</p>
        <script>setTimeout(()=>window.print(), 500)<\/script>
      </body></html>
    `);
    };

    // ─── Orders ──────────────────────────────────────────────

    window.loadOrders = async function () {
        const date = document.getElementById('orders-date').value;
        const status = document.getElementById('orders-status').value;
        const params = new URLSearchParams();
        if (date) params.set('date', date);
        if (status) params.set('status', status);

        try {
            const resp = await fetch(`/api/orders/feed/all?${params}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const orders = await resp.json();
            renderOrders(orders);
        } catch (err) {
            console.error('Load orders error:', err);
        }
    };

    function renderOrders(orders) {
        const container = document.getElementById('orders-content');
        if (!orders.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><div>No orders found</div></div>';
            return;
        }

        container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Table</th>
            <th>Items</th>
            <th>Amount</th>
            <th>Payment</th>
            <th>Status</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map(o => `
            <tr>
              <td style="font-weight:600">#${o.id}</td>
              <td><span style="color:var(--accent);font-weight:700">${o.table_number}</span></td>
              <td>
                ${o.items.map(i => `<div style="font-size:0.8rem">${i.quantity}× ${i.item_name}</div>`).join('')}
              </td>
              <td style="font-weight:600;color:var(--accent)">₹${o.total_amount}</td>
              <td>
                <span class="payment-badge payment-${o.payment_mode.toLowerCase()}">${o.payment_mode}</span>
                ${o.payment ? `<div style="font-size:0.7rem;color:${o.payment.verified ? 'var(--success)' : 'var(--text-muted)'};margin-top:2px">${o.payment.verified ? '✓ Verified' : o.payment.status}</div>` : ''}
              </td>
              <td><span class="status-badge status-${o.internal_status.toLowerCase()}">${o.internal_status}</span></td>
              <td style="font-size:0.8rem;color:var(--text-muted)">${new Date(o.created_at + 'Z').toLocaleString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    }

    // ─── Settings ────────────────────────────────────────────

    async function loadSettings() {
        try {
            const resp = await fetch(`/api/menu/${user.restaurant_id}`);
            const data = await resp.json();
            const r = data.restaurant;

            document.getElementById('settings-content').innerHTML = `
        <div style="max-width:500px">
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:20px;margin-bottom:16px">
            <h3 style="font-size:0.95rem;font-weight:700;margin-bottom:16px">Restaurant Info</h3>
            <div class="form-group">
              <label class="form-label">Restaurant Name</label>
              <input class="form-input" type="text" id="setting-name" value="${r.name}">
            </div>
            <div class="form-group">
              <label class="form-label">Description</label>
              <input class="form-input" type="text" id="setting-desc" value="${r.description || ''}">
            </div>
          </div>

          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:20px;margin-bottom:16px">
            <h3 style="font-size:0.95rem;font-weight:700;margin-bottom:16px">Payment Options</h3>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0">
              <div>
                <div style="font-weight:600">Prepaid (Pay Before)</div>
                <div style="font-size:0.8rem;color:var(--text-muted)">Customer pays via Razorpay before order reaches kitchen</div>
              </div>
              <label class="toggle">
                <input type="checkbox" id="setting-prepaid" ${r.prepaid_enabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;margin-top:8px">
              <div>
                <div style="font-weight:600">Postpaid (Pay After)</div>
                <div style="font-size:0.8rem;color:var(--text-muted)">Customer pays after eating via Razorpay</div>
              </div>
              <label class="toggle">
                <input type="checkbox" id="setting-postpaid" ${r.postpaid_enabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:20px;margin-bottom:16px">
            <h3 style="font-size:0.95rem;font-weight:700;margin-bottom:16px">Staff Credentials</h3>
            <table class="data-table" style="font-size:0.8rem">
              <tr><td>Admin</td><td><code>admin / admin123</code></td></tr>
              <tr><td>Kitchen</td><td><code>kitchen1 / kitchen123</code></td></tr>
              <tr><td>Waiter</td><td><code>waiter1 / waiter123</code></td></tr>
            </table>
          </div>

          <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
        </div>
      `;
        } catch (err) {
            console.error('Load settings error:', err);
        }
    }

    window.saveSettings = async function () {
        showToast('Settings saved (note: full restaurant settings update requires backend endpoint expansion)', 'info');
    };

    // ─── Modal System ────────────────────────────────────────

    function showModal(title, body, onSave) {
        const container = document.getElementById('modal-container');
        container.innerHTML = `
      <div class="modal-overlay" onclick="closeModal()">
        <div class="modal" onclick="event.stopPropagation()">
          <div class="modal-header">
            <h3 class="modal-title">${title}</h3>
            <button class="modal-close" onclick="closeModal()">✕</button>
          </div>
          <div class="modal-body">${body}</div>
          ${onSave ? `
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" onclick="closeModal()">Cancel</button>
              <button class="btn btn-primary btn-sm" id="modal-save-btn">Save</button>
            </div>
          ` : `
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" onclick="closeModal()">Close</button>
            </div>
          `}
        </div>
      </div>
    `;

        if (onSave) {
            document.getElementById('modal-save-btn').addEventListener('click', onSave);
        }
    }

    window.closeModal = function () {
        document.getElementById('modal-container').innerHTML = '';
    };

    // ─── Helpers ─────────────────────────────────────────────

    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    window.logout = function () {
        localStorage.removeItem('staff_token');
        localStorage.removeItem('staff_user');
        window.location.href = '/staff';
    };
})();
