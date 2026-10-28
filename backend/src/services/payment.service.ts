import { pool } from '../db/pool.js';
import { isValidUuid } from '../utils/validation.js';
import { roundCurrency } from '../utils/currency.js';
import type {
  Payment,
  PaymentMethod,
  PaymentType,
  RecordPaymentInput,
  RecordRefundInput,
  OrderPaymentSummary,
} from '../types/payment.js';
import type { PaymentStatus } from '../types/order.js';

export class PaymentError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'PaymentError';
  }
}

const VALID_PAYMENT_METHODS: PaymentMethod[] = [
  'cash',
  'card',
  'upi_qr',
  'bank_transfer',
  'other',
];

const VALID_COLLECTION_PAYMENT_TYPES: Array<'advance' | 'installment' | 'final'> = [
  'advance',
  'installment',
  'final',
];

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  total_amount: string;
  discount_amount: string;
  paid_amount: string;
  payment_status: PaymentStatus;
}

interface PaymentDbRow {
  id: string;
  order_id: string;
  amount: string;
  payment_method: PaymentMethod;
  transaction_reference: string | null;
  payment_type: PaymentType;
  notes: string | null;
  recorded_by: string | null;
  recorded_by_name?: string | null;
  created_at: string;
}

/**
 * Record a payment for an order.
 * - Atomic PostgreSQL transaction with row-level lock on the order.
 * - Validates amounts, checks against overpayment, updates paid_amount and payment_status.
 */
export async function recordPayment(
  orderId: string,
  input: RecordPaymentInput,
  recordedByUserId: string
): Promise<{
  payment: Payment;
  order: {
    id: string;
    order_number: string;
    total_amount: number;
    discount_amount: number;
    net_payable: number;
    paid_amount: number;
    balance_due: number;
    payment_status: PaymentStatus;
  };
}> {
  if (!isValidUuid(orderId)) {
    throw new PaymentError(400, 'Invalid order ID format. Must be a valid UUID.');
  }

  const rawAmount = Number(input.amount);
  if (typeof rawAmount !== 'number' || Number.isNaN(rawAmount) || !Number.isFinite(rawAmount) || rawAmount <= 0) {
    throw new PaymentError(400, 'Payment amount must be a positive number greater than zero.');
  }
  const amount = roundCurrency(rawAmount);

  const paymentMethod = input.payment_method;
  if (!paymentMethod || !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    throw new PaymentError(
      400,
      `Invalid payment method. Allowed values: ${VALID_PAYMENT_METHODS.join(', ')}.`
    );
  }

  let paymentType = input.payment_type;
  if (paymentType && !VALID_COLLECTION_PAYMENT_TYPES.includes(paymentType)) {
    throw new PaymentError(
      400,
      `Invalid payment type for collections. Allowed values: ${VALID_COLLECTION_PAYMENT_TYPES.join(', ')}.`
    );
  }

  if (!pool) {
    throw new PaymentError(503, 'Database service is currently unavailable.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock the order row to prevent concurrent race conditions
    const orderRes = await client.query<OrderRow>(
      `SELECT id, order_number, status, total_amount, discount_amount, paid_amount, payment_status
       FROM orders
       WHERE id = $1
       FOR UPDATE;`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new PaymentError(404, 'Order not found.');
    }

    const order = orderRes.rows[0];

    // Cannot accept new collections on cancelled orders
    if (order.status === 'Cancelled') {
      throw new PaymentError(400, 'Cannot record payment for a cancelled order.');
    }

    // Calculate balances
    const totalAmount = roundCurrency(Number(order.total_amount));
    const discountAmount = roundCurrency(Number(order.discount_amount));
    const netPayable = roundCurrency(totalAmount - discountAmount);
    const currentPaid = roundCurrency(Number(order.paid_amount));
    const balanceDue = roundCurrency(Math.max(0, netPayable - currentPaid));

    if (balanceDue <= 0) {
      throw new PaymentError(400, 'Order is already fully paid. No balance is due.');
    }

    // Overpayment check
    if (amount > balanceDue) {
      throw new PaymentError(
        400,
        `Payment amount (${amount}) exceeds remaining balance (${balanceDue}). Overpayment is not permitted.`
      );
    }

    // Determine default payment type if not specified
    if (!paymentType) {
      if (currentPaid === 0) {
        paymentType = 'advance';
      } else if (amount === balanceDue) {
        paymentType = 'final';
      } else {
        paymentType = 'installment';
      }
    }

    // 2. Insert payment record
    const paymentRes = await client.query<PaymentDbRow>(
      `INSERT INTO payments (
         order_id, amount, payment_method, transaction_reference, payment_type, notes, recorded_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, order_id, amount, payment_method, transaction_reference, payment_type, notes, recorded_by, created_at;`,
      [
        orderId,
        amount,
        paymentMethod,
        input.transaction_reference?.trim() || null,
        paymentType,
        input.notes?.trim() || null,
        recordedByUserId,
      ]
    );
    const createdPayment = paymentRes.rows[0];

    // 3. Update order paid balance and status
    const newPaidAmount = roundCurrency(currentPaid + amount);
    let newPaymentStatus: PaymentStatus = 'Partial';
    if (newPaidAmount >= netPayable && netPayable > 0) {
      newPaymentStatus = 'Paid';
    }

    await client.query(
      `UPDATE orders
       SET paid_amount = $1, payment_status = $2
       WHERE id = $3;`,
      [newPaidAmount, newPaymentStatus, orderId]
    );

    await client.query('COMMIT');

    const newBalanceDue = roundCurrency(Math.max(0, netPayable - newPaidAmount));

    return {
      payment: {
        id: createdPayment.id,
        order_id: createdPayment.order_id,
        amount: Number(createdPayment.amount),
        payment_method: createdPayment.payment_method,
        transaction_reference: createdPayment.transaction_reference,
        payment_type: createdPayment.payment_type,
        notes: createdPayment.notes,
        recorded_by: createdPayment.recorded_by,
        created_at: createdPayment.created_at,
      },
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: totalAmount,
        discount_amount: discountAmount,
        net_payable: netPayable,
        paid_amount: newPaidAmount,
        balance_due: newBalanceDue,
        payment_status: newPaymentStatus,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a refund against a specific past payment.
 * - Atomic PostgreSQL transaction with row-level locks on both order and payment.
 * - Prevents refunding more than the payment's collected amount or the order's current net balance.
 * - Updates paid_amount and sets payment_status = 'Refunded' when balance returns to zero.
 */
export async function recordRefund(
  orderId: string,
  paymentId: string,
  input: RecordRefundInput,
  recordedByUserId: string
): Promise<{
  refund: Payment;
  order: {
    id: string;
    order_number: string;
    total_amount: number;
    discount_amount: number;
    net_payable: number;
    paid_amount: number;
    balance_due: number;
    payment_status: PaymentStatus;
  };
}> {
  if (!isValidUuid(orderId) || !isValidUuid(paymentId)) {
    throw new PaymentError(400, 'Invalid order or payment ID format. Must be valid UUIDs.');
  }

  if (!pool) {
    throw new PaymentError(503, 'Database service is currently unavailable.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock order row
    const orderRes = await client.query<OrderRow>(
      `SELECT id, order_number, status, total_amount, discount_amount, paid_amount, payment_status
       FROM orders
       WHERE id = $1
       FOR UPDATE;`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new PaymentError(404, 'Order not found.');
    }

    const order = orderRes.rows[0];
    const totalAmount = roundCurrency(Number(order.total_amount));
    const discountAmount = roundCurrency(Number(order.discount_amount));
    const netPayable = roundCurrency(totalAmount - discountAmount);
    const currentPaid = roundCurrency(Number(order.paid_amount));

    if (currentPaid <= 0) {
      throw new PaymentError(400, 'Order has no paid balance eligible for refund.');
    }

    // 2. Lock target payment to be refunded
    const paymentRes = await client.query<PaymentDbRow>(
      `SELECT id, order_id, amount, payment_method, payment_type, transaction_reference, created_at
       FROM payments
       WHERE id = $1 AND order_id = $2
       FOR UPDATE;`,
      [paymentId, orderId]
    );

    if (paymentRes.rows.length === 0) {
      throw new PaymentError(404, 'Payment transaction not found for this order.');
    }

    const targetPayment = paymentRes.rows[0];

    if (targetPayment.payment_type === 'refund') {
      throw new PaymentError(400, 'Cannot refund a refund transaction.');
    }

    // 3. Check how much has already been refunded against this specific payment
    const prevRefundsRes = await client.query<{ refunded: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS refunded
       FROM payments
       WHERE order_id = $1 
         AND payment_type = 'refund' 
         AND notes LIKE $2;`,
      [orderId, `%[PaymentRef:${paymentId}]%`]
    );
    const alreadyRefundedFromThis = roundCurrency(Number(prevRefundsRes.rows[0].refunded));
    const originalPaymentAmount = roundCurrency(Number(targetPayment.amount));
    const remainingRefundableOnPayment = roundCurrency(originalPaymentAmount - alreadyRefundedFromThis);

    if (remainingRefundableOnPayment <= 0) {
      throw new PaymentError(400, 'This payment transaction has already been fully refunded.');
    }

    // 4. Determine refund amount
    let refundAmount = remainingRefundableOnPayment;
    if (input.amount !== undefined) {
      const rawInputAmount = Number(input.amount);
      if (typeof rawInputAmount !== 'number' || Number.isNaN(rawInputAmount) || !Number.isFinite(rawInputAmount) || rawInputAmount <= 0) {
        throw new PaymentError(400, 'Refund amount must be a positive number greater than zero.');
      }
      refundAmount = roundCurrency(rawInputAmount);
    }

    if (refundAmount > remainingRefundableOnPayment) {
      throw new PaymentError(
        400,
        `Refund amount (${refundAmount}) exceeds refundable balance for this payment (${remainingRefundableOnPayment}).`
      );
    }

    if (refundAmount > currentPaid) {
      throw new PaymentError(
        400,
        `Refund amount (${refundAmount}) exceeds current order paid balance (${currentPaid}).`
      );
    }

    // 5. Insert refund record
    const refundMethod: PaymentMethod = input.payment_method || targetPayment.payment_method;
    if (!VALID_PAYMENT_METHODS.includes(refundMethod)) {
      throw new PaymentError(400, `Invalid refund payment method.`);
    }

    const refundReference = input.transaction_reference?.trim() || `REF-${paymentId.slice(0, 8)}`;
    const systemNotes = `[PaymentRef:${paymentId}] ${input.notes?.trim() || ''}`.trim();

    const insertRefundRes = await client.query<PaymentDbRow>(
      `INSERT INTO payments (
         order_id, amount, payment_method, transaction_reference, payment_type, notes, recorded_by
       ) VALUES ($1, $2, $3, $4, 'refund', $5, $6)
       RETURNING id, order_id, amount, payment_method, transaction_reference, payment_type, notes, recorded_by, created_at;`,
      [orderId, refundAmount, refundMethod, refundReference, systemNotes, recordedByUserId]
    );
    const createdRefund = insertRefundRes.rows[0];

    // 6. Update order balance and payment_status
    const newPaidAmount = roundCurrency(currentPaid - refundAmount);

    let newPaymentStatus: PaymentStatus = 'Partial';
    if (newPaidAmount === 0) {
      // Net collections returned to zero via refund
      newPaymentStatus = 'Refunded';
    } else if (newPaidAmount >= netPayable && netPayable > 0) {
      newPaymentStatus = 'Paid';
    } else if (newPaidAmount > 0) {
      newPaymentStatus = 'Partial';
    } else {
      newPaymentStatus = 'Unpaid';
    }

    await client.query(
      `UPDATE orders
       SET paid_amount = $1, payment_status = $2
       WHERE id = $3;`,
      [newPaidAmount, newPaymentStatus, orderId]
    );

    await client.query('COMMIT');

    const newBalanceDue = roundCurrency(Math.max(0, netPayable - newPaidAmount));

    return {
      refund: {
        id: createdRefund.id,
        order_id: createdRefund.order_id,
        amount: Number(createdRefund.amount),
        payment_method: createdRefund.payment_method,
        transaction_reference: createdRefund.transaction_reference,
        payment_type: createdRefund.payment_type,
        notes: createdRefund.notes,
        recorded_by: createdRefund.recorded_by,
        created_at: createdRefund.created_at,
      },
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: totalAmount,
        discount_amount: discountAmount,
        net_payable: netPayable,
        paid_amount: newPaidAmount,
        balance_due: newBalanceDue,
        payment_status: newPaymentStatus,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List payment history and financial balance summary for an order.
 */
export async function getOrderPayments(orderId: string): Promise<OrderPaymentSummary> {
  if (!isValidUuid(orderId)) {
    throw new PaymentError(400, 'Invalid order ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new PaymentError(503, 'Database service is currently unavailable.');
  }

  // 1. Query order financials
  const orderRes = await pool.query<OrderRow>(
    `SELECT id, order_number, status, total_amount, discount_amount, paid_amount, payment_status
     FROM orders
     WHERE id = $1;`,
    [orderId]
  );

  if (orderRes.rows.length === 0) {
    throw new PaymentError(404, 'Order not found.');
  }

  const order = orderRes.rows[0];
  const totalAmount = roundCurrency(Number(order.total_amount));
  const discountAmount = roundCurrency(Number(order.discount_amount));
  const netPayable = roundCurrency(totalAmount - discountAmount);
  const paidAmount = roundCurrency(Number(order.paid_amount));
  const balanceDue = roundCurrency(Math.max(0, netPayable - paidAmount));

  // 2. Query payment ledger with recorded_by user names
  const paymentsRes = await pool.query<PaymentDbRow>(
    `SELECT 
       p.id,
       p.order_id,
       p.amount,
       p.payment_method,
       p.transaction_reference,
       p.payment_type,
       p.notes,
       p.recorded_by,
       u.full_name AS recorded_by_name,
       p.created_at
     FROM payments p
     LEFT JOIN users u ON u.id = p.recorded_by
     WHERE p.order_id = $1
     ORDER BY p.created_at ASC;`,
    [orderId]
  );

  let grossCollected = 0;
  let totalRefunded = 0;

  const payments: Payment[] = paymentsRes.rows.map((row) => {
    const amt = Number(row.amount);
    if (row.payment_type === 'refund') {
      totalRefunded = roundCurrency(totalRefunded + amt);
    } else {
      grossCollected = roundCurrency(grossCollected + amt);
    }

    return {
      id: row.id,
      order_id: row.order_id,
      amount: amt,
      payment_method: row.payment_method,
      transaction_reference: row.transaction_reference,
      payment_type: row.payment_type,
      notes: row.notes,
      recorded_by: row.recorded_by,
      recorded_by_name: row.recorded_by_name || null,
      created_at: row.created_at,
    };
  });

  return {
    order_id: order.id,
    order_number: order.order_number,
    status: order.status,
    total_amount: totalAmount,
    discount_amount: discountAmount,
    net_payable: netPayable,
    paid_amount: paidAmount,
    balance_due: balanceDue,
    gross_collected: grossCollected,
    total_refunded: totalRefunded,
    payment_status: order.payment_status,
    payments,
  };
}
