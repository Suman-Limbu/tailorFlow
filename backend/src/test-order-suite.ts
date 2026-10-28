import http from 'node:http';
import { app } from './app.js';
import { pool, closePool } from './db/pool.js';
import { generateToken, hashPassword } from './utils/security.js';

interface ApiResponse<T = any> {
  status: 'success' | 'error';
  message?: string;
  data?: T;
}

async function runOrderTestSuite() {
  console.log('\n==================================================');
  console.log('   TAILORFLOW PHASE 2 ORDER MANAGEMENT API TESTS   ');
  console.log('==================================================\n');

  if (!pool) {
    throw new Error('Database pool not available.');
  }

  // Spin up test server on ephemeral port
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://localhost:${address.port}`;

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  async function apiRequest<T = any>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, any>;
      token?: string;
    } = {}
  ): Promise<{ status: number; body: ApiResponse<T> }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const body = (await res.json()) as ApiResponse<T>;
    return { status: res.status, body };
  }

  const timestamp = Date.now();
  const dummyHash = await hashPassword('Password123!');

  // 1. Seed Admin
  const adminRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Order Admin', $1, $2, $3, 'admin')
     RETURNING id;`,
    [`admin_ord_${timestamp}@example.com`, `9701${String(timestamp).slice(-6)}`, dummyHash]
  );
  const adminId = adminRes.rows[0].id;
  const adminToken = generateToken({ userId: adminId, email: 'admin@order.com', role: 'admin' });

  // 2. Seed Tailor 1 (Assigned)
  const tailor1Res = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Tailor One', $1, $2, $3, 'tailor')
     RETURNING id;`,
    [`tailor1_ord_${timestamp}@example.com`, `9702${String(timestamp).slice(-6)}`, dummyHash]
  );
  const tailor1Id = tailor1Res.rows[0].id;
  const tailor1Token = generateToken({ userId: tailor1Id, email: 'tailor1@order.com', role: 'tailor' });

  // 3. Seed Tailor 2 (Unassigned)
  const tailor2Res = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Tailor Two', $1, $2, $3, 'tailor')
     RETURNING id;`,
    [`tailor2_ord_${timestamp}@example.com`, `9703${String(timestamp).slice(-6)}`, dummyHash]
  );
  const tailor2Id = tailor2Res.rows[0].id;
  const tailor2Token = generateToken({ userId: tailor2Id, email: 'tailor2@order.com', role: 'tailor' });

  // 4. Seed Inactive Tailor
  const inactiveTailorRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role, is_active)
     VALUES ('Inactive Tailor', $1, $2, $3, 'tailor', FALSE)
     RETURNING id;`,
    [`inact_tailor_${timestamp}@example.com`, `9704${String(timestamp).slice(-6)}`, dummyHash]
  );
  const inactiveTailorId = inactiveTailorRes.rows[0].id;

  // 5. Seed Customer Portal User
  const customerUserRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Customer Portal User', $1, $2, $3, 'customer')
     RETURNING id;`,
    [`cust_user_ord_${timestamp}@example.com`, `9705${String(timestamp).slice(-6)}`, dummyHash]
  );
  const customerUserId = customerUserRes.rows[0].id;
  const customerToken = generateToken({ userId: customerUserId, email: 'cust@order.com', role: 'customer' });

  // 6. Seed Customers (Customer A and Customer B)
  const custARes = await pool.query<{ id: string }>(
    `INSERT INTO customers (full_name, phone)
     VALUES ('Customer Alpha', $1)
     RETURNING id;`,
    [`9711${String(timestamp).slice(-6)}`]
  );
  const customerAId = custARes.rows[0].id;

  const custBRes = await pool.query<{ id: string }>(
    `INSERT INTO customers (full_name, phone)
     VALUES ('Customer Beta', $1)
     RETURNING id;`,
    [`9712${String(timestamp).slice(-6)}`]
  );
  const customerBId = custBRes.rows[0].id;

  // 7. Seed Measurement Profiles for Customer A and Customer B
  const profARes = await pool.query<{ id: string }>(
    `INSERT INTO measurement_profiles (customer_id, title, garment_type, measurements)
     VALUES ($1, 'Alpha Shirt Profile', 'shirt', '{"chest": 40, "collar": 16}'::jsonb)
     RETURNING id;`,
    [customerAId]
  );
  const profileAId = profARes.rows[0].id;

  const profBRes = await pool.query<{ id: string }>(
    `INSERT INTO measurement_profiles (customer_id, title, garment_type, measurements)
     VALUES ($1, 'Beta Shirt Profile', 'shirt', '{"chest": 44, "collar": 17}'::jsonb)
     RETURNING id;`,
    [customerBId]
  );
  const profileBId = profBRes.rows[0].id;

  const createdOrderIds: string[] = [];

  try {
    // -------------------------------------------------------------
    // Test 1: Authorization Guards
    // -------------------------------------------------------------
    console.log('--- Scenario 1: Authorization Guards ---');
    const noAuthRes = await apiRequest('/api/orders');
    assert(noAuthRes.status === 401, 'Unauthenticated request returns 401 Unauthorized');

    const customerRes = await apiRequest('/api/orders', { token: customerToken });
    assert(customerRes.status === 403, 'Customer role accessing orders endpoint returns 403 Forbidden');

    // -------------------------------------------------------------
    // Test 2: Input & Validation Guards on Creation
    // -------------------------------------------------------------
    console.log('\n--- Scenario 2: Validation Guards on Order Creation ---');
    const nonExistentCustRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: '00000000-0000-0000-0000-000000000000',
        items: [{ garment_type: 'shirt', item_name: 'Shirt', quantity: 1, unit_price: 50 }],
      },
    });
    assert(nonExistentCustRes.status === 404, 'Non-existent customer returns 404 Not Found');

    const emptyItemsRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: { customer_id: customerAId, items: [] },
    });
    assert(emptyItemsRes.status === 400, 'Order with empty items array returns 400 Bad Request');

    const badQtyRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        items: [{ garment_type: 'shirt', item_name: 'Shirt', quantity: 0, unit_price: 50 }],
      },
    });
    assert(badQtyRes.status === 400, 'Item with quantity 0 returns 400 Bad Request');

    const badPriceRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        items: [{ garment_type: 'shirt', item_name: 'Shirt', quantity: 1, unit_price: -10 }],
      },
    });
    assert(badPriceRes.status === 400, 'Item with negative unit_price returns 400 Bad Request');

    const badDiscountRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        discount_amount: 150,
        items: [{ garment_type: 'shirt', item_name: 'Shirt', quantity: 1, unit_price: 100 }],
      },
    });
    assert(badDiscountRes.status === 400, 'Discount exceeding order total returns 400 Bad Request');

    const badDueDateRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        due_date: 'not-a-date',
        items: [{ garment_type: 'shirt', item_name: 'Shirt', quantity: 1, unit_price: 100 }],
      },
    });
    assert(badDueDateRes.status === 400, 'Invalid due date format returns 400 Bad Request');

    const inactiveTailorResTest = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        assigned_tailor_id: inactiveTailorId,
        items: [{ garment_type: 'shirt', item_name: 'Shirt', quantity: 1, unit_price: 100 }],
      },
    });
    assert(inactiveTailorResTest.status === 400, 'Assigning inactive tailor returns 400 Bad Request');

    // Attempt to use Customer B's profile for Customer A's order
    const crossProfileRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        items: [
          {
            garment_type: 'shirt',
            item_name: 'Shirt',
            quantity: 1,
            unit_price: 100,
            measurement_profile_id: profileBId, // Profile belongs to Customer B!
          },
        ],
      },
    });
    assert(
      crossProfileRes.status === 400,
      'Measurement profile belonging to another customer rejected (400 Bad Request)'
    );

    // -------------------------------------------------------------
    // Test 3: Transaction Rollback on Multi-item Failure
    // -------------------------------------------------------------
    console.log('\n--- Scenario 3: Transaction Atomicity & Rollback ---');
    const orderCountBefore = await pool.query<{ count: string }>('SELECT COUNT(*) FROM orders;');
    const failMultiItemRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        items: [
          { garment_type: 'shirt', item_name: 'Valid Shirt', quantity: 1, unit_price: 50 },
          { garment_type: 'trouser', item_name: 'Bad Trouser', quantity: -2, unit_price: 50 }, // Invalid!
        ],
      },
    });
    assert(failMultiItemRes.status === 400, 'Multi-item order with 1 bad item rejected');
    const orderCountAfter = await pool.query<{ count: string }>('SELECT COUNT(*) FROM orders;');
    assert(
      orderCountBefore.rows[0].count === orderCountAfter.rows[0].count,
      'Failed transaction rolled back cleanly without leaving partial records'
    );

    // -------------------------------------------------------------
    // Test 4: Successful Order Creation (Single Item & Snapshot)
    // -------------------------------------------------------------
    console.log('\n--- Scenario 4: Successful Order Creation (Single Item with Snapshot) ---');
    const createSingleRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        priority: 'high',
        due_date: '2026-11-15',
        assigned_tailor_id: tailor1Id,
        discount_amount: 10,
        notes: 'Priority wedding order',
        items: [
          {
            garment_type: 'shirt',
            item_name: 'Classic White Linen Shirt',
            quantity: 2,
            unit_price: 45.5,
            measurement_profile_id: profileAId,
            fabric_details: 'White Irish linen',
            special_instructions: 'Monogram on left cuff',
          },
        ],
      },
    });

    assert(createSingleRes.status === 201, 'Order created successfully (201 Created)');
    const order1 = createSingleRes.body.data?.order;
    assert(order1?.order_number?.startsWith('ORD-'), 'Unique order_number generated with ORD- prefix');
    assert(order1?.total_amount === 91.0, 'Order total_amount calculated server-side (2 * 45.5 = 91.00)');
    assert(order1?.discount_amount === 10.0, 'Discount amount applied');
    assert(order1?.net_payable === 81.0, 'Net payable correctly calculated (91 - 10 = 81.00)');
    assert(order1?.paid_amount === 0.0, 'Paid amount is 0.00');
    assert(order1?.payment_status === 'Unpaid', 'Initial payment status is "Unpaid"');
    assert(order1?.status === 'Pending', 'Initial order status is "Pending"');
    assert(order1?.items?.length === 1, 'Contains 1 item');
    assert(order1?.items[0]?.subtotal === 91.0, 'Item subtotal is 91.00');
    assert(order1?.items[0]?.snapshot?.snapshot_data?.chest === 40, 'Measurement snapshot captured and stored');
    assert(order1?.status_history?.length === 1, 'Initial status history recorded');
    assert(order1?.status_history[0]?.new_status === 'Pending', 'Status history shows initial "Pending"');

    if (order1?.id) {
      createdOrderIds.push(order1.id);
    }

    // -------------------------------------------------------------
    // Test 5: Successful Multi-item Order with Multiple Tailors
    // -------------------------------------------------------------
    console.log('\n--- Scenario 5: Multi-item Order with Item-level Tailor Assignments ---');
    const createMultiRes = await apiRequest('/api/orders', {
      method: 'POST',
      token: adminToken,
      body: {
        customer_id: customerAId,
        discount_amount: 15,
        items: [
          {
            garment_type: 'shirt',
            item_name: 'Blue Office Shirt',
            quantity: 1,
            unit_price: 40.0,
            assigned_tailor_id: tailor1Id, // Tailor 1 on shirt
          },
          {
            garment_type: 'trouser',
            item_name: 'Formal Navy Trousers',
            quantity: 1,
            unit_price: 60.0,
            assigned_tailor_id: tailor2Id, // Tailor 2 on trouser
            custom_measurements: { waist: 34, inseam: 31, outseam: 41 },
          },
        ],
      },
    });

    assert(createMultiRes.status === 201, 'Multi-item order created successfully (201 Created)');
    const order2 = createMultiRes.body.data?.order;
    assert(order2?.items?.length === 2, 'Order has 2 items');
    assert(order2?.total_amount === 100.0, 'Total is 100.00 (40 + 60)');
    assert(order2?.net_payable === 85.0, 'Net payable is 85.00 (100 - 15)');
    assert(order2?.items[1]?.snapshot?.snapshot_data?.waist === 34, 'Custom measurement snapshot captured');

    if (order2?.id) {
      createdOrderIds.push(order2.id);
    }

    // -------------------------------------------------------------
    // Test 6: Order Listing, Pagination & Tailor Role Isolation
    // -------------------------------------------------------------
    console.log('\n--- Scenario 6: Listing, Pagination & Tailor Role Scoping ---');
    const adminListRes = await apiRequest('/api/orders?page=1&limit=5', { token: adminToken });
    assert(adminListRes.status === 200, 'Admin can list all orders (200 OK)');
    assert(adminListRes.body.data?.orders?.length >= 2, 'Admin sees both created orders');

    // Tailor 1 is assigned to Order 1 and Order 2 item 1
    const tailor1ListRes = await apiRequest('/api/orders', { token: tailor1Token });
    assert(tailor1ListRes.status === 200, 'Tailor 1 can list assigned orders');
    assert(
      tailor1ListRes.body.data?.orders?.some((o: any) => o.id === order1.id) === true,
      'Tailor 1 sees assigned Order 1'
    );

    // Tailor 2 is ONLY assigned to item 2 of Order 2, NOT Order 1
    const tailor2ListRes = await apiRequest('/api/orders', { token: tailor2Token });
    assert(
      tailor2ListRes.body.data?.orders?.some((o: any) => o.id === order1.id) === false,
      'Tailor 2 does NOT see Order 1 (unassigned order hidden)'
    );

    // -------------------------------------------------------------
    // Test 7: Get Order by ID & Role Access
    // -------------------------------------------------------------
    console.log('\n--- Scenario 7: Retrieve Order by ID & Authorization ---');
    const getOrder1Res = await apiRequest(`/api/orders/${order1.id}`, { token: adminToken });
    assert(getOrder1Res.status === 200, 'Admin retrieves order by ID (200 OK)');
    assert(getOrder1Res.body.data?.order?.customer?.full_name === 'Customer Alpha', 'Customer details joined');

    const tailor2AccessDenied = await apiRequest(`/api/orders/${order1.id}`, { token: tailor2Token });
    assert(tailor2AccessDenied.status === 403, 'Tailor 2 accessing unassigned Order 1 returns 403 Forbidden');

    // -------------------------------------------------------------
    // Test 8: Status Workflow State Machine Transitions
    // -------------------------------------------------------------
    console.log('\n--- Scenario 8: Status Workflow Transitions ---');
    // Illegal jump: Pending -> Completed
    const badTransitionRes = await apiRequest(`/api/orders/${order1.id}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'Completed', comments: 'Attempt jump' },
    });
    assert(badTransitionRes.status === 400, 'Illegal transition Pending -> Completed rejected (400 Bad Request)');

    // Valid transition: Pending -> on work
    const toOnWorkRes = await apiRequest(`/api/orders/${order1.id}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'on work', comments: 'Fabrics cut, stitching commenced' },
    });
    assert(toOnWorkRes.status === 200, 'Valid transition Pending -> on work returns 200 OK');
    assert(toOnWorkRes.body.data?.order?.status === 'on work', 'Order status updated to "on work"');

    // Valid progression: on work -> Finishing
    const toFinishingRes = await apiRequest(`/api/orders/${order1.id}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'Finishing', comments: 'Buttons attached and ironed' },
    });
    assert(toFinishingRes.status === 200, 'Valid transition on work -> Finishing returns 200 OK');

    // Valid progression: Finishing -> Ready for Pickup
    const toPickupRes = await apiRequest(`/api/orders/${order1.id}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'Ready for Pickup', comments: 'Garment bagged, customer notified' },
    });
    assert(toPickupRes.status === 200, 'Valid transition Finishing -> Ready for Pickup returns 200 OK');

    // Valid progression: Ready for Pickup -> Completed
    const toCompletedRes = await apiRequest(`/api/orders/${order1.id}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'Completed', comments: 'Collected by customer' },
    });
    assert(toCompletedRes.status === 200, 'Valid transition Ready for Pickup -> Completed returns 200 OK');

    // Attempt to transition out of terminal Completed status
    const fromCompletedRes = await apiRequest(`/api/orders/${order1.id}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'Pending' },
    });
    assert(fromCompletedRes.status === 400, 'Transition out of terminal Completed status rejected (400)');

    // Verify complete status history
    const finalDetailRes = await apiRequest(`/api/orders/${order1.id}`, { token: adminToken });
    assert(
      finalDetailRes.body.data?.order?.status_history?.length === 5,
      'Status history has 5 entries tracking full lifecycle'
    );

    // -------------------------------------------------------------
    // Test 9: Item Tailor Assignment & Order Updates
    // -------------------------------------------------------------
    console.log('\n--- Scenario 9: Item-level Tailor Reassignment ---');
    const item1Id = order2.items[0].id;
    const assignTailorRes = await apiRequest(`/api/orders/${order2.id}/items/${item1Id}/tailor`, {
      method: 'PATCH',
      token: adminToken,
      body: { assigned_tailor_id: tailor2Id },
    });
    assert(assignTailorRes.status === 200, 'Reassigned item tailor to Tailor 2 (returns 200 OK)');
    assert(assignTailorRes.body.data?.item?.assigned_tailor_id === tailor2Id, 'Item assigned_tailor_id updated');

    // -------------------------------------------------------------
    // Test 10: Financial Consistency on Editing Orders with Payments
    // -------------------------------------------------------------
    console.log('\n--- Scenario 10: Financial Safety on Orders with Payments ---');
    // Order 2 net payable is 85.00. Seed a partial payment of 50.00
    await pool.query(
      `UPDATE orders 
       SET paid_amount = 50.00, payment_status = 'Partial' 
       WHERE id = $1;`,
      [order2.id]
    );

    // Attempt to increase discount to 60.00 (Total 100 - Discount 60 = Net 40.00 < Paid 50.00)
    const badDiscountUpdateRes = await apiRequest(`/api/orders/${order2.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { discount_amount: 60.0 },
    });
    assert(
      badDiscountUpdateRes.status === 400,
      'Increasing discount to reduce net payable below paid amount rejected (400 Bad Request)'
    );

    // Valid update: change priority and notes
    const validUpdateRes = await apiRequest(`/api/orders/${order2.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { priority: 'urgent', notes: 'Customer needs by Friday' },
    });
    assert(validUpdateRes.status === 200, 'Valid update on order with payments returns 200 OK');
    assert(validUpdateRes.body.data?.order?.priority === 'urgent', 'Priority updated to "urgent"');
  } finally {
    // Clean up created orders (cascades to items, snapshots, status history)
    for (const oid of createdOrderIds) {
      await pool.query('DELETE FROM orders WHERE id = $1;', [oid]);
    }
    // Clean up profiles
    await pool.query('DELETE FROM measurement_profiles WHERE customer_id IN ($1, $2);', [customerAId, customerBId]);
    // Clean up customers
    await pool.query('DELETE FROM customers WHERE id IN ($1, $2);', [customerAId, customerBId]);
    // Clean up users
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3, $4, $5);', [
      adminId,
      tailor1Id,
      tailor2Id,
      inactiveTailorId,
      customerUserId,
    ]);

    server.close();
    await closePool();
  }

  console.log('\n==================================================');
  console.log(`ORDER TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('==================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runOrderTestSuite().catch((err) => {
  console.error('Fatal order test error:', err);
  process.exit(1);
});
