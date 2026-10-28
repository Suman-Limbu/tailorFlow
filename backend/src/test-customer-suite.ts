import http from 'node:http';
import { app } from './app.js';
import { pool, closePool } from './db/pool.js';
import { generateToken, hashPassword } from './utils/security.js';

interface ApiResponse<T = any> {
  status: 'success' | 'error';
  message?: string;
  data?: T;
}

async function runCustomerTestSuite() {
  console.log('\n======================================================');
  console.log('   TAILORFLOW PHASE 2 CUSTOMER MANAGEMENT API TESTS   ');
  console.log('======================================================\n');

  if (!pool) {
    throw new Error('Database pool not available.');
  }

  // Spin up test server on an ephemeral port
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

  // Seed Admin, Tailor, and Customer users for auth tokens
  const adminEmail = `admin_cust_${timestamp}@example.com`;
  const adminRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Test Admin', $1, $2, $3, 'admin')
     RETURNING id;`,
    [adminEmail, `9801${String(timestamp).slice(-6)}`, dummyHash]
  );
  const adminId = adminRes.rows[0].id;
  const adminToken = generateToken({ userId: adminId, email: adminEmail, role: 'admin' });

  const tailorEmail = `tailor_cust_${timestamp}@example.com`;
  const tailorRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Test Tailor', $1, $2, $3, 'tailor')
     RETURNING id;`,
    [tailorEmail, `9802${String(timestamp).slice(-6)}`, dummyHash]
  );
  const tailorId = tailorRes.rows[0].id;
  const tailorToken = generateToken({ userId: tailorId, email: tailorEmail, role: 'tailor' });

  const customerUserEmail = `portal_user_${timestamp}@example.com`;
  const customerUserRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Portal Customer', $1, $2, $3, 'customer')
     RETURNING id;`,
    [customerUserEmail, `9803${String(timestamp).slice(-6)}`, dummyHash]
  );
  const customerUserId = customerUserRes.rows[0].id;
  const customerToken = generateToken({ userId: customerUserId, email: customerUserEmail, role: 'customer' });

  const createdCustomerIds: string[] = [];

  try {
    // -------------------------------------------------------------
    // Test 1: Unauthenticated & Unauthorized Role Checks
    // -------------------------------------------------------------
    console.log('--- Scenario 1: Authorization Guards (Staff Only) ---');
    const noAuthRes = await apiRequest('/api/customers');
    assert(noAuthRes.status === 401, 'GET /api/customers without token returns 401 Unauthorized');

    const customerListRes = await apiRequest('/api/customers', { token: customerToken });
    assert(customerListRes.status === 403, 'Customer role accessing GET /api/customers returns 403 Forbidden');

    const customerCreateRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: customerToken,
      body: { full_name: 'Test', phone: '9812345678' },
    });
    assert(customerCreateRes.status === 403, 'Customer role calling POST /api/customers returns 403 Forbidden');

    // -------------------------------------------------------------
    // Test 2: Admin Creates Walk-in Customer
    // -------------------------------------------------------------
    console.log('\n--- Scenario 2: Admin Creates Walk-in Customer ---');
    const walkinPhone = `9844${String(timestamp).slice(-6)}`;
    const walkinEmail = `walkin_${timestamp}@example.com`;
    const createRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: adminToken,
      body: {
        full_name: 'Walk-in Client',
        phone: walkinPhone,
        email: walkinEmail,
        gender: 'male',
        address: 'New Road, Kathmandu',
        notes: 'Prefers cotton fabric',
      },
    });

    assert(createRes.status === 201, 'Admin can create customer (returns 201 Created)');
    assert(createRes.body.status === 'success', 'Response status is "success"');
    const createdCust = createRes.body.data?.customer;
    assert(createdCust?.user_id === null, 'Walk-in customer has user_id = null (no user account created)');
    assert(createdCust?.full_name === 'Walk-in Client', 'Full name saved correctly');
    assert(createdCust?.has_account === false, 'has_account flag is false');
    assert(Boolean(createdCust?.id), 'Customer has valid UUID assigned');

    if (createdCust?.id) {
      createdCustomerIds.push(createdCust.id);
    }

    // -------------------------------------------------------------
    // Test 3: Tailor Can Also Manage Customers
    // -------------------------------------------------------------
    console.log('\n--- Scenario 3: Tailor Staff Role Authorization ---');
    const tailorClientPhone = `9845${String(timestamp).slice(-6)}`;
    const tailorCreateRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: tailorToken,
      body: {
        full_name: 'Tailor Created Client',
        phone: tailorClientPhone,
        gender: 'female',
      },
    });
    assert(tailorCreateRes.status === 201, 'Tailor can create customer (returns 201)');
    if (tailorCreateRes.body.data?.customer?.id) {
      createdCustomerIds.push(tailorCreateRes.body.data.customer.id);
    }

    const tailorListRes = await apiRequest('/api/customers', { token: tailorToken });
    assert(tailorListRes.status === 200, 'Tailor can list customers (returns 200)');

    // -------------------------------------------------------------
    // Test 4: Validation Handling
    // -------------------------------------------------------------
    console.log('\n--- Scenario 4: Request Validation & Error Handling ---');
    const shortNameRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: adminToken,
      body: { full_name: 'A', phone: '9841112233' },
    });
    assert(shortNameRes.status === 400, 'Short full_name (< 2 chars) returns 400 Bad Request');

    const shortPhoneRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: adminToken,
      body: { full_name: 'Valid Name', phone: '123' },
    });
    assert(shortPhoneRes.status === 400, 'Short phone (< 6 chars) returns 400 Bad Request');

    const badEmailRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: adminToken,
      body: { full_name: 'Valid Name', phone: '9841112233', email: 'not-an-email' },
    });
    assert(badEmailRes.status === 400, 'Invalid email format returns 400 Bad Request');

    const badGenderRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: adminToken,
      body: { full_name: 'Valid Name', phone: '9841112233', gender: 'alien' },
    });
    assert(badGenderRes.status === 400, 'Invalid gender returns 400 Bad Request');

    const malformedUuidRes = await apiRequest('/api/customers/not-a-valid-uuid', {
      token: adminToken,
    });
    assert(malformedUuidRes.status === 400, 'Malformed UUID in path parameter returns 400 Bad Request');

    const nonExistentUuidRes = await apiRequest('/api/customers/00000000-0000-0000-0000-000000000000', {
      token: adminToken,
    });
    assert(nonExistentUuidRes.status === 404, 'Non-existent UUID returns 404 Not Found');

    // -------------------------------------------------------------
    // Test 5: Duplicate Phone & Email Conflicts
    // -------------------------------------------------------------
    console.log('\n--- Scenario 5: Conflict & Duplicate Protection ---');
    const dupPhoneRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: adminToken,
      body: { full_name: 'Duplicate Phone Guy', phone: walkinPhone },
    });
    assert(dupPhoneRes.status === 409, 'Duplicate phone number returns 409 Conflict');

    const dupEmailRes = await apiRequest('/api/customers', {
      method: 'POST',
      token: adminToken,
      body: {
        full_name: 'Duplicate Email Guy',
        phone: `9846${String(timestamp).slice(-6)}`,
        email: walkinEmail,
      },
    });
    assert(dupEmailRes.status === 409, 'Duplicate email returns 409 Conflict');

    // -------------------------------------------------------------
    // Test 6: Get Customer By ID & Update Customer
    // -------------------------------------------------------------
    console.log('\n--- Scenario 6: Customer Details Retrieval & Update ---');
    const getRes = await apiRequest(`/api/customers/${createdCust.id}`, { token: adminToken });
    assert(getRes.status === 200, 'GET /api/customers/:id returns 200 OK');
    assert(getRes.body.data?.customer?.full_name === 'Walk-in Client', 'Retrieved customer data matches');

    const updateRes = await apiRequest(`/api/customers/${createdCust.id}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        full_name: 'Walk-in Client Updated',
        address: 'Baneshwor, Kathmandu',
        notes: 'Updated measurement notes',
      },
    });
    assert(updateRes.status === 200, 'PUT /api/customers/:id returns 200 OK');
    assert(updateRes.body.data?.customer?.full_name === 'Walk-in Client Updated', 'Name successfully updated');
    assert(updateRes.body.data?.customer?.address === 'Baneshwor, Kathmandu', 'Address successfully updated');

    // -------------------------------------------------------------
    // Test 7: Preservation of user_id Link During Update
    // -------------------------------------------------------------
    console.log('\n--- Scenario 7: User-to-Customer Link Preservation ---');
    // Link customer to portal user account
    await pool.query('UPDATE customers SET user_id = $1 WHERE id = $2;', [customerUserId, createdCust.id]);

    const linkedGetRes = await apiRequest(`/api/customers/${createdCust.id}`, { token: adminToken });
    assert(linkedGetRes.body.data?.customer?.user_id === customerUserId, 'Customer has user_id linked');
    assert(linkedGetRes.body.data?.customer?.has_account === true, 'has_account flag is true');

    // Perform staff update on this linked customer
    const updateLinkedRes = await apiRequest(`/api/customers/${createdCust.id}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        notes: 'Customer visited shop again',
      },
    });
    assert(updateLinkedRes.status === 200, 'Staff update succeeded');
    assert(updateLinkedRes.body.data?.customer?.user_id === customerUserId, 'user_id was preserved and not wiped/changed');

    // -------------------------------------------------------------
    // Test 8: Pagination & Multi-field Search
    // -------------------------------------------------------------
    console.log('\n--- Scenario 8: Pagination & Search ---');
    const pageRes = await apiRequest('/api/customers?page=1&limit=2', { token: adminToken });
    assert(pageRes.status === 200, 'Paginated query returns 200');
    assert(pageRes.body.data?.pagination?.page === 1, 'Pagination page matches');
    assert(pageRes.body.data?.pagination?.limit === 2, 'Pagination limit matches');
    assert(Array.isArray(pageRes.body.data?.customers), 'Customers array returned');

    // Search by name
    const searchNameRes = await apiRequest('/api/customers?search=Client%20Updated', { token: adminToken });
    assert(
      searchNameRes.body.data?.customers?.some((c: any) => c.id === createdCust.id) === true,
      'Search by full_name found matching customer'
    );

    // Search by phone
    const searchPhoneRes = await apiRequest(`/api/customers?search=${walkinPhone}`, { token: adminToken });
    assert(
      searchPhoneRes.body.data?.customers?.some((c: any) => c.id === createdCust.id) === true,
      'Search by phone found matching customer'
    );
  } finally {
    // Clean up created test customers
    for (const cid of createdCustomerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1;', [cid]);
    }
    // Clean up created users
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3);', [adminId, tailorId, customerUserId]);

    server.close();
    await closePool();
  }

  console.log('\n======================================================');
  console.log(`CUSTOMER TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runCustomerTestSuite().catch((err) => {
  console.error('Fatal customer test error:', err);
  process.exit(1);
});
