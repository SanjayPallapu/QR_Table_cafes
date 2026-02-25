// ─── Waiter Dashboard JS ──────────────────────────────────────

(function () {
    'use strict';

    const token = localStorage.getItem('staff_token');
    const user = JSON.parse(localStorage.getItem('staff_user') || 'null');

    if (!token || !user || (user.role !== 'waiter' && user.role !== 'admin')) {
        window.location.href = '/staff';
        return;
    }

    let orders = [];
    let sse = null;

    document.addEventListener('DOMContentLoaded', () => {
        loadOrders();
        connectSSE();
        setInterval(updateTimers, 1000);
    });

    async function loadOrders() {
        try {
            const resp = await fetch('/api/orders/feed/waiter', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.status === 401 || resp.status === 403) { logout(); return; }
            orders = await resp.json();
            renderOrders();
        } catch (err) {
            console.error('Load error:', err);
        }
    }

    function connectSSE() {
        if (sse) sse.close();
        sse = new EventSource(`/api/sse/waiter?restaurant_id=${user.restaurant_id}`);
        const dot = document.getElementById('connection-dot');

        sse.addEventListener('connected', () => {
            dot.classList.remove('disconnected');
        });

        sse.addEventListener('order-updated', (e) => {
            const data = JSON.parse(e.data);
            if (data.internal_status === 'READY') {
                // A new READY order — reload to get full data
                loadOrders();
                playNotification();
                showToast(`Table ${data.table_number} order is READY!`, 'success');
            } else if (data.internal_status === 'SERVED') {
                orders = orders.filter(o => o.id !== data.order_id);
                renderOrders();
            }
        });

        sse.addEventListener('call-waiter', (e) => {
            const data = JSON.parse(e.data);
            playUrgentNotification();
            showToast(`🔔 Table ${data.table_number} is calling you!`, 'info');
        });

        sse.onerror = () => {
            dot.classList.add('disconnected');
            setTimeout(() => {
                if (sse.readyState === EventSource.CLOSED) connectSSE();
            }, 3000);
        };
    }

    function renderOrders() {
        const container = document.getElementById('orders-container');
        const emptyState = document.getElementById('empty-state');

        document.getElementById('stat-ready').textContent = orders.length;

        if (orders.length === 0) {
            container.innerHTML = '';
            emptyState.classList.remove('hidden');
            return;
        }

        emptyState.classList.add('hidden');

        container.innerHTML = orders.map(order => {
            const elapsed = getElapsedTime(order.updated_at || order.created_at);

            return `
        <div class="order-card">
          <div class="order-card-header">
            <div class="order-table">
              <div class="table-number-badge" style="background:var(--success-glow);color:var(--success);border-color:var(--success)">${order.table_number}</div>
              <div class="order-meta">
                <div class="order-id">#${order.id}</div>
                <div class="order-time">Ready ${elapsed.display} ago</div>
              </div>
            </div>
            <span class="status-badge status-ready">⬆ READY</span>
          </div>

          <div class="order-card-body">
            ${(order.items || []).map(item => `
              <div class="order-item-row">
                <div class="order-item-qty">${item.quantity}×</div>
                <div class="order-item-name">${item.item_name}</div>
              </div>
            `).join('')}
          </div>

          <div class="order-card-footer">
            <span class="payment-badge payment-${order.payment_mode.toLowerCase()}">${order.payment_mode}</span>
            <button class="btn btn-success btn-sm" onclick="markServed(${order.id})">
              ✅ Mark Served
            </button>
          </div>
        </div>
      `;
        }).join('');
    }

    window.markServed = async function (orderId) {
        try {
            const resp = await fetch(`/api/orders/${orderId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ internal_status: 'SERVED' })
            });

            if (resp.ok) {
                orders = orders.filter(o => o.id !== orderId);
                renderOrders();
                showToast(`Order #${orderId} served!`, 'success');
            } else {
                const data = await resp.json();
                showToast(data.error || 'Failed', 'error');
            }
        } catch (err) {
            showToast('Connection error', 'error');
        }
    };

    function getElapsedTime(dateStr) {
        const created = new Date(dateStr + 'Z');
        const now = new Date();
        const diff = Math.floor((now - created) / 1000);
        const minutes = Math.floor(diff / 60);
        const seconds = diff % 60;
        return { minutes, display: `${minutes}:${seconds.toString().padStart(2, '0')}` };
    }

    function updateTimers() {
        loadOrders(); // Simple refresh approach
    }

    function playNotification() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Two-tone chime — loud enough to hear
            [800, 1000].forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = freq;
                gain.gain.value = 0.3;
                osc.start(ctx.currentTime + i * 0.2);
                osc.stop(ctx.currentTime + i * 0.2 + 0.15);
            });
        } catch (e) { }
    }

    function playUrgentNotification() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Triple urgent beep — hard to miss
            [900, 1100, 900].forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = freq;
                gain.gain.value = 0.4;
                osc.start(ctx.currentTime + i * 0.25);
                osc.stop(ctx.currentTime + i * 0.25 + 0.18);
            });
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
