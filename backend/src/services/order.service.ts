import type pg from 'pg';
import { pool } from '../db/pool.js';
import { isValidUuid, isValidDateString, validateMeasurements } from '../utils/validation.js';
import type {
  OrderStatus,
  OrderPriority,
  PaymentStatus,
  CreateOrderInput,
  UpdateOrderInput,
  ChangeOrderStatusInput,
  OrderQueryOptions,
  OrderDetail,
  OrderItem,
  OrderStatusHistoryItem,
} from '../types/order.js';
import type { AuthUser } from '../types/auth.js';

export class OrderError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'OrderError';
  }
}

/**
 * Standard tailoring workflow state machine transitions.
 */
const ALLOWED_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  'Pending': ['on work', 'Cancelled'],
  'on work': ['Finishing', 'Pending', 'Cancelled'],
  'Finishing': ['Ready for Pickup', 'on work', 'Cancelled'],
  'Ready for Pickup': ['Completed', 'Finishing', 'Cancelled'],
  'Completed': [], // Terminal
  'Cancelled': [], // Terminal
};

const VALID_STATUSES: OrderStatus[] = [
  'Pending',
  'on work',
  'Finishing',
  'Ready for Pickup',
  'Completed',
  'Cancelled',
];

const VALID_PRIORITIES: OrderPriority[] = ['low', 'normal', 'high', 'urgent'];

/**
 * Decimal-safe rounding to 2 decimal places.
 */
export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Concurrency-safe unique order number generator.
 * Format: ORD-YYYYMMDD-XXXX (sequential 4-digit counter per day).
 */
async function generateOrderNumber(client: pg.PoolClient): Promise<string> {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `ORD-${dateStr}-`;

  const lastOrderRes = await client.query<{ order_number: string }>(
    `SELECT order_number 
     FROM orders 
     WHERE order_number LIKE $1 
     ORDER BY order_number DESC 
     LIMIT 1 
     FOR UPDATE;`,
    [`${prefix}%`]
  );

  let nextSequence = 1;
  if (lastOrderRes.rows.length > 0) {
    const rawNumber = lastOrderRes.rows[0].order_number.replace(prefix, '');
    const parsed = parseInt(rawNumber, 10);
    if (!Number.isNaN(parsed)) {
      nextSequence = parsed + 1;
    }
  }

  return `${prefix}${String(nextSequence).padStart(4, '0')}`;
}

/**
 * Helper to validate tailor eligibility.
 */
async function validateTailor(client: pg.PoolClient, tailorId: string): Promise<void> {
  if (!isValidUuid(tailorId)) {
    throw new OrderError(400, 'Invalid tailor user ID format. Must be a valid UUID.');
  }

  const res = await client.query<{ id: string; role: string; is_active: boolean }>(
    `SELECT id, role, is_active FROM users WHERE id = $1;`,
    [tailorId]
  );

  if (res.rows.length === 0) {
    throw new OrderError(404, 'Assigned tailor account not found.');
  }

  const user = res.rows[0];
  if (!user.is_active) {
    throw new OrderError(400, 'Assigned tailor account is deactivated.');
  }

  if (!['tailor', 'admin'].includes(user.role)) {
    throw new OrderError(400, `User with role "${user.role}" cannot be assigned as a tailor.`);
  }
}

/**
 * Create an order with items, tailor assignments, measurement snapshots, and status history.
 * Atomic multi-step PostgreSQL transaction.
 */
export async function createOrder(input: CreateOrderInput, creatorUserId: string): Promise<OrderDetail> {
  if (!pool) {
    throw new OrderError(503, 'Database service is currently unavailable.');
  }

  if (!isValidUuid(input.customer_id)) {
    throw new OrderError(400, 'Invalid customer ID format. Must be a valid UUID.');
  }

  if (!input.items || !Array.isArray(input.items) || input.items.length === 0) {
    throw new OrderError(400, 'An order must contain at least one garment item.');
  }

  const priority: OrderPriority = input.priority || 'normal';
  if (!VALID_PRIORITIES.includes(priority)) {
    throw new OrderError(400, `Invalid priority. Allowed values: ${VALID_PRIORITIES.join(', ')}.`);
  }

  let dueDate: string | null = null;
  if (input.due_date) {
    if (!isValidDateString(input.due_date)) {
      throw new OrderError(400, 'Due date must be in valid YYYY-MM-DD format.');
    }
    dueDate = input.due_date.trim();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify customer exists
    const customerRes = await client.query<{ id: string; full_name: string; phone: string; email: string | null }>(
      `SELECT id, full_name, phone, email FROM customers WHERE id = $1;`,
      [input.customer_id]
    );
    if (customerRes.rows.length === 0) {
      throw new OrderError(404, 'Customer not found.');
    }

    // 2. Validate order-level assigned tailor if provided
    if (input.assigned_tailor_id) {
      await validateTailor(client, input.assigned_tailor_id);
    }

    // 3. Process each garment item and validate measurements & item-level tailors
    let totalAmount = 0;
    const validatedItems: Array<{
      garment_type: string;
      item_name: string;
      quantity: number;
      unit_price: number;
      subtotal: number;
      assigned_tailor_id: string | null;
      fabric_details: string | null;
      special_instructions: string | null;
      snapshotData: Record<string, number> | null;
      profileSourceId: string | null;
    }> = [];

    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i];
      const garmentType = item.garment_type?.trim().toLowerCase();
      const itemName = item.item_name?.trim();
      const quantity = Math.floor(Number(item.quantity));
      const unitPrice = roundCurrency(Number(item.unit_price));

      if (!garmentType || garmentType.length < 2) {
        throw new OrderError(400, `Item #${i + 1}: Garment type is required.`);
      }

      if (!itemName || itemName.length < 2) {
        throw new OrderError(400, `Item #${i + 1}: Item name must be at least 2 characters long.`);
      }

      if (Number.isNaN(quantity) || quantity < 1) {
        throw new OrderError(400, `Item #${i + 1}: Quantity must be an integer of 1 or greater.`);
      }

      if (Number.isNaN(unitPrice) || unitPrice < 0) {
        throw new OrderError(400, `Item #${i + 1}: Unit price must be a non-negative number.`);
      }

      // Validate item-level tailor assignment if provided
      let itemTailorId: string | null = null;
      if (item.assigned_tailor_id) {
        await validateTailor(client, item.assigned_tailor_id);
        itemTailorId = item.assigned_tailor_id;
      }

      // Calculate server-side subtotal
      const subtotal = roundCurrency(quantity * unitPrice);
      totalAmount = roundCurrency(totalAmount + subtotal);

      // Handle measurements snapshot
      let snapshotData: Record<string, number> | null = null;
      let profileSourceId: string | null = null;

      if (item.measurement_profile_id) {
        if (!isValidUuid(item.measurement_profile_id)) {
          throw new OrderError(400, `Item #${i + 1}: Invalid measurement profile ID format.`);
        }

        const profileRes = await client.query<{
          id: string;
          customer_id: string;
          garment_type: string;
          measurements: Record<string, number>;
        }>(
          `SELECT id, customer_id, garment_type, measurements 
           FROM measurement_profiles 
           WHERE id = $1;`,
          [item.measurement_profile_id]
        );

        if (profileRes.rows.length === 0) {
          throw new OrderError(404, `Item #${i + 1}: Referenced measurement profile not found.`);
        }

        const profile = profileRes.rows[0];
        if (profile.customer_id !== input.customer_id) {
          throw new OrderError(
            400,
            `Item #${i + 1}: Measurement profile does not belong to the selected customer.`
          );
        }

        snapshotData = profile.measurements;
        profileSourceId = profile.id;
      } else if (item.custom_measurements) {
        const valRes = validateMeasurements(item.custom_measurements);
        if (!valRes.valid) {
          throw new OrderError(400, `Item #${i + 1}: ${valRes.error}`);
        }
        snapshotData = item.custom_measurements;
        profileSourceId = null;
      }

      validatedItems.push({
        garment_type: garmentType,
        item_name: itemName,
        quantity,
        unit_price: unitPrice,
        subtotal,
        assigned_tailor_id: itemTailorId,
        fabric_details: item.fabric_details?.trim() || null,
        special_instructions: item.special_instructions?.trim() || null,
        snapshotData,
        profileSourceId,
      });
    }

    // 4. Validate discount
    const discountAmount = roundCurrency(Number(input.discount_amount || 0));
    if (Number.isNaN(discountAmount) || discountAmount < 0) {
      throw new OrderError(400, 'Discount amount must be a non-negative number.');
    }

    if (discountAmount > totalAmount) {
      throw new OrderError(400, `Discount (${discountAmount}) cannot exceed order total (${totalAmount}).`);
    }

    // 5. Concurrency-safe unique order number
    const orderNumber = await generateOrderNumber(client);

    // 6. Insert Order
    const orderRes = await client.query<{ id: string }>(
      `INSERT INTO orders (
         order_number, customer_id, assigned_tailor_id, status, priority, due_date,
         total_amount, discount_amount, paid_amount, payment_status, notes, created_by
       ) VALUES ($1, $2, $3, 'Pending', $4, $5, $6, $7, 0.00, 'Unpaid', $8, $9)
       RETURNING id;`,
      [
        orderNumber,
        input.customer_id,
        input.assigned_tailor_id || null,
        priority,
        dueDate,
        totalAmount,
        discountAmount,
        input.notes?.trim() || null,
        creatorUserId,
      ]
    );
    const orderId = orderRes.rows[0].id;

    // 7. Insert Order Items and capture Measurement Snapshots
    for (const item of validatedItems) {
      const itemRes = await client.query<{ id: string }>(
        `INSERT INTO order_items (
           order_id, garment_type, item_name, quantity, unit_price, subtotal,
           fabric_details, special_instructions, item_status, assigned_tailor_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', $9)
         RETURNING id;`,
        [
          orderId,
          item.garment_type,
          item.item_name,
          item.quantity,
          item.unit_price,
          item.subtotal,
          item.fabric_details,
          item.special_instructions,
          item.assigned_tailor_id,
        ]
      );
      const itemId = itemRes.rows[0].id;

      if (item.snapshotData) {
        await client.query(
          `INSERT INTO order_measurement_snapshots (
             order_id, order_item_id, profile_source_id, garment_type, snapshot_data
           ) VALUES ($1, $2, $3, $4, $5);`,
          [orderId, itemId, item.profileSourceId, item.garment_type, JSON.stringify(item.snapshotData)]
        );
      }
    }

    // 8. Record initial status in status history
    await client.query(
      `INSERT INTO order_status_history (
         order_id, previous_status, new_status, changed_by, comments
       ) VALUES ($1, NULL, 'Pending', $2, 'Order created');`,
      [orderId, creatorUserId]
    );

    await client.query('COMMIT');

    // Return complete detail
    return await fetchOrderDetail(client, orderId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List orders with pagination and filtering.
 * Role-scoped: Tailors only view orders where they are assigned (at order-level or item-level).
 */
export async function getOrders(options: OrderQueryOptions, requestingUser: AuthUser) {
  if (!pool) {
    throw new OrderError(503, 'Database service is currently unavailable.');
  }

  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 10));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Tailor role authorization enforcement: can only see assigned orders
  if (requestingUser.role === 'tailor') {
    params.push(requestingUser.id);
    const pIndex = params.length;
    conditions.push(
      `(o.assigned_tailor_id = $${pIndex} OR EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.assigned_tailor_id = $${pIndex}
      ))`
    );
  } else if (options.assigned_tailor_id) {
    if (!isValidUuid(options.assigned_tailor_id)) {
      throw new OrderError(400, 'Invalid assigned_tailor_id format.');
    }
    params.push(options.assigned_tailor_id);
    const pIndex = params.length;
    conditions.push(
      `(o.assigned_tailor_id = $${pIndex} OR EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.assigned_tailor_id = $${pIndex}
      ))`
    );
  }

  if (options.status) {
    if (!VALID_STATUSES.includes(options.status)) {
      throw new OrderError(400, `Invalid status filter. Allowed values: ${VALID_STATUSES.join(', ')}.`);
    }
    params.push(options.status);
    conditions.push(`o.status = $${params.length}`);
  }

  if (options.customer_id) {
    if (!isValidUuid(options.customer_id)) {
      throw new OrderError(400, 'Invalid customer_id filter format.');
    }
    params.push(options.customer_id);
    conditions.push(`o.customer_id = $${params.length}`);
  }

  if (options.priority) {
    if (!VALID_PRIORITIES.includes(options.priority)) {
      throw new OrderError(400, `Invalid priority filter. Allowed values: ${VALID_PRIORITIES.join(', ')}.`);
    }
    params.push(options.priority);
    conditions.push(`o.priority = $${params.length}`);
  }

  if (options.due_date) {
    if (!isValidDateString(options.due_date)) {
      throw new OrderError(400, 'Invalid due_date filter format (YYYY-MM-DD).');
    }
    params.push(options.due_date);
    conditions.push(`o.due_date = $${params.length}`);
  }

  if (options.search) {
    params.push(`%${options.search.trim()}%`);
    const pIndex = params.length;
    conditions.push(
      `(o.order_number ILIKE $${pIndex} OR c.full_name ILIKE $${pIndex} OR c.phone ILIKE $${pIndex})`
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total matching
  const countQuery = `
    SELECT COUNT(DISTINCT o.id) AS total
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    ${whereClause};
  `;
  const countRes = await pool.query<{ total: string }>(countQuery, params);
  const total = parseInt(countRes.rows[0]?.total || '0', 10);

  // Paginated query
  const dataParams = [...params, limit, offset];
  const limitIndex = dataParams.length - 1;
  const offsetIndex = dataParams.length;

  const dataQuery = `
    SELECT 
      o.id,
      o.order_number,
      o.customer_id,
      c.full_name AS customer_name,
      c.phone AS customer_phone,
      o.assigned_tailor_id,
      tu.full_name AS assigned_tailor_name,
      o.status,
      o.priority,
      o.due_date,
      o.total_amount,
      o.discount_amount,
      (o.total_amount - o.discount_amount) AS net_payable,
      o.paid_amount,
      o.payment_status,
      o.created_at,
      o.updated_at,
      (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users tu ON tu.id = o.assigned_tailor_id
    ${whereClause}
    ORDER BY o.created_at DESC
    LIMIT $${limitIndex} OFFSET $${offsetIndex};
  `;

  const dataRes = await pool.query(dataQuery, dataParams);

  return {
    orders: dataRes.rows.map((row) => ({
      ...row,
      total_amount: Number(row.total_amount),
      discount_amount: Number(row.discount_amount),
      net_payable: roundCurrency(Number(row.net_payable)),
      paid_amount: Number(row.paid_amount),
      item_count: parseInt(row.item_count, 10),
    })),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

/**
 * Retrieve single order with full details (customer, items, snapshots, status history).
 */
export async function getOrderById(orderId: string, requestingUser: AuthUser): Promise<OrderDetail> {
  if (!isValidUuid(orderId)) {
    throw new OrderError(400, 'Invalid order ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new OrderError(503, 'Database service is currently unavailable.');
  }

  const client = await pool.connect();
  try {
    const detail = await fetchOrderDetail(client, orderId);

    // Tailor role authorization enforcement
    if (requestingUser.role === 'tailor') {
      const isAssignedToOrder = detail.assigned_tailor_id === requestingUser.id;
      const isAssignedToAnyItem = detail.items.some((i) => i.assigned_tailor_id === requestingUser.id);
      if (!isAssignedToOrder && !isAssignedToAnyItem) {
        throw new OrderError(403, 'Access denied: you can only view orders assigned to you.');
      }
    }

    return detail;
  } finally {
    client.release();
  }
}

/**
 * Update permitted order metadata (priority, due_date, discount, notes, order-level tailor).
 */
export async function updateOrder(
  orderId: string,
  input: UpdateOrderInput,
  requestingUser: AuthUser
): Promise<OrderDetail> {
  if (!isValidUuid(orderId)) {
    throw new OrderError(400, 'Invalid order ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new OrderError(503, 'Database service is currently unavailable.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock order
    const orderRes = await client.query<{
      id: string;
      status: OrderStatus;
      total_amount: string;
      discount_amount: string;
      paid_amount: string;
      payment_status: PaymentStatus;
      assigned_tailor_id: string | null;
      priority: OrderPriority;
      due_date: string | null;
      notes: string | null;
    }>(
      `SELECT id, status, total_amount, discount_amount, paid_amount, payment_status,
              assigned_tailor_id, priority, due_date, notes
       FROM orders 
       WHERE id = $1 
       FOR UPDATE;`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new OrderError(404, 'Order not found.');
    }

    const order = orderRes.rows[0];

    // Tailors cannot modify general order financial settings
    if (requestingUser.role === 'tailor') {
      throw new OrderError(403, 'Only administrators can edit order terms.');
    }

    if (['Completed', 'Cancelled'].includes(order.status)) {
      throw new OrderError(400, `Cannot update order in "${order.status}" status.`);
    }

    let assignedTailorId = order.assigned_tailor_id;
    if (input.assigned_tailor_id !== undefined) {
      if (input.assigned_tailor_id) {
        await validateTailor(client, input.assigned_tailor_id);
        assignedTailorId = input.assigned_tailor_id;
      } else {
        assignedTailorId = null;
      }
    }

    let priority = order.priority;
    if (input.priority !== undefined) {
      if (!VALID_PRIORITIES.includes(input.priority)) {
        throw new OrderError(400, `Invalid priority. Allowed values: ${VALID_PRIORITIES.join(', ')}.`);
      }
      priority = input.priority;
    }

    let dueDate = order.due_date;
    if (input.due_date !== undefined) {
      if (input.due_date) {
        if (!isValidDateString(input.due_date)) {
          throw new OrderError(400, 'Due date must be in valid YYYY-MM-DD format.');
        }
        dueDate = input.due_date.trim();
      } else {
        dueDate = null;
      }
    }

    const notes = input.notes !== undefined ? (input.notes ? input.notes.trim() : null) : order.notes;

    // Financial consistency: Discount adjustment
    const totalAmount = Number(order.total_amount);
    let discountAmount = Number(order.discount_amount);
    const paidAmount = Number(order.paid_amount);
    let paymentStatus = order.payment_status;

    if (input.discount_amount !== undefined) {
      discountAmount = roundCurrency(Number(input.discount_amount));
      if (Number.isNaN(discountAmount) || discountAmount < 0) {
        throw new OrderError(400, 'Discount amount must be a non-negative number.');
      }
      if (discountAmount > totalAmount) {
        throw new OrderError(400, `Discount (${discountAmount}) cannot exceed order total (${totalAmount}).`);
      }

      const netPayable = roundCurrency(totalAmount - discountAmount);

      // Prevent reducing net payable below already paid amounts
      if (paidAmount > 0 && netPayable < paidAmount) {
        throw new OrderError(
          400,
          `Cannot increase discount: Net payable (${netPayable}) would be less than already collected payment (${paidAmount}).`
        );
      }

      // Recalculate payment status
      if (paidAmount >= netPayable && netPayable > 0) {
        paymentStatus = 'Paid';
      } else if (paidAmount > 0) {
        paymentStatus = 'Partial';
      } else {
        paymentStatus = 'Unpaid';
      }
    }

    await client.query(
      `UPDATE orders
       SET assigned_tailor_id = $1,
           priority = $2,
           due_date = $3,
           discount_amount = $4,
           payment_status = $5,
           notes = $6
       WHERE id = $7;`,
      [assignedTailorId, priority, dueDate, discountAmount, paymentStatus, notes, orderId]
    );

    await client.query('COMMIT');
    return await fetchOrderDetail(client, orderId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Change order status according to permitted state machine transitions.
 * Records transition in order_status_history and updates item statuses.
 */
export async function changeOrderStatus(
  orderId: string,
  input: ChangeOrderStatusInput,
  requestingUser: AuthUser
): Promise<OrderDetail> {
  if (!isValidUuid(orderId)) {
    throw new OrderError(400, 'Invalid order ID format. Must be a valid UUID.');
  }

  const newStatus = input.status;
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new OrderError(400, `Invalid order status. Allowed: ${VALID_STATUSES.join(', ')}.`);
  }

  if (!pool) {
    throw new OrderError(503, 'Database service is currently unavailable.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock order
    const orderRes = await client.query<{
      id: string;
      status: OrderStatus;
      assigned_tailor_id: string | null;
    }>(
      `SELECT id, status, assigned_tailor_id 
       FROM orders 
       WHERE id = $1 
       FOR UPDATE;`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new OrderError(404, 'Order not found.');
    }

    const currentOrder = orderRes.rows[0];
    const previousStatus = currentOrder.status;

    // Tailor authorization check
    if (requestingUser.role === 'tailor') {
      const isAssigned =
        currentOrder.assigned_tailor_id === requestingUser.id ||
        (
          await client.query(
            `SELECT 1 FROM order_items WHERE order_id = $1 AND assigned_tailor_id = $2;`,
            [orderId, requestingUser.id]
          )
        ).rows.length > 0;

      if (!isAssigned) {
        throw new OrderError(403, 'Access denied: you can only update status for orders assigned to you.');
      }
    }

    if (previousStatus === newStatus) {
      await client.query('ROLLBACK');
      return await fetchOrderDetail(client, orderId);
    }

    // Enforce state transition rules
    const allowed = ALLOWED_STATUS_TRANSITIONS[previousStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new OrderError(
        400,
        `Invalid status transition from "${previousStatus}" to "${newStatus}". Allowed transitions: ${allowed.join(', ') || 'None (Terminal state)'}.`
      );
    }

    // 1. Update order status
    await client.query(`UPDATE orders SET status = $1 WHERE id = $2;`, [newStatus, orderId]);

    // 2. Synchronize item statuses
    await client.query(`UPDATE order_items SET item_status = $1 WHERE order_id = $2;`, [newStatus, orderId]);

    // 3. Record in order_status_history
    await client.query(
      `INSERT INTO order_status_history (
         order_id, previous_status, new_status, changed_by, comments
       ) VALUES ($1, $2, $3, $4, $5);`,
      [orderId, previousStatus, newStatus, requestingUser.id, input.comments?.trim() || null]
    );

    await client.query('COMMIT');
    return await fetchOrderDetail(client, orderId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Assign or reassign tailor to a specific order item.
 */
export async function assignItemTailor(
  orderId: string,
  itemId: string,
  tailorId: string | null
): Promise<OrderItem> {
  if (!isValidUuid(orderId) || !isValidUuid(itemId)) {
    throw new OrderError(400, 'Invalid order or item UUID format.');
  }

  if (!pool) {
    throw new OrderError(503, 'Database service is currently unavailable.');
  }

  const client = await pool.connect();
  try {
    if (tailorId) {
      await validateTailor(client, tailorId);
    }

    const itemRes = await client.query<{ id: string }>(
      `SELECT id FROM order_items WHERE id = $1 AND order_id = $2;`,
      [itemId, orderId]
    );

    if (itemRes.rows.length === 0) {
      throw new OrderError(404, 'Order item not found in this order.');
    }

    const updateRes = await client.query(
      `UPDATE order_items 
       SET assigned_tailor_id = $1 
       WHERE id = $2 AND order_id = $3
       RETURNING *;`,
      [tailorId, itemId, orderId]
    );

    return updateRes.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Private helper to query and assemble complete OrderDetail.
 */
async function fetchOrderDetail(client: pg.PoolClient | pg.Pool, orderId: string): Promise<OrderDetail> {
  const orderRes = await client.query(
    `SELECT 
       o.id,
       o.order_number,
       o.customer_id,
       c.full_name AS customer_name,
       c.phone AS customer_phone,
       c.email AS customer_email,
       o.assigned_tailor_id,
       tu.full_name AS assigned_tailor_name,
       o.status,
       o.priority,
       o.due_date,
       o.total_amount,
       o.discount_amount,
       (o.total_amount - o.discount_amount) AS net_payable,
       o.paid_amount,
       o.payment_status,
       o.notes,
       o.created_by,
       cu.full_name AS created_by_name,
       o.created_at,
       o.updated_at
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users tu ON tu.id = o.assigned_tailor_id
     LEFT JOIN users cu ON cu.id = o.created_by
     WHERE o.id = $1;`,
    [orderId]
  );

  if (orderRes.rows.length === 0) {
    throw new OrderError(404, 'Order not found.');
  }

  const orderRow = orderRes.rows[0];

  // Query items with snapshots and tailor names
  const itemsRes = await client.query(
    `SELECT 
       oi.id,
       oi.order_id,
       oi.garment_type,
       oi.item_name,
       oi.quantity,
       oi.unit_price,
       oi.subtotal,
       oi.fabric_details,
       oi.special_instructions,
       oi.item_status,
       oi.assigned_tailor_id,
       tu.full_name AS assigned_tailor_name,
       oi.created_at,
       oi.updated_at,
       s.id AS snapshot_id,
       s.profile_source_id,
       s.snapshot_data,
       s.captured_at
     FROM order_items oi
     LEFT JOIN users tu ON tu.id = oi.assigned_tailor_id
     LEFT JOIN order_measurement_snapshots s ON s.order_item_id = oi.id
     WHERE oi.order_id = $1
     ORDER BY oi.created_at ASC;`,
    [orderId]
  );

  const items: OrderItem[] = itemsRes.rows.map((row) => ({
    id: row.id,
    order_id: row.order_id,
    garment_type: row.garment_type,
    item_name: row.item_name,
    quantity: row.quantity,
    unit_price: Number(row.unit_price),
    subtotal: Number(row.subtotal),
    fabric_details: row.fabric_details,
    special_instructions: row.special_instructions,
    item_status: row.item_status,
    assigned_tailor_id: row.assigned_tailor_id,
    assigned_tailor_name: row.assigned_tailor_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    snapshot: row.snapshot_id
      ? {
          id: row.snapshot_id,
          profile_source_id: row.profile_source_id,
          garment_type: row.garment_type,
          snapshot_data: row.snapshot_data,
          captured_at: row.captured_at,
        }
      : null,
  }));

  // Query status history
  const historyRes = await client.query(
    `SELECT 
       h.id,
       h.order_id,
       h.previous_status,
       h.new_status,
       h.changed_by,
       u.full_name AS changed_by_name,
       h.comments,
       h.created_at
     FROM order_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.order_id = $1
     ORDER BY h.created_at ASC;`,
    [orderId]
  );

  const status_history: OrderStatusHistoryItem[] = historyRes.rows;

  return {
    id: orderRow.id,
    order_number: orderRow.order_number,
    customer_id: orderRow.customer_id,
    customer: {
      id: orderRow.customer_id,
      full_name: orderRow.customer_name,
      phone: orderRow.customer_phone,
      email: orderRow.customer_email,
    },
    assigned_tailor_id: orderRow.assigned_tailor_id,
    assigned_tailor_name: orderRow.assigned_tailor_name,
    status: orderRow.status,
    priority: orderRow.priority,
    due_date: orderRow.due_date,
    total_amount: Number(orderRow.total_amount),
    discount_amount: Number(orderRow.discount_amount),
    net_payable: roundCurrency(Number(orderRow.net_payable)),
    paid_amount: Number(orderRow.paid_amount),
    payment_status: orderRow.payment_status,
    notes: orderRow.notes,
    created_by: orderRow.created_by,
    created_by_name: orderRow.created_by_name,
    created_at: orderRow.created_at,
    updated_at: orderRow.updated_at,
    items,
    status_history,
  };
}
