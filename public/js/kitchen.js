// ─── Kitchen Dashboard JS ─────────────────────────────────────

(function () {
    'use strict';

    const token = localStorage.getItem('staff_token');
    const user = JSON.parse(localStorage.getItem('staff_user') || 'null');

    if (!token || !user || (user.role !== 'kitchen' && user.role !== 'admin')) {
        window.location.href = '/staff';
        return;
    }

    let orders = [];
    let sse = null;
    let timerInterval = null;

    // ─── Init ────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', () => {
        loadOrders();
        connectSSE();
        timerInterval = setInterval(updateTimers, 1000);
    });

    async function loadOrders() {
        try {
            const resp = await fetch('/api/orders/feed/kitchen', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.status === 401 || resp.status === 403) {
                logout();
                return;
            }
            orders = await resp.json();
            renderOrders();
        } catch (err) {
            console.error('Load orders error:', err);
        }
    }

    function connectSSE() {
        if (sse) sse.close();
        sse = new EventSource(`/api/sse/kitchen?restaurant_id=${user.restaurant_id}`);

        const dot = document.getElementById('connection-dot');

        sse.addEventListener('connected', () => {
            dot.classList.remove('disconnected');
        });

        sse.addEventListener('new-order', (e) => {
            const order = JSON.parse(e.data);
            // Avoid duplicates
            if (!orders.find(o => o.id === order.id)) {
                orders.unshift(order);
                renderOrders();
                playNotification();
                showToast(`New order for Table ${order.table_number}!`, 'info');
            }
        });

        sse.addEventListener('order-updated', (e) => {
            const data = JSON.parse(e.data);
            const idx = orders.findIndex(o => o.id === data.order_id);
            if (idx !== -1) {
                // Remove if marked READY or SERVED (no longer kitchen's concern)
                if (data.internal_status === 'READY' || data.internal_status === 'SERVED') {
                    orders.splice(idx, 1);
                } else {
                    orders[idx].internal_status = data.internal_status;
                    orders[idx].public_status = data.public_status;
                }
                renderOrders();
            }
        });

        sse.onerror = () => {
            dot.classList.add('disconnected');
            setTimeout(() => {
                if (sse.readyState === EventSource.CLOSED) connectSSE();
            }, 3000);
        };
    }

    // ─── Render ──────────────────────────────────────────────

    function renderOrders() {
        const container = document.getElementById('orders-container');
        const emptyState = document.getElementById('empty-state');

        // Stats
        const newOrders = orders.filter(o => o.internal_status === 'PLACED').length;
        const preparing = orders.filter(o => o.internal_status === 'PREPARING').length;
        document.getElementById('stat-new').textContent = newOrders;
        document.getElementById('stat-preparing').textContent = preparing;
        document.getElementById('stat-total').textContent = orders.length;

        if (orders.length === 0) {
            container.innerHTML = '';
            emptyState.classList.remove('hidden');
            return;
        }

        emptyState.classList.add('hidden');

        container.innerHTML = orders.map(order => {
            const elapsed = getElapsedTime(order.created_at);
            const timerClass = elapsed.minutes >= 15 ? 'danger' : elapsed.minutes >= 8 ? 'warning' : '';
            const isPlaced = order.internal_status === 'PLACED';
            const isPreparing = order.internal_status === 'PREPARING';

            return `
        <div class="order-card" id="order-${order.id}">
          <div class="order-card-header">
            <div class="order-table">
              <div class="table-number-badge">${order.table_number}</div>
              <div class="order-meta">
                <div class="order-id">#${order.id}</div>
                <div class="order-time">${formatTime(order.created_at)}</div>
              </div>
            </div>
            <div class="order-timer ${timerClass}" data-created="${order.created_at}">
              ${elapsed.display}
            </div>
          </div>

          <div class="order-card-body">
            ${(order.items || []).map(item => `
              <div class="order-item-row">
                <div class="order-item-qty">${item.quantity}×</div>
                <div class="order-item-name">${item.item_name}</div>
              </div>
              ${item.notes ? `<div class="order-item-note">📝 ${item.notes}</div>` : ''}
            `).join('')}
          </div>

          <div class="order-card-footer">
            <div>
              <span class="status-badge status-${order.internal_status.toLowerCase()}">${order.internal_status}</span>
              <span class="payment-badge payment-${order.payment_mode.toLowerCase()}">${order.payment_mode}</span>
            </div>
            <div style="display:flex;gap:6px">
              ${isPlaced
                    ? `<button class="btn btn-primary btn-sm" onclick="updateStatus(${order.id}, 'PREPARING')">🍳 Start</button>`
                    : ''}
              ${isPreparing
                    ? `<button class="btn btn-success btn-sm" onclick="updateStatus(${order.id}, 'READY')">✅ Ready</button>`
                    : ''}
              ${isPlaced
                    ? `<button class="btn btn-success btn-sm" onclick="updateStatus(${order.id}, 'READY')">✅ Ready</button>`
                    : ''}
            </div>
          </div>
        </div>
      `;
        }).join('');
    }

    // ─── Actions ─────────────────────────────────────────────

    window.updateStatus = async function (orderId, status) {
        try {
            const resp = await fetch(`/api/orders/${orderId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ internal_status: status })
            });

            if (resp.ok) {
                if (status === 'READY') {
                    orders = orders.filter(o => o.id !== orderId);
                    showToast(`Order #${orderId} marked as READY`, 'success');
                } else {
                    const idx = orders.findIndex(o => o.id === orderId);
                    if (idx !== -1) orders[idx].internal_status = status;
                    showToast(`Order #${orderId} → ${status}`, 'info');
                }
                renderOrders();
            } else {
                const data = await resp.json();
                showToast(data.error || 'Failed to update', 'error');
            }
        } catch (err) {
            showToast('Connection error', 'error');
        }
    };

    // ─── Helpers ─────────────────────────────────────────────

    function getElapsedTime(createdAt) {
        const created = new Date(createdAt + 'Z');
        const now = new Date();
        const diff = Math.floor((now - created) / 1000);
        const minutes = Math.floor(diff / 60);
        const seconds = diff % 60;
        return {
            minutes,
            display: `${minutes}:${seconds.toString().padStart(2, '0')}`
        };
    }

    function updateTimers() {
        document.querySelectorAll('.order-timer[data-created]').forEach(el => {
            const elapsed = getElapsedTime(el.dataset.created);
            el.textContent = elapsed.display;
            el.className = `order-timer ${elapsed.minutes >= 15 ? 'danger' : elapsed.minutes >= 8 ? 'warning' : ''}`;
        });
    }

    function formatTime(dateStr) {
        const d = new Date(dateStr + 'Z');
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function playNotification() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 800;
            gain.gain.value = 0.1;
            osc.start();
            osc.stop(ctx.currentTime + 0.15);
            setTimeout(() => {
                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.frequency.value = 1000;
                gain2.gain.value = 0.1;
                osc2.start();
                osc2.stop(ctx.currentTime + 0.15);
            }, 180);
        } catch (e) { }
    }

    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    window.logout = function () {
        localStorage.removeItem('staff_token');
        localStorage.removeItem('staff_user');
        window.location.href = '/staff';
    };

})();
