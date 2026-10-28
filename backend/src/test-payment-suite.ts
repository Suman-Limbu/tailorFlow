import http from 'node:http';
import { app } from './app.js';
import { pool, closePool } from './db/pool.js';
import { generateToken, hashPassword } from './utils/security.js';

interface ApiResponse<T = any> {
  status: 'success' | 'error';
  message?: string;
  data?: T;
}

async function runPaymentTestSuite() {
  console.log('\n====================================================');
  console.log('   TAILORFLOW PHASE 2 PAYMENT & BALANCE API TESTS   ');
  console.log('====================================================\n');

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

  // Seed Admin, Tailor, Customer users
  const adminRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Payment Admin', $1, $2, $3, 'admin')
     RETURNING id;`,
    [`admin_pay_${timestamp}@example.com`, `9601${String(timestamp).slice(-6)}`, dummyHash]
  );
  const adminId = adminRes.rows[0].id;
  const adminToken = generateToken({ userId: adminId, email: 'admin@pay.com', role: 'admin' });

  const tailorRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Payment Tailor', $1, $2, $3, 'tailor')
     RETURNING id;`,
    [`tailor_pay_${timestamp}@example.com`, `9602${String(timestamp).slice(-6)}`, dummyHash]
  );
  const tailorId = tailorRes.rows[0].id;
  const tailorToken = generateToken({ userId: tailorId, email: 'tailor@pay.com', role: 'tailor' });

  const custUserRes = await pool.query<{ id: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Payment Customer User', $1, $2, $3, 'customer')
     RETURNING id;`,
    [`cust_pay_${timestamp}@example.com`, `9603${String(timestamp).slice(-6)}`, dummyHash]
  );
  const custUserId = custUserRes.rows[0].id;
  const custUserToken = generateToken({ userId: custUserId, email: 'cust@pay.com', role: 'customer' });

  // Seed Customer
  const custRes = await pool.query<{ id: string }>(
    `INSERT INTO customers (full_name, phone)
     VALUES ('Payment Test Customer', $1)
     RETURNING id;`,
    [`9611${String(timestamp).slice(-6)}`]
  );
  const customerId = custRes.rows[0].id;

  // Seed Order 1: Total 150.00, Discount 10.00, Net Payable 140.00
  const order1Res = await pool.query<{ id: string }>(
    `INSERT INTO orders (
       order_number, customer_id, total_amount, discount_amount, paid_amount, payment_status, status
     ) VALUES ($1, $2, 150.00, 10.00, 0.00, 'Unpaid', 'Pending')
     RETURNING id;`,
    [`ORD-PAY1-${timestamp}`, customerId]
  );
  const order1Id = order1Res.rows[0].id;

  // Seed Order 2: Cancelled Order with 50.00 paid deposit
  const order2Res = await pool.query<{ id: string }>(
    `INSERT INTO orders (
       order_number, customer_id, total_amount, discount_amount, paid_amount, payment_status, status
     ) VALUES ($1, $2, 100.00, 0.00, 50.00, 'Partial', 'Cancelled')
     RETURNING id;`,
    [`ORD-PAY2-${timestamp}`, customerId]
  );
  const order2Id = order2Res.rows[0].id;

  // Seed initial deposit payment on Order 2
  const order2DepositRes = await pool.query<{ id: string }>(
    `INSERT INTO payments (
       order_id, amount, payment_method, payment_type, notes, recorded_by
     ) VALUES ($1, 50.00, 'cash', 'advance', 'Initial deposit on cancelled order', $2)
     RETURNING id;`,
    [order2Id, adminId]
  );
  const order2DepositPaymentId = order2DepositRes.rows[0].id;

  let advancePaymentId: string = '';
  let finalPaymentId: string = '';

  try {
    // -------------------------------------------------------------
    // Test 1: Authorization Guards (Role Restrictions)
    // -------------------------------------------------------------
    console.log('--- Scenario 1: Authorization Guards ---');
    const noAuthRes = await apiRequest(`/api/orders/${order1Id}/payments`);
    assert(noAuthRes.status === 401, 'Unauthenticated request returns 401 Unauthorized');

    const custRoleRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: custUserToken,
      body: { amount: 50.0, payment_method: 'cash' },
    });
    assert(custRoleRes.status === 403, 'Customer role cannot record payment (403 Forbidden)');

    const tailorPayRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: tailorToken,
      body: { amount: 50.0, payment_method: 'cash' },
    });
    assert(tailorPayRes.status === 403, 'Tailor role cannot record payment (financial operation is Admin only)');

    const tailorRefundRes = await apiRequest(`/api/orders/${order2Id}/payments/${order2DepositPaymentId}/refund`, {
      method: 'POST',
      token: tailorToken,
      body: { amount: 50.0 },
    });
    assert(tailorRefundRes.status === 403, 'Tailor role cannot issue refunds (403 Forbidden)');

    const tailorViewRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      token: tailorToken,
    });
    assert(tailorViewRes.status === 200, 'Tailor staff role can view payment history (200 OK)');

    // -------------------------------------------------------------
    // Test 2: Input Validation Guards
    // -------------------------------------------------------------
    console.log('\n--- Scenario 2: Validation Guards ---');
    const badAmountRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: { amount: -50.0, payment_method: 'cash' },
    });
    assert(badAmountRes.status === 400, 'Negative payment amount returns 400 Bad Request');

    const zeroAmountRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: { amount: 0, payment_method: 'cash' },
    });
    assert(zeroAmountRes.status === 400, 'Zero payment amount returns 400 Bad Request');

    const badMethodRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: { amount: 50.0, payment_method: 'crypto_token' },
    });
    assert(badMethodRes.status === 400, 'Invalid payment method returns 400 Bad Request');

    const nonExistentOrderRes = await apiRequest(`/api/orders/00000000-0000-0000-0000-000000000000/payments`, {
      method: 'POST',
      token: adminToken,
      body: { amount: 50.0, payment_method: 'cash' },
    });
    assert(nonExistentOrderRes.status === 404, 'Non-existent order returns 404 Not Found');

    // -------------------------------------------------------------
    // Test 3: Advance Deposit Recording & Partial Status
    // -------------------------------------------------------------
    console.log('\n--- Scenario 3: Advance Deposit Recording & Status Synchronization ---');
    // Order 1: Net Payable is 140.00. Pay advance deposit of 50.00
    const advanceRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: {
        amount: 50.0,
        payment_method: 'cash',
        transaction_reference: 'REC-001',
        notes: 'Cash advance collected at shop counter',
      },
    });

    assert(advanceRes.status === 201, 'Advance payment recorded successfully (201 Created)');
    const advPayment = advanceRes.body.data?.payment;
    const advOrder = advanceRes.body.data?.order;

    assert(advPayment?.payment_type === 'advance', 'Initial payment defaulted to payment_type="advance"');
    assert(advPayment?.amount === 50.0, 'Payment amount recorded as 50.00');
    assert(advOrder?.paid_amount === 50.0, 'Order paid_amount synchronized to 50.00');
    assert(advOrder?.balance_due === 90.0, 'Order balance_due correctly calculated (140 - 50 = 90.00)');
    assert(advOrder?.payment_status === 'Partial', 'Order payment_status transitioned to "Partial"');

    advancePaymentId = advPayment?.id;

    // -------------------------------------------------------------
    // Test 4: Subsequent Payment & Full Settlement (Overpayment Protection)
    // -------------------------------------------------------------
    console.log('\n--- Scenario 4: Installment, Overpayment Guard & Full Settlement ---');
    // Current balance due is 90.00. Attempt overpayment of 100.00
    const overpaymentRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: { amount: 100.0, payment_method: 'upi_qr' },
    });
    assert(
      overpaymentRes.status === 400,
      'Overpayment (100.00 > balance 90.00) rejected with 400 Bad Request'
    );

    // Record installment of 40.00
    const installRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: {
        amount: 40.0,
        payment_method: 'upi_qr',
        payment_type: 'installment',
        transaction_reference: 'UPI-TXN-8849',
      },
    });
    assert(installRes.status === 201, 'Installment payment recorded (201 Created)');
    assert(installRes.body.data?.order?.paid_amount === 90.0, 'Order paid_amount is now 90.00');
    assert(installRes.body.data?.order?.balance_due === 50.0, 'Order balance_due is now 50.00');

    // Record final settlement payment of remaining 50.00
    const finalRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: {
        amount: 50.0,
        payment_method: 'card',
        transaction_reference: 'POS-AUTH-4411',
      },
    });
    assert(finalRes.status === 201, 'Final settlement payment recorded (201 Created)');
    const finalOrder = finalRes.body.data?.order;
    assert(finalOrder?.paid_amount === 140.0, 'Order paid_amount is 140.00');
    assert(finalOrder?.balance_due === 0.0, 'Order balance_due is 0.00');
    assert(finalOrder?.payment_status === 'Paid', 'Order payment_status transitioned to "Paid"');
    finalPaymentId = finalRes.body.data?.payment?.id;

    // Attempt payment on fully paid order
    const fullyPaidAttemptRes = await apiRequest(`/api/orders/${order1Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: { amount: 10.0, payment_method: 'cash' },
    });
    assert(fullyPaidAttemptRes.status === 400, 'Payment on fully paid order rejected');

    // -------------------------------------------------------------
    // Test 5: Refund Processing & Limits
    // -------------------------------------------------------------
    console.log('\n--- Scenario 5: Refund Operations & Limits ---');
    // Final payment was 50.00. Attempt refund of 60.00
    const excessiveRefundRes = await apiRequest(
      `/api/orders/${order1Id}/payments/${finalPaymentId}/refund`,
      {
        method: 'POST',
        token: adminToken,
        body: { amount: 60.0 },
      }
    );
    assert(excessiveRefundRes.status === 400, 'Refunding more than payment amount rejected (400 Bad Request)');

    // Attempt refund with non-existent payment ID
    const badPayIdRefundRes = await apiRequest(
      `/api/orders/${order1Id}/payments/00000000-0000-0000-0000-000000000000/refund`,
      {
        method: 'POST',
        token: adminToken,
        body: { amount: 10.0 },
      }
    );
    assert(badPayIdRefundRes.status === 404, 'Refund with unknown payment ID returns 404');

    // Partial refund of 20.00 on final payment (50.00)
    const partialRefundRes = await apiRequest(
      `/api/orders/${order1Id}/payments/${finalPaymentId}/refund`,
      {
        method: 'POST',
        token: adminToken,
        body: { amount: 20.0, notes: 'Fabric adjustment return' },
      }
    );
    assert(partialRefundRes.status === 201, 'Partial refund recorded (201 Created)');
    assert(partialRefundRes.body.data?.refund?.payment_type === 'refund', 'Recorded as payment_type="refund"');
    assert(
      partialRefundRes.body.data?.order?.paid_amount === 120.0,
      'Order paid_amount reduced from 140.00 to 120.00'
    );
    assert(
      partialRefundRes.body.data?.order?.payment_status === 'Partial',
      'Order payment_status transitioned back to "Partial"'
    );

    // Remaining refundable on final payment is now 30.00. Attempt to refund 40.00
    const exceedRemainingOnPayment = await apiRequest(
      `/api/orders/${order1Id}/payments/${finalPaymentId}/refund`,
      {
        method: 'POST',
        token: adminToken,
        body: { amount: 40.0 },
      }
    );
    assert(
      exceedRemainingOnPayment.status === 400,
      'Exceeding remaining refundable amount on this specific payment rejected'
    );

    // -------------------------------------------------------------
    // Test 6: Full Refund to Zero (Status -> Refunded)
    // -------------------------------------------------------------
    console.log('\n--- Scenario 6: Full Refund & "Refunded" Status Transition ---');
    // Refund remaining 30.00 on final payment
    await apiRequest(`/api/orders/${order1Id}/payments/${finalPaymentId}/refund`, {
      method: 'POST',
      token: adminToken,
      body: { amount: 30.0 },
    });

    // Refund advance payment (50.00)
    await apiRequest(`/api/orders/${order1Id}/payments/${advancePaymentId}/refund`, {
      method: 'POST',
      token: adminToken,
      body: { amount: 50.0 },
    });

    // Find and refund the installment payment (40.00)
    const historyRes = await apiRequest(`/api/orders/${order1Id}/payments`, { token: adminToken });
    const installmentPayment = historyRes.body.data?.payments?.find((p: any) => p.payment_type === 'installment');
    const finalFullRefundRes = await apiRequest(
      `/api/orders/${order1Id}/payments/${installmentPayment.id}/refund`,
      {
        method: 'POST',
        token: adminToken,
        body: { amount: 40.0 },
      }
    );

    assert(finalFullRefundRes.status === 201, 'Final refund transaction accepted (201 Created)');
    assert(
      finalFullRefundRes.body.data?.order?.paid_amount === 0.0,
      'Order paid_amount reduced to 0.00'
    );
    assert(
      finalFullRefundRes.body.data?.order?.payment_status === 'Refunded',
      'Order payment_status transitioned to "Refunded" when net collections reach zero'
    );

    // -------------------------------------------------------------
    // Test 7: Cancelled Order Handling
    // -------------------------------------------------------------
    console.log('\n--- Scenario 7: Cancelled Order Behavior ---');
    // Order 2 is cancelled. Attempt to accept new collection payment
    const cancelledPayRes = await apiRequest(`/api/orders/${order2Id}/payments`, {
      method: 'POST',
      token: adminToken,
      body: { amount: 20.0, payment_method: 'cash' },
    });
    assert(
      cancelledPayRes.status === 400,
      'Cannot record new collection payment on a cancelled order (400 Bad Request)'
    );

    // Refunding advance deposit on a cancelled order IS permitted
    const cancelledRefundRes = await apiRequest(
      `/api/orders/${order2Id}/payments/${order2DepositPaymentId}/refund`,
      {
        method: 'POST',
        token: adminToken,
        body: { amount: 50.0, notes: 'Refund deposit on cancelled order' },
      }
    );
    assert(
      cancelledRefundRes.status === 201,
      'Refunding deposit on cancelled order succeeded (201 Created)'
    );
    assert(
      cancelledRefundRes.body.data?.order?.payment_status === 'Refunded',
      'Cancelled order payment_status updated to "Refunded"'
    );

    // -------------------------------------------------------------
    // Test 8: Payment Ledger & Accounting History
    // -------------------------------------------------------------
    console.log('\n--- Scenario 8: Payment Ledger & Financial Summary ---');
    const ledgerRes = await apiRequest(`/api/orders/${order1Id}/payments`, { token: adminToken });
    assert(ledgerRes.status === 200, 'GET /api/orders/:id/payments returns 200 OK');
    const summary = ledgerRes.body.data;
    assert(summary?.gross_collected === 140.0, 'Gross collections accurately tracked (140.00)');
    assert(summary?.total_refunded === 140.0, 'Total refunds accurately tracked (140.00)');
    assert(summary?.paid_amount === 0.0, 'Net paid balance is 0.00');
    assert(summary?.payments?.length === 7, 'Contains all 3 collection records and 4 refund records (audit trail preserved)');

    // -------------------------------------------------------------
    // Test 9: Concurrency & Row-level Locking Protection
    // -------------------------------------------------------------
    console.log('\n--- Scenario 9: Concurrency Race-Condition Protection ---');
    // Seed Order 3 with Net Payable of 50.00
    const order3Res = await pool.query<{ id: string }>(
      `INSERT INTO orders (
         order_number, customer_id, total_amount, discount_amount, paid_amount, payment_status, status
       ) VALUES ($1, $2, 50.00, 0.00, 0.00, 'Unpaid', 'Pending')
       RETURNING id;`,
      [`ORD-CONCUR-${timestamp}`, customerId]
    );
    const order3Id = order3Res.rows[0].id;

    // Fire two concurrent payment requests simultaneously of 30.00 each (Total 60.00 > Net 50.00)
    const [p1Res, p2Res] = await Promise.all([
      apiRequest(`/api/orders/${order3Id}/payments`, {
        method: 'POST',
        token: adminToken,
        body: { amount: 30.0, payment_method: 'cash' },
      }),
      apiRequest(`/api/orders/${order3Id}/payments`, {
        method: 'POST',
        token: adminToken,
        body: { amount: 30.0, payment_method: 'card' },
      }),
    ]);

    const statuses = [p1Res.status, p2Res.status];
    assert(
      statuses.includes(201) && statuses.includes(400),
      'Concurrent payments handled atomically: 1 payment succeeded (201) and overpayment rejected (400)'
    );

    const checkOrder3 = await pool.query<{ paid_amount: string; payment_status: string }>(
      'SELECT paid_amount, payment_status FROM orders WHERE id = $1;',
      [order3Id]
    );
    assert(
      Number(checkOrder3.rows[0].paid_amount) === 30.0,
      'Final database balance is exactly 30.00 (no double-counting or balance corruption)'
    );

    // Clean up Order 3
    await pool.query('DELETE FROM payments WHERE order_id = $1;', [order3Id]);
    await pool.query('DELETE FROM orders WHERE id = $1;', [order3Id]);
  } finally {
    // Clean up payments
    await pool.query('DELETE FROM payments WHERE order_id IN ($1, $2);', [order1Id, order2Id]);
    // Clean up orders
    await pool.query('DELETE FROM orders WHERE id IN ($1, $2);', [order1Id, order2Id]);
    // Clean up customer
    await pool.query('DELETE FROM customers WHERE id = $1;', [customerId]);
    // Clean up users
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3);', [adminId, tailorId, custUserId]);

    server.close();
    await closePool();
  }

  console.log('\n====================================================');
  console.log(`PAYMENT TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPaymentTestSuite().catch((err) => {
  console.error('Fatal payment test error:', err);
  process.exit(1);
});
