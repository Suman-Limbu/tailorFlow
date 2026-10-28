import http from 'node:http';
import { app } from './app.js';
import { pool, closePool } from './db/pool.js';
import { generateToken, hashPassword } from './utils/security.js';

interface ApiResponse<T = any> {
  status: 'success' | 'error';
  message?: string;
  data?: T;
}

async function runMeasurementTestSuite() {
  console.log('\n========================================================');
  console.log('   TAILORFLOW PHASE 2 MEASUREMENT MANAGEMENT API TESTS   ');
  console.log('========================================================\n');

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

  // Seed Admin, Tailor, Customer portal users
  const adminRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Measure Admin', $1, $2, $3, 'admin')
     RETURNING id;`,
    [`admin_meas_${timestamp}@example.com`, `9871${String(timestamp).slice(-6)}`, dummyHash]
  );
  const adminId = adminRes.rows[0].id;
  const adminToken = generateToken({ userId: adminId, email: 'admin@test.com', role: 'admin' });

  const tailorRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Measure Tailor', $1, $2, $3, 'tailor')
     RETURNING id;`,
    [`tailor_meas_${timestamp}@example.com`, `9872${String(timestamp).slice(-6)}`, dummyHash]
  );
  const tailorId = tailorRes.rows[0].id;
  const tailorToken = generateToken({ userId: tailorId, email: 'tailor@test.com', role: 'tailor' });

  const customerUserRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Measure Customer', $1, $2, $3, 'customer')
     RETURNING id;`,
    [`cust_meas_${timestamp}@example.com`, `9873${String(timestamp).slice(-6)}`, dummyHash]
  );
  const customerUserId = customerUserRes.rows[0].id;
  const customerToken = generateToken({ userId: customerUserId, email: 'customer@test.com', role: 'customer' });

  // Seed two distinct test customers
  const customer1Res = await pool.query<{ id: string }>(
    `INSERT INTO customers (full_name, phone)
     VALUES ('Customer Alpha', $1)
     RETURNING id;`,
    [`9881${String(timestamp).slice(-6)}`]
  );
  const customer1Id = customer1Res.rows[0].id;

  const customer2Res = await pool.query<{ id: string }>(
    `INSERT INTO customers (full_name, phone)
     VALUES ('Customer Beta', $1)
     RETURNING id;`,
    [`9882${String(timestamp).slice(-6)}`]
  );
  const customer2Id = customer2Res.rows[0].id;

  let profile1Id: string = '';
  let profile2Id: string = '';

  try {
    // -------------------------------------------------------------
    // Test 1: Authorization Guards
    // -------------------------------------------------------------
    console.log('--- Scenario 1: Authorization Guards ---');
    const noAuthRes = await apiRequest(`/api/customers/${customer1Id}/measurements`);
    assert(noAuthRes.status === 401, 'Unauthenticated request returns 401 Unauthorized');

    const custRoleRes = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      token: customerToken,
    });
    assert(custRoleRes.status === 403, 'Customer role accessing measurement endpoints returns 403 Forbidden');

    // -------------------------------------------------------------
    // Test 2: Profile Creation & Customer Scoping
    // -------------------------------------------------------------
    console.log('\n--- Scenario 2: Profile Creation & Customer Verification ---');
    const nonExistentCustId = '00000000-0000-0000-0000-000000000000';
    const nonExistentRes = await apiRequest(`/api/customers/${nonExistentCustId}/measurements`, {
      method: 'POST',
      token: adminToken,
      body: {
        title: 'Slim Shirt',
        garment_type: 'shirt',
        measurements: { chest: 40, collar: 15.5 },
      },
    });
    assert(nonExistentRes.status === 404, 'Non-existent customer returns 404 Not Found');

    const malformedCustIdRes = await apiRequest(`/api/customers/invalid-uuid/measurements`, {
      method: 'POST',
      token: adminToken,
      body: { title: 'Slim Shirt', garment_type: 'shirt', measurements: { chest: 40 } },
    });
    assert(malformedCustIdRes.status === 400, 'Malformed customer UUID returns 400 Bad Request');

    // Admin creates Profile 1 (Default Shirt)
    const create1Res = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      method: 'POST',
      token: adminToken,
      body: {
        title: 'Formal Cotton Shirt',
        garment_type: 'shirt',
        measurements: {
          chest: 39.5,
          waist: 34,
          collar: 15.5,
          sleeve_length: 25,
          shoulder: 18,
        },
        notes: 'Slightly loose on collar',
        is_default: true,
      },
    });
    assert(create1Res.status === 201, 'Admin creates measurement profile (returns 201 Created)');
    assert(create1Res.body.data?.profile?.is_default === true, 'Profile created as default');
    assert(create1Res.body.data?.profile?.measurements?.chest === 39.5, 'Measurements JSONB stored properly');
    profile1Id = create1Res.body.data?.profile?.id;

    // Tailor creates Profile 2 (Non-default Shirt for same customer)
    const create2Res = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      method: 'POST',
      token: tailorToken,
      body: {
        title: 'Casual Slim Shirt',
        garment_type: 'shirt',
        measurements: {
          chest: 38,
          waist: 32,
          collar: 15,
        },
        is_default: false,
      },
    });
    assert(create2Res.status === 201, 'Tailor can create measurement profile (returns 201 Created)');
    assert(create2Res.body.data?.profile?.is_default === false, 'Profile 2 is not default');
    profile2Id = create2Res.body.data?.profile?.id;

    // -------------------------------------------------------------
    // Test 3: Measurement Data & Type Validation
    // -------------------------------------------------------------
    console.log('\n--- Scenario 3: Validation Rules & Malformed Data Rejection ---');
    const emptyMeasurementsRes = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      method: 'POST',
      token: adminToken,
      body: { title: 'Test', garment_type: 'pant', measurements: {} },
    });
    assert(emptyMeasurementsRes.status === 400, 'Empty measurements object rejected (400)');

    const negativeValRes = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      method: 'POST',
      token: adminToken,
      body: { title: 'Test', garment_type: 'pant', measurements: { waist: -32 } },
    });
    assert(negativeValRes.status === 400, 'Negative measurement value rejected (400)');

    const zeroValRes = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      method: 'POST',
      token: adminToken,
      body: { title: 'Test', garment_type: 'pant', measurements: { waist: 0 } },
    });
    assert(zeroValRes.status === 400, 'Zero measurement value rejected (400)');

    const stringValRes = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      method: 'POST',
      token: adminToken,
      body: { title: 'Test', garment_type: 'pant', measurements: { waist: '32' } },
    });
    assert(stringValRes.status === 400, 'String measurement rejected without silent conversion (400)');

    const excessiveValRes = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      method: 'POST',
      token: adminToken,
      body: { title: 'Test', garment_type: 'pant', measurements: { waist: 550 } },
    });
    assert(excessiveValRes.status === 400, 'Excessive measurement value (>300) rejected (400)');

    const shortTitleRes = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      method: 'POST',
      token: adminToken,
      body: { title: 'A', garment_type: 'pant', measurements: { waist: 32 } },
    });
    assert(shortTitleRes.status === 400, 'Title under 2 characters rejected (400)');

    // -------------------------------------------------------------
    // Test 4: List Profiles & Garment Type Filtering
    // -------------------------------------------------------------
    console.log('\n--- Scenario 4: Listing Profiles & Filtering ---');
    const listAllRes = await apiRequest(`/api/customers/${customer1Id}/measurements`, {
      token: adminToken,
    });
    assert(listAllRes.status === 200, 'GET /api/customers/:id/measurements returns 200');
    assert(listAllRes.body.data?.count === 2, 'Listed 2 profiles for Customer 1');

    const filterShirtRes = await apiRequest(`/api/customers/${customer1Id}/measurements?garment_type=shirt`, {
      token: adminToken,
    });
    assert(filterShirtRes.status === 200, 'Filter by garment_type=shirt returns 200');
    assert(filterShirtRes.body.data?.count === 2, 'Matching garment_type count is 2');

    const filterPantRes = await apiRequest(`/api/customers/${customer1Id}/measurements?garment_type=trouser`, {
      token: adminToken,
    });
    assert(filterPantRes.body.data?.count === 0, 'Non-existent garment_type returns 0 count');

    // Verify Customer 2 has 0 profiles (cross-customer isolation)
    const listCust2Res = await apiRequest(`/api/customers/${customer2Id}/measurements`, {
      token: adminToken,
    });
    assert(listCust2Res.body.data?.count === 0, 'Customer 2 has 0 profiles (data isolated)');

    // -------------------------------------------------------------
    // Test 5: Retrieve Profile by ID & Customer Boundary Enforcement
    // -------------------------------------------------------------
    console.log('\n--- Scenario 5: Single Profile Retrieval & Boundary Checks ---');
    const getProfile1Res = await apiRequest(`/api/customers/${customer1Id}/measurements/${profile1Id}`, {
      token: adminToken,
    });
    assert(getProfile1Res.status === 200, 'GET profile by ID returns 200 OK');
    assert(getProfile1Res.body.data?.profile?.title === 'Formal Cotton Shirt', 'Profile title matches');

    // Attempt to access Customer 1's profile through Customer 2's URL
    const wrongCustomerAccessRes = await apiRequest(`/api/customers/${customer2Id}/measurements/${profile1Id}`, {
      token: adminToken,
    });
    assert(
      wrongCustomerAccessRes.status === 404,
      'Accessing Profile 1 under Customer 2 returns 404 (customer boundary protected)'
    );

    const malformedProfileIdRes = await apiRequest(`/api/customers/${customer1Id}/measurements/invalid-profile-id`, {
      token: adminToken,
    });
    assert(malformedProfileIdRes.status === 400, 'Malformed profile UUID returns 400 Bad Request');

    // -------------------------------------------------------------
    // Test 6: Update Measurement Profile
    // -------------------------------------------------------------
    console.log('\n--- Scenario 6: Updating Profile Details & Measurements ---');
    const updateRes = await apiRequest(`/api/customers/${customer1Id}/measurements/${profile1Id}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        title: 'Formal Cotton Shirt - Revised',
        measurements: {
          chest: 40,
          waist: 34.5,
          collar: 16,
        },
        notes: 'Adjusted collar after trial',
      },
    });
    assert(updateRes.status === 200, 'PUT profile returns 200 OK');
    assert(updateRes.body.data?.profile?.title === 'Formal Cotton Shirt - Revised', 'Title updated');
    assert(updateRes.body.data?.profile?.measurements?.chest === 40, 'Updated chest measurement is 40');
    assert(updateRes.body.data?.profile?.notes === 'Adjusted collar after trial', 'Notes updated');

    // -------------------------------------------------------------
    // Test 7: Atomic Default Profile Switching
    // -------------------------------------------------------------
    console.log('\n--- Scenario 7: Default Profile Switching ---');
    // Set Profile 2 as default
    const setDefaultRes = await apiRequest(`/api/customers/${customer1Id}/measurements/${profile2Id}/default`, {
      method: 'PATCH',
      token: adminToken,
    });
    assert(setDefaultRes.status === 200, 'PATCH default returns 200 OK');
    assert(setDefaultRes.body.data?.profile?.is_default === true, 'Profile 2 is now default');

    // Verify Profile 1 was atomically unset as default
    const checkProfile1Res = await apiRequest(`/api/customers/${customer1Id}/measurements/${profile1Id}`, {
      token: adminToken,
    });
    assert(checkProfile1Res.body.data?.profile?.is_default === false, 'Profile 1 was atomically unset as default');

    // -------------------------------------------------------------
    // Test 8: Protection of Historical Order Snapshots
    // -------------------------------------------------------------
    console.log('\n--- Scenario 8: Historical Order Snapshots Untouched & Protected ---');
    // Create a dummy order & snapshot to verify immutability triggers remain active
    const orderRes = await pool.query<{ id: string }>(
      `INSERT INTO orders (order_number, customer_id)
       VALUES ($1, $2)
       RETURNING id;`,
      [`ORD-TEST-${timestamp}`, customer1Id]
    );
    const orderId = orderRes.rows[0].id;

    const snapshotRes = await pool.query<{ id: string }>(
      `INSERT INTO order_measurement_snapshots (order_id, profile_source_id, garment_type, snapshot_data)
       VALUES ($1, $2, 'shirt', '{"chest": 39.5}'::jsonb)
       RETURNING id;`,
      [orderId, profile1Id]
    );
    const snapshotId = snapshotRes.rows[0].id;

    // Verify trigger blocks UPDATE on snapshot
    let snapshotUpdateBlocked = false;
    try {
      await pool.query(
        `UPDATE order_measurement_snapshots SET snapshot_data = '{"chest": 42}'::jsonb WHERE id = $1;`,
        [snapshotId]
      );
    } catch (err: any) {
      snapshotUpdateBlocked = true;
    }
    assert(snapshotUpdateBlocked, 'Database trigger successfully prevents UPDATE on order_measurement_snapshots');

    // Clean up snapshot and order
    await pool.query('DELETE FROM order_measurement_snapshots WHERE id = $1;', [snapshotId]);
    await pool.query('DELETE FROM orders WHERE id = $1;', [orderId]);
  } finally {
    // Clean up measurement profiles
    await pool.query('DELETE FROM measurement_profiles WHERE customer_id IN ($1, $2);', [customer1Id, customer2Id]);
    // Clean up customers
    await pool.query('DELETE FROM customers WHERE id IN ($1, $2);', [customer1Id, customer2Id]);
    // Clean up users
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3);', [adminId, tailorId, customerUserId]);

    server.close();
    await closePool();
  }

  console.log('\n========================================================');
  console.log(`MEASUREMENT TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runMeasurementTestSuite().catch((err) => {
  console.error('Fatal measurement test error:', err);
  process.exit(1);
});
