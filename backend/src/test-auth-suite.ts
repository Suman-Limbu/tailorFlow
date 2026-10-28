import http from 'node:http';
import { app } from './app.js';
import { pool, closePool } from './db/pool.js';
import { generateToken } from './utils/security.js';

interface ApiResponse<T = any> {
  status: 'success' | 'error';
  message?: string;
  data?: T;
}

async function runTestSuite() {
  console.log('\n=============================================');
  console.log('   TAILORFLOW PHASE 2 AUTHENTICATION TESTS   ');
  console.log('=============================================\n');

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
  const testEmail = `test_customer_${timestamp}@example.com`;
  const testPhone = `9841${String(timestamp).slice(-6)}`;
  const testPassword = 'Password123!';

  let customerToken: string = '';
  let customerId: string = '';
  let customerUserId: string = '';

  try {
    // -------------------------------------------------------------
    // Test 1: Public Registration with customer role enforcement
    // -------------------------------------------------------------
    console.log('--- Scenario 1: Customer Registration & Privilege Escalation Guard ---');
    const regRes = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        full_name: 'John Doe',
        email: testEmail,
        phone: testPhone,
        password: testPassword,
        role: 'admin', // Attempt privilege escalation!
      },
    });

    assert(regRes.status === 201, 'Registration returns HTTP 201 Created');
    assert(regRes.body.status === 'success', 'Response status is "success"');
    assert(regRes.body.data?.user?.role === 'customer', 'Server strictly forced role="customer", ignoring "admin"');
    assert(!('password' in (regRes.body.data?.user || {})), 'Password is NOT exposed in response');
    assert(!('password_hash' in (regRes.body.data?.user || {})), 'Password hash is NOT exposed in response');
    assert(Boolean(regRes.body.data?.token), 'Signed JWT authentication token is returned');
    assert(Boolean(regRes.body.data?.customerId), 'Customer profile was created and linked');

    customerToken = regRes.body.data?.token;
    customerId = regRes.body.data?.customerId;
    customerUserId = regRes.body.data?.user?.id;

    // -------------------------------------------------------------
    // Test 2: Duplicate Account Rejections
    // -------------------------------------------------------------
    console.log('\n--- Scenario 2: Duplicate Account Handling ---');
    const dupEmailRes = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        full_name: 'Jane Doe',
        email: testEmail, // Duplicate email
        phone: `9842${String(timestamp).slice(-6)}`,
        password: testPassword,
      },
    });
    assert(dupEmailRes.status === 409, 'Duplicate email rejected with HTTP 409 Conflict');

    const dupPhoneRes = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        full_name: 'Jane Doe',
        email: `other_${timestamp}@example.com`,
        phone: testPhone, // Duplicate phone
        password: testPassword,
      },
    });
    assert(dupPhoneRes.status === 409, 'Duplicate phone rejected with HTTP 409 Conflict');

    // -------------------------------------------------------------
    // Test 3: Walk-in Customer Profile Linking
    // -------------------------------------------------------------
    console.log('\n--- Scenario 3: Linking to Pre-existing Walk-in Customer Profile ---');
    const walkInPhone = `9899${String(timestamp).slice(-6)}`;
    // Seed unlinked customer in DB
    const walkInInsert = await pool.query<{ id: string }>(
      `INSERT INTO customers (full_name, phone, address, notes)
       VALUES ('Walkin Customer', $1, 'Kathmandu, Nepal', 'Regular walk-in customer')
       RETURNING id;`,
      [walkInPhone]
    );
    const walkInId = walkInInsert.rows[0].id;

    const walkInReg = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        full_name: 'Walkin Customer Registered',
        email: `walkin_${timestamp}@example.com`,
        phone: walkInPhone,
        password: testPassword,
      },
    });
    assert(walkInReg.status === 201, 'Registration with walk-in phone returns 201');
    assert(walkInReg.body.data?.customerId === walkInId, 'Linked to existing walk-in customer profile ID without creating duplicates');

    // Clean up walkin user and customer
    await pool.query('DELETE FROM customers WHERE id = $1;', [walkInId]);
    if (walkInReg.body.data?.user?.id) {
      await pool.query('DELETE FROM users WHERE id = $1;', [walkInReg.body.data.user.id]);
    }

    // -------------------------------------------------------------
    // Test 4: Login with Email and Phone
    // -------------------------------------------------------------
    console.log('\n--- Scenario 4: Login Verification ---');
    const loginEmailRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        identifier: testEmail,
        password: testPassword,
      },
    });
    assert(loginEmailRes.status === 200, 'Login with email returns HTTP 200');
    assert(Boolean(loginEmailRes.body.data?.token), 'Login returns valid token');

    const loginPhoneRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        identifier: testPhone,
        password: testPassword,
      },
    });
    assert(loginPhoneRes.status === 200, 'Login with phone returns HTTP 200');

    // -------------------------------------------------------------
    // Test 5: Generic Error Messages on Invalid Credentials
    // -------------------------------------------------------------
    console.log('\n--- Scenario 5: Security against Account Enumeration ---');
    const wrongPassRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        identifier: testEmail,
        password: 'IncorrectPassword999!',
      },
    });
    assert(wrongPassRes.status === 401, 'Wrong password returns HTTP 401');

    const noUserRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        identifier: 'nonexistent_account@example.com',
        password: 'AnyPassword123!',
      },
    });
    assert(noUserRes.status === 401, 'Non-existent account returns HTTP 401');
    assert(
      wrongPassRes.body.message === noUserRes.body.message,
      'Messages for wrong password and non-existent account are identical (prevents enumeration)'
    );

    // -------------------------------------------------------------
    // Test 6: Authentication Middleware & /api/auth/me
    // -------------------------------------------------------------
    console.log('\n--- Scenario 6: Protected Routes & Token Validation ---');
    const meRes = await apiRequest('/api/auth/me', {
      token: customerToken,
    });
    assert(meRes.status === 200, 'GET /api/auth/me with valid token returns HTTP 200');
    assert(meRes.body.data?.user?.email === testEmail, 'Authenticated user email matches token');

    const noTokenRes = await apiRequest('/api/auth/me');
    assert(noTokenRes.status === 401, 'Request without token returns HTTP 401');

    const badTokenRes = await apiRequest('/api/auth/me', {
      token: 'invalid.bearer.token',
    });
    assert(badTokenRes.status === 401, 'Request with forged/malformed token returns HTTP 401');

    // Test expired token
    const expiredToken = generateToken(
      { userId: customerUserId, email: testEmail, role: 'customer', customerId },
      '-1s' // Expired 1 second ago
    );
    const expiredRes = await apiRequest('/api/auth/me', {
      token: expiredToken,
    });
    assert(expiredRes.status === 401, 'Request with expired token returns HTTP 401');
    assert(expiredRes.body.message?.includes('expired') === true, 'Response mentions token expiration');

    // -------------------------------------------------------------
    // Test 7: Inactive Account Handling
    // -------------------------------------------------------------
    console.log('\n--- Scenario 7: Deactivated Account Enforcement ---');
    // Deactivate user in DB
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1;', [customerUserId]);

    const inactiveMeRes = await apiRequest('/api/auth/me', {
      token: customerToken,
    });
    assert(inactiveMeRes.status === 403, 'Accessing protected route with deactivated account returns HTTP 403 Forbidden');

    const inactiveLoginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        identifier: testEmail,
        password: testPassword,
      },
    });
    assert(inactiveLoginRes.status === 403, 'Login attempt on deactivated account returns HTTP 403 Forbidden');

    // Reactivate user
    await pool.query('UPDATE users SET is_active = TRUE WHERE id = $1;', [customerUserId]);

    // -------------------------------------------------------------
    // Test 8: Authorization Middleware & Role-Based Access
    // -------------------------------------------------------------
    console.log('\n--- Scenario 8: Role-based Authorization & Staff Provisioning ---');
    // Customer attempting to create staff
    const customerStaffRes = await apiRequest('/api/auth/staff', {
      method: 'POST',
      token: customerToken,
      body: {
        full_name: 'Tailor Ram',
        email: `tailor_${timestamp}@example.com`,
        phone: `9860${String(timestamp).slice(-6)}`,
        password: testPassword,
        role: 'tailor',
      },
    });
    assert(customerStaffRes.status === 403, 'Customer role calling staff provisioning endpoint returns HTTP 403 Forbidden');

    // Create an Admin user directly in DB
    const adminEmail = `admin_${timestamp}@example.com`;
    const adminPhone = `9851${String(timestamp).slice(-6)}`;
    const adminInsert = await pool.query<{ id: string }>(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ('Admin Shop Owner', $1, $2, 'dummyhash', 'admin')
       RETURNING id;`,
      [adminEmail, adminPhone]
    );
    const adminId = adminInsert.rows[0].id;
    const adminToken = generateToken({
      userId: adminId,
      email: adminEmail,
      role: 'admin',
    });

    // Admin creates Tailor staff account
    const tailorPhone = `9861${String(timestamp).slice(-6)}`;
    const tailorEmail = `tailor_${timestamp}@example.com`;
    const adminStaffRes = await apiRequest('/api/auth/staff', {
      method: 'POST',
      token: adminToken,
      body: {
        full_name: 'Master Tailor Shyam',
        email: tailorEmail,
        phone: tailorPhone,
        password: testPassword,
        role: 'tailor',
      },
    });
    assert(adminStaffRes.status === 201, 'Admin can successfully create a tailor staff account');
    assert(adminStaffRes.body.data?.staff?.role === 'tailor', 'Created staff has role="tailor"');

    // Clean up created staff & admin
    if (adminStaffRes.body.data?.staff?.id) {
      await pool.query('DELETE FROM users WHERE id = $1;', [adminStaffRes.body.data.staff.id]);
    }
    await pool.query('DELETE FROM users WHERE id = $1;', [adminId]);
  } finally {
    // Clean up test customer
    if (customerId) {
      await pool.query('DELETE FROM customers WHERE id = $1;', [customerId]);
    }
    if (customerUserId) {
      await pool.query('DELETE FROM users WHERE id = $1;', [customerUserId]);
    }

    server.close();
    await closePool();
  }

  console.log('\n=============================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
