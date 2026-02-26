// ─── QR Restaurant — Customer Frontend ───────────────────────

(function () {
    'use strict';

    // ─── State ───────────────────────────────────────────────

    let state = {
        token: null,
        tableInfo: null,
        menu: null,
        cart: [],         // { menu_item_id, name, price, quantity, notes, is_veg }
        paymentMode: null,
        currentOrderId: null,
        sseConnection: null,
        vegOnly: false,
        waiterCooldown: false
    };

    // ─── Init ────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', init);

    async function init() {
        const params = new URLSearchParams(window.location.search);
        state.token = params.get('token');

        // Check if we're tracking an order
        const trackingId = params.get('order');
        if (trackingId && state.token) {
            state.currentOrderId = trackingId;
            await validateTable();
            if (state.tableInfo) {
                await showTrackingView(trackingId);
                return;
            }
        }

        if (!state.token) {
            showError('Please scan the QR code on your table to start ordering.');
            return;
        }

        await validateTable();
    }

    async function validateTable() {
        try {
            const resp = await fetch(`/api/tables/validate/${state.token}`);
            if (!resp.ok) {
                showError('This QR code is no longer valid. Please ask your waiter for help.');
                return;
            }

            state.tableInfo = await resp.json();

            // If there's an unpaid postpaid order, show payment
            if (state.tableInfo.unpaid_order) {
                state.currentOrderId = state.tableInfo.unpaid_order.id;
                await showTrackingView(state.currentOrderId);
                return;
            }

            // If there's an active order, show tracking
            if (state.tableInfo.active_order) {
                state.currentOrderId = state.tableInfo.active_order.id;
                await showTrackingView(state.currentOrderId);
                return;
            }

            await loadMenu();
        } catch (err) {
            console.error('Validation error:', err);
            showError('Something went wrong. Please try scanning the QR code again.');
        }
    }

    async function loadMenu() {
        try {
            const resp = await fetch(`/api/menu/${state.tableInfo.restaurant_id}`);
            const data = await resp.json();
            state.menu = data;

            document.getElementById('restaurant-name').textContent = data.restaurant.name;
            document.getElementById('table-number').textContent = state.tableInfo.table_number;
            document.title = `${data.restaurant.name} — Table ${state.tableInfo.table_number}`;

            renderCategories(data.categories);
            renderMenu(data.categories);

            // Set default payment mode
            state.paymentMode = data.restaurant.prepaid_enabled ? 'PREPAID' : 'POSTPAID';

            hide('loading-view');
            show('menu-view');
        } catch (err) {
            console.error('Menu load error:', err);
            showError('Could not load the menu. Please check your connection.');
        }
    }

    // ─── Render ──────────────────────────────────────────────

    function renderCategories(categories) {
        const nav = document.getElementById('category-nav');
        nav.innerHTML = categories.map((cat, i) =>
            `<button class="category-tab ${i === 0 ? 'active' : ''}" onclick="scrollToCategory(${cat.id})" data-cat="${cat.id}">${cat.name}</button>`
        ).join('');
    }

    function renderMenu(categories) {
        const container = document.getElementById('menu-container');
        container.innerHTML = categories.map(cat => `
      <section class="menu-section" id="cat-${cat.id}">
        <h2 class="menu-section-title">${cat.name}</h2>
        ${cat.items.map(item => renderMenuItem(item)).join('')}
      </section>
    `).join('');

        // Add bottom padding for cart bar
        container.style.paddingBottom = '80px';
    }

    function renderMenuItem(item) {
        const cartItem = state.cart.find(c => c.menu_item_id === item.id);
        const qty = cartItem ? cartItem.quantity : 0;
        const badge = item.is_veg ? '<div class="veg-badge"></div>' : '<div class="nonveg-badge"></div>';

        return `
      <div class="menu-item" id="menu-item-${item.id}">
        ${badge}
        <div class="item-details">
          <div class="item-name">${item.name}</div>
          <div class="item-description">${item.description}</div>
        </div>
        <div class="item-actions">
          <div class="item-price">₹${item.price}</div>
          ${qty === 0
                ? `<button class="add-btn" onclick="event.stopPropagation(); addToCart(${item.id})">ADD</button>`
                : `<div class="qty-control">
                <button class="qty-btn" onclick="event.stopPropagation(); updateQty(${item.id}, -1)">−</button>
                <span class="qty-count">${qty}</span>
                <button class="qty-btn" onclick="event.stopPropagation(); updateQty(${item.id}, 1)">+</button>
              </div>`
            }
        </div>
      </div>
    `;
    }

    // ─── Cart ────────────────────────────────────────────────

    window.addToCart = function (itemId) {
        const allItems = state.menu.categories.flatMap(c => c.items);
        const item = allItems.find(i => i.id === itemId);
        if (!item) return;

        state.cart.push({
            menu_item_id: item.id,
            name: item.name,
            price: item.price,
            quantity: 1,
            notes: '',
            is_veg: item.is_veg
        });

        updateCartUI();
        refreshMenuItem(itemId);
        showToast(`${item.name} added`, 'success');
    };

    window.updateQty = function (itemId, delta) {
        const idx = state.cart.findIndex(c => c.menu_item_id === itemId);
        if (idx === -1) return;

        state.cart[idx].quantity += delta;
        if (state.cart[idx].quantity <= 0) {
            state.cart.splice(idx, 1);
        }

        updateCartUI();
        refreshMenuItem(itemId);
    };

    function refreshMenuItem(itemId) {
        const allItems = state.menu.categories.flatMap(c => c.items);
        const item = allItems.find(i => i.id === itemId);
        if (!item) return;

        const el = document.getElementById(`menu-item-${itemId}`);
        if (el) {
            el.outerHTML = renderMenuItem(item);
        }
    }

    function updateCartUI() {
        const totalItems = state.cart.reduce((s, c) => s + c.quantity, 0);
        const totalPrice = state.cart.reduce((s, c) => s + (c.price * c.quantity), 0);

        document.getElementById('cart-count').textContent = totalItems;
        document.getElementById('cart-total').textContent = totalPrice;
        document.getElementById('cart-total-drawer').textContent = totalPrice;

        if (totalItems > 0) {
            show('cart-bar');
        } else {
            hide('cart-bar');
        }
    }

    window.openCart = function () {
        renderCartDrawer();
        document.getElementById('cart-overlay').classList.add('open');
        document.body.style.overflow = 'hidden';
    };

    window.closeCartOnOverlay = function (e) {
        if (e.target === document.getElementById('cart-overlay')) {
            closeCart();
        }
    };

    function closeCart() {
        document.getElementById('cart-overlay').classList.remove('open');
        document.body.style.overflow = '';
    }

    window.clearCart = function () {
        const itemIds = state.cart.map(c => c.menu_item_id);
        state.cart = [];
        updateCartUI();
        itemIds.forEach(id => refreshMenuItem(id));
        closeCart();
        showToast('Cart cleared', 'info');
    };

    function renderCartDrawer() {
        const container = document.getElementById('cart-items');
        container.innerHTML = state.cart.map((item, idx) => `
      <div class="cart-item">
        <div class="${item.is_veg ? 'veg-badge' : 'nonveg-badge'}" style="margin-top:4px"></div>
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <input class="note-input" type="text" placeholder="Add note (e.g., less spicy, no onion)"
            value="${item.notes}" onchange="updateNote(${idx}, this.value)" onclick="event.stopPropagation()">
          ${item.notes ? `<div class="cart-item-notes">📝 ${item.notes}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <div class="cart-item-price">₹${item.price * item.quantity}</div>
          <div class="qty-control">
            <button class="qty-btn" onclick="updateCartItem(${idx}, -1)">−</button>
            <span class="qty-count">${item.quantity}</span>
            <button class="qty-btn" onclick="updateCartItem(${idx}, 1)">+</button>
          </div>
        </div>
      </div>
    `).join('');

        // Payment options
        const optionsContainer = document.getElementById('payment-options');
        const info = state.tableInfo;
        let options = '';

        if (info.prepaid_enabled) {
            options += `
        <div class="payment-option ${state.paymentMode === 'PREPAID' ? 'selected' : ''}" onclick="selectPayment('PREPAID')">
          <div class="payment-option-title">💳 Pay Now</div>
          <div class="payment-option-desc">Pay online before cooking</div>
        </div>
      `;
        }
        if (info.postpaid_enabled) {
            options += `
        <div class="payment-option ${state.paymentMode === 'POSTPAID' ? 'selected' : ''}" onclick="selectPayment('POSTPAID')">
          <div class="payment-option-title">🍽️ Pay Later</div>
          <div class="payment-option-desc">Pay after your meal</div>
        </div>
      `;
        }
        optionsContainer.innerHTML = options;

        // Update button text
        const btn = document.getElementById('place-order-btn');
        if (state.paymentMode === 'PREPAID') {
            const total = state.cart.reduce((s, c) => s + (c.price * c.quantity), 0);
            btn.textContent = `💳 Pay ₹${total} & Place Order`;
        } else {
            btn.textContent = '🍽️ Place Order';
        }
    }

    window.updateNote = function (idx, value) {
        if (state.cart[idx]) {
            state.cart[idx].notes = value;
        }
    };

    window.updateCartItem = function (idx, delta) {
        if (!state.cart[idx]) return;
        const itemId = state.cart[idx].menu_item_id;
        state.cart[idx].quantity += delta;
        if (state.cart[idx].quantity <= 0) {
            state.cart.splice(idx, 1);
        }
        updateCartUI();
        refreshMenuItem(itemId);
        renderCartDrawer();

        if (state.cart.length === 0) closeCart();
    };

    window.selectPayment = function (mode) {
        state.paymentMode = mode;
        renderCartDrawer();
    };

    // ─── Place Order ─────────────────────────────────────────

    window.placeOrder = async function () {
        if (state.cart.length === 0) return;

        const btn = document.getElementById('place-order-btn');
        btn.disabled = true;
        btn.textContent = 'Processing...';

        const items = state.cart.map(c => ({
            menu_item_id: c.menu_item_id,
            quantity: c.quantity,
            notes: c.notes
        }));

        try {
            // If we're adding to an existing order (via "Order More Items"), use add-items
            if (state.addingToOrderId) {
                const resp = await fetch(`/api/orders/${state.addingToOrderId}/add-items`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        table_token: state.token,
                        items
                    })
                });
                const result = await resp.json();
                if (result.order_id) {
                    state.currentOrderId = result.order_id;
                    state.cart = [];
                    updateCartUI();
                    closeCart();
                    showToast('Items added to your order!', 'success');
                    await showTrackingView(result.order_id);
                } else {
                    showToast(result.error || 'Failed to add items', 'error');
                    btn.disabled = false;
                    renderCartDrawer();
                }
                return;
            }

            if (state.paymentMode === 'PREPAID') {
                // Step 1: Create Razorpay order
                const totalAmount = state.cart.reduce((s, c) => s + (c.price * c.quantity), 0);
                const createResp = await fetch('/api/payments/create-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        amount: totalAmount,
                        table_token: state.token,
                        items,
                        payment_mode: 'PREPAID'
                    })
                });

                if (!createResp.ok) {
                    const errData = await createResp.json().catch(() => ({}));
                    showToast(errData.error || 'Failed to create payment order', 'error');
                    btn.disabled = false;
                    renderCartDrawer();
                    return;
                }

                const paymentOrder = await createResp.json();

                if (paymentOrder.mock_mode) {
                    // Mock mode — simulate successful payment
                    const verifyResp = await fetch('/api/payments/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            razorpay_payment_id: 'mock_pay_' + Date.now(),
                            razorpay_order_id: paymentOrder.razorpay_order_id,
                            razorpay_signature: '',
                            table_token: state.token,
                            items,
                            payment_mode: 'PREPAID'
                        })
                    });

                    const result = await verifyResp.json();
                    if (result.verified) {
                        state.currentOrderId = result.order_id;
                        state.cart = [];
                        updateCartUI();
                        closeCart();
                        showToast('Payment successful! Your order is placed.', 'success');
                        await showTrackingView(result.order_id);
                    } else {
                        showToast('Payment verification failed', 'error');
                        btn.disabled = false;
                        btn.textContent = '💳 Retry Payment';
                    }
                } else {
                    // Real Razorpay checkout
                    if (typeof window.Razorpay === 'undefined') {
                        showToast('Payment gateway is loading. Please wait and try again.', 'error');
                        btn.disabled = false;
                        renderCartDrawer();
                        return;
                    }

                    const options = {
                        key: paymentOrder.key_id,
                        amount: paymentOrder.amount,
                        currency: paymentOrder.currency,
                        name: state.menu.restaurant.name,
                        description: `Order at Table ${state.tableInfo.table_number}`,
                        order_id: paymentOrder.razorpay_order_id,
                        handler: async function (response) {
                            // Verify payment + create order
                            try {
                                const verifyResp = await fetch('/api/payments/verify', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        razorpay_payment_id: response.razorpay_payment_id,
                                        razorpay_order_id: response.razorpay_order_id,
                                        razorpay_signature: response.razorpay_signature,
                                        table_token: state.token,
                                        items,
                                        payment_mode: 'PREPAID'
                                    })
                                });

                                const result = await verifyResp.json();
                                if (result.verified) {
                                    state.currentOrderId = result.order_id;
                                    state.cart = [];
                                    updateCartUI();
                                    closeCart();
                                    showToast('Payment successful! Your order is placed.', 'success');
                                    await showTrackingView(result.order_id);
                                } else {
                                    showToast(result.error || 'Payment verification failed', 'error');
                                    btn.disabled = false;
                                    renderCartDrawer();
                                }
                            } catch (verifyErr) {
                                console.error('Verify error:', verifyErr);
                                showToast('Verification error. Please contact staff.', 'error');
                                btn.disabled = false;
                                renderCartDrawer();
                            }
                        },
                        modal: {
                            ondismiss: function () {
                                btn.disabled = false;
                                renderCartDrawer();
                                showToast('Payment cancelled', 'info');
                            }
                        },
                        prefill: {
                            contact: '9390418552',
                            method: 'upi'
                        },
                        config: {
                            display: {
                                blocks: {
                                    upi: {
                                        name: 'Pay via UPI',
                                        instruments: [
                                            {
                                                method: 'upi',
                                                flows: ['intent', 'collect', 'qr'],
                                                apps: ['google_pay', 'phonepe', 'paytm']
                                            }
                                        ]
                                    }
                                },
                                sequence: ['block.upi'],
                                preferences: {
                                    show_default_blocks: true
                                }
                            }
                        },
                        theme: { color: '#e8a838' }
                    };

                    const rzp = new window.Razorpay(options);
                    rzp.on('payment.failed', function (resp) {
                        console.error('Payment failed:', resp.error);
                        showToast(resp.error?.description || 'Payment failed. Please try again.', 'error');
                        btn.disabled = false;
                        renderCartDrawer();
                    });
                    rzp.open();
                }
            } else {
                // POSTPAID: add to existing order OR create new order
                let result;

                if (state.addingToOrderId) {
                    // Add items to existing POSTPAID order
                    const resp = await fetch(`/api/orders/${state.addingToOrderId}/add-items`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            table_token: state.token,
                            items
                        })
                    });
                    result = await resp.json();
                    if (result.order_id) {
                        state.cart = [];
                        updateCartUI();
                        closeCart();
                        showToast('Items added to your order!', 'success');
                        await showTrackingView(result.order_id);
                    } else {
                        showToast(result.error || 'Failed to add items', 'error');
                        btn.disabled = false;
                        renderCartDrawer();
                    }
                } else {
                    // Create new POSTPAID order
                    const resp = await fetch('/api/orders', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            table_token: state.token,
                            items,
                            payment_mode: 'POSTPAID'
                        })
                    });
                    result = await resp.json();
                    if (result.order_id) {
                        state.currentOrderId = result.order_id;
                        state.cart = [];
                        updateCartUI();
                        closeCart();
                        showToast('Order placed! We\'re getting it ready for you.', 'success');
                        await showTrackingView(result.order_id);
                    } else {
                        showToast(result.error || 'Failed to place order', 'error');
                        btn.disabled = false;
                        renderCartDrawer();
                    }
                }
            }
        } catch (err) {
            console.error('Order error:', err);
            showToast('Something went wrong. Please try again.', 'error');
            btn.disabled = false;
            renderCartDrawer();
        }
    };

    // ─── Order Tracking ──────────────────────────────────────

    async function showTrackingView(orderId) {
        try {
            const resp = await fetch(`/api/orders/${orderId}?token=${state.token}`);
            const order = await resp.json();

            hide('loading-view');
            hide('menu-view');
            show('tracking-view');

            document.getElementById('tracking-restaurant-name').textContent =
                state.tableInfo?.restaurant_name || 'Restaurant';
            document.getElementById('tracking-table-number').textContent =
                order.table_number || state.tableInfo?.table_number || '-';

            updateTrackingUI(order);

            // Connect SSE for live updates
            connectSSE(orderId);

            // Update URL
            window.history.replaceState({}, '', `/order?token=${state.token}&order=${orderId}`);
        } catch (err) {
            console.error('Tracking error:', err);
            showToast('Could not load order status', 'error');
        }
    }

    function updateTrackingUI(order) {
        const status = order.public_status;
        const icon = document.getElementById('tracking-icon');
        const statusEl = document.getElementById('tracking-status');
        const messageEl = document.getElementById('tracking-message');

        const statusConfig = {
            'Order placed': {
                icon: '📋',
                message: 'Your order has been received. Our kitchen team will start preparing it shortly.'
            },
            'Being prepared': {
                icon: '🍳',
                message: 'Your food is being prepared with care. Sit back and relax!'
            },
            'Almost ready': {
                icon: '✨',
                message: 'Your order is almost ready. Our waiter will bring it to your table soon.'
            },
            'Served': {
                icon: '🍽️',
                message: 'Your order has been served. Enjoy your meal!'
            }
        };

        const config = statusConfig[status] || statusConfig['Order placed'];
        icon.textContent = config.icon;
        statusEl.textContent = status;
        messageEl.textContent = config.message;

        // Status steps
        const steps = ['Order placed', 'Being prepared', 'Almost ready', 'Served'];
        const currentIdx = steps.indexOf(status);
        const stepsHtml = steps.map((step, i) => {
            let cls = '';
            if (i < currentIdx) cls = 'completed';
            else if (i === currentIdx) cls = 'active';
            return `
        <div class="status-step ${cls}">
          <div class="status-dot">${i < currentIdx ? '✓' : i === currentIdx ? '•' : ''}</div>
          <div class="status-text">
            <div class="status-label">${step}</div>
          </div>
        </div>
      `;
        }).join('');
        document.getElementById('status-steps').innerHTML = stepsHtml;

        // Order items
        const itemsHtml = (order.items || []).map(item =>
            `<div class="order-summary-item">
        <span>${item.quantity}× ${item.item_name}</span>
        <span>₹${item.price_at_order * item.quantity}</span>
      </div>`
        ).join('');
        document.getElementById('tracking-items').innerHTML = itemsHtml;
        document.getElementById('tracking-total').textContent = order.total_amount;

        // Pay bill button for postpaid
        if (order.payment_mode === 'POSTPAID' && order.payment_status !== 'paid') {
            document.getElementById('pay-bill-amount').textContent = order.total_amount;
            show('pay-bill-section');
            // Hide order-more if order was served (ready to pay)
            if (order.public_status === 'Served') {
                hide('order-more-section');
            } else {
                show('order-more-section');
            }
        } else if (order.payment_mode === 'POSTPAID' && order.payment_status === 'paid') {
            hide('pay-bill-section');
            hide('order-more-section');
        } else {
            hide('pay-bill-section');
            show('order-more-section');
        }
    }

    function connectSSE(orderId) {
        if (state.sseConnection) {
            state.sseConnection.close();
        }

        const sse = new EventSource(`/api/sse/order/${orderId}`);
        state.sseConnection = sse;

        sse.addEventListener('status-update', (e) => {
            const data = JSON.parse(e.data);
            document.getElementById('tracking-status').textContent = data.public_status;

            // Re-fetch full order to update UI
            fetch(`/api/orders/${orderId}?token=${state.token}`)
                .then(r => r.json())
                .then(order => updateTrackingUI(order));
        });

        sse.onerror = () => {
            console.warn('SSE connection lost, will reconnect...');
        };
    }

    // ─── Pay Bill (Postpaid) ─────────────────────────────────

    window.payBill = async function () {
        const payBtn = document.querySelector('#pay-bill-section .btn');
        if (payBtn) { payBtn.disabled = true; payBtn.textContent = 'Processing...'; }

        try {
            const createResp = await fetch('/api/payments/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    table_token: state.token,
                    order_id: state.currentOrderId,
                    payment_mode: 'POSTPAID'
                })
            });

            if (!createResp.ok) {
                const errData = await createResp.json().catch(() => ({}));
                showToast(errData.error || 'Failed to create payment', 'error');
                if (payBtn) { payBtn.disabled = false; payBtn.textContent = `💳 Pay Bill — ₹${document.getElementById('pay-bill-amount').textContent}`; }
                return;
            }

            const paymentOrder = await createResp.json();

            const onPaymentSuccess = async (razorpayPaymentId, razorpayOrderId, razorpaySignature) => {
                try {
                    const verifyResp = await fetch('/api/payments/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            razorpay_payment_id: razorpayPaymentId,
                            razorpay_order_id: razorpayOrderId,
                            razorpay_signature: razorpaySignature || '',
                            table_token: state.token,
                            payment_mode: 'POSTPAID',
                            order_id: state.currentOrderId
                        })
                    });

                    const result = await verifyResp.json();
                    if (result.verified) {
                        // Fetch full order for receipt
                        const orderResp = await fetch(`/api/orders/${state.currentOrderId}?token=${state.token}`);
                        const order = await orderResp.json();
                        showReceiptView(order, 'UPI / Online');
                    } else {
                        showToast(result.error || 'Verification failed', 'error');
                        if (payBtn) { payBtn.disabled = false; payBtn.textContent = `💳 Pay Bill — ₹${document.getElementById('pay-bill-amount').textContent}`; }
                    }
                } catch (verifyErr) {
                    console.error('Verify error:', verifyErr);
                    showToast('Verification error. Please contact staff.', 'error');
                    if (payBtn) { payBtn.disabled = false; }
                }
            };

            if (paymentOrder.mock_mode) {
                await onPaymentSuccess(
                    'mock_pay_' + Date.now(),
                    paymentOrder.razorpay_order_id,
                    ''
                );
            } else {
                if (typeof window.Razorpay === 'undefined') {
                    showToast('Payment gateway is loading. Please wait and try again.', 'error');
                    if (payBtn) { payBtn.disabled = false; }
                    return;
                }

                const options = {
                    key: paymentOrder.key_id,
                    amount: paymentOrder.amount,
                    currency: paymentOrder.currency,
                    name: state.tableInfo?.restaurant_name || 'Restaurant',
                    description: 'Bill Payment',
                    order_id: paymentOrder.razorpay_order_id,
                    handler: async function (response) {
                        await onPaymentSuccess(
                            response.razorpay_payment_id,
                            response.razorpay_order_id,
                            response.razorpay_signature
                        );
                    },
                    modal: {
                        ondismiss: function () {
                            showToast('Payment cancelled', 'info');
                            if (payBtn) { payBtn.disabled = false; payBtn.textContent = `💳 Pay Bill — ₹${document.getElementById('pay-bill-amount').textContent}`; }
                        }
                    },
                    prefill: { method: 'upi' },
                    theme: { color: '#e8a838' }
                };

                const rzp = new window.Razorpay(options);
                rzp.on('payment.failed', function (resp) {
                    showToast(resp.error?.description || 'Payment failed. Please try again.', 'error');
                    if (payBtn) { payBtn.disabled = false; }
                });
                rzp.open();
            }
        } catch (err) {
            console.error('Pay bill error:', err);
            showToast('Payment failed. Please try again.', 'error');
            if (payBtn) { payBtn.disabled = false; }
        }
    };

    window.goBackToMenu = async function () {
        if (state.sseConnection) {
            state.sseConnection.close();
        }
        // Remember the current order so new items get added to it (not a new order)
        if (state.currentOrderId) {
            state.addingToOrderId = state.currentOrderId;
        }
        hide('tracking-view');
        hide('receipt-view');

        // If menu was never loaded (page opened directly into tracking), load it now
        if (!state.menu) {
            await loadMenu();
        } else {
            show('menu-view');
        }

        // Reset cart to empty for the new round of items
        state.cart = [];
        updateCartUI();
        // Re-render menu items to reset any quantity badges
        if (state.menu) {
            renderMenu(state.menu.categories);
        }
        window.history.replaceState({}, '', `/order?token=${state.token}`);
    };

    function showReceiptView(order, paymentMethod) {
        if (state.sseConnection) { state.sseConnection.close(); }

        hide('tracking-view');
        hide('menu-view');
        show('receipt-view');

        document.getElementById('receipt-restaurant-name').textContent =
            state.tableInfo?.restaurant_name || 'Restaurant';
        document.getElementById('receipt-table-number').textContent =
            order.table_number || state.tableInfo?.table_number || '-';

        // Items
        const itemsHtml = (order.items || []).map(item =>
            `<div class="order-summary-item">
               <span>${item.quantity}× ${item.item_name}</span>
               <span>₹${item.price_at_order * item.quantity}</span>
             </div>`
        ).join('');
        document.getElementById('receipt-items').innerHTML = itemsHtml;
        document.getElementById('receipt-total').textContent = order.total_amount;

        // Payment details
        document.getElementById('receipt-payment-method').textContent =
            '💳 ' + (paymentMethod || (order.payment_mode === 'POSTPAID' ? 'Pay at Table' : 'Online'));
        const now = new Date();
        document.getElementById('receipt-time').textContent =
            now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) +
            ' · ' + now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

        // Clear addingToOrderId since order is fully paid
        state.addingToOrderId = null;
        state.currentOrderId = null;
    }

    // ─── Category Scroll ─────────────────────────────────────

    window.scrollToCategory = function (catId) {
        const section = document.getElementById(`cat-${catId}`);
        if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Update active tab
        document.querySelectorAll('.category-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.cat == catId);
        });
    };

    // ─── Helpers ─────────────────────────────────────────────

    function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
    function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

    function showError(message) {
        hide('loading-view');
        document.getElementById('error-message').textContent = message;
        show('error-view');
    }

    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span> ${message}`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-10px)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ─── Veg Filter ─────────────────────────────────────────

    window.toggleVegFilter = function () {
        state.vegOnly = !state.vegOnly;
        const btn = document.getElementById('veg-filter');
        btn.classList.toggle('active', state.vegOnly);

        // Filter visible items
        document.querySelectorAll('.menu-item').forEach(el => {
            const id = parseInt(el.id.replace('menu-item-', ''));
            const allItems = state.menu.categories.flatMap(c => c.items);
            const item = allItems.find(i => i.id === id);
            if (item) {
                el.style.display = (state.vegOnly && !item.is_veg) ? 'none' : '';
            }
        });

        // Hide sections that have no visible items
        document.querySelectorAll('.menu-section').forEach(section => {
            const visibleItems = section.querySelectorAll('.menu-item:not([style*="display: none"])');
            section.style.display = visibleItems.length === 0 ? 'none' : '';
        });

        showToast(state.vegOnly ? 'Showing veg items only' : 'Showing all items', 'info');
    };

    // ─── Call Waiter ─────────────────────────────────────────

    window.callWaiter = async function () {
        if (state.waiterCooldown) {
            showToast('Waiter has been notified. Please wait.', 'info');
            return;
        }

        const btn = document.getElementById('call-waiter-btn');
        btn.classList.add('called');
        btn.textContent = '✓';
        state.waiterCooldown = true;

        showToast('🔔 Waiter has been called to your table!', 'success');

        // Try to send to server (best-effort)
        try {
            await fetch('/api/tables/call-waiter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ table_token: state.token })
            });
        } catch (e) {
            // Silently fail — the visual feedback is enough
        }

        // Reset after 30 seconds
        setTimeout(() => {
            btn.classList.remove('called');
            btn.textContent = '🔔';
            state.waiterCooldown = false;
        }, 30000);
    };

})();
