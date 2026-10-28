import { pool } from '../db/pool.js';
import { isValidUuid, isValidEmail } from '../utils/validation.js';
import type {
  Customer,
  CreateCustomerInput,
  UpdateCustomerInput,
  CustomerQueryOptions,
  PaginatedCustomers,
  GenderType,
} from '../types/customer.js';

export class CustomerError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'CustomerError';
  }
}

interface CustomerDbRow {
  id: string;
  user_id: string | null;
  full_name: string;
  phone: string;
  email: string | null;
  gender: GenderType | null;
  address: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  has_account?: boolean;
  account_is_active?: boolean | null;
}

/**
 * Create a new walk-in customer profile.
 * - Walk-in customers have user_id = NULL (no login account created).
 * - Checks for duplicate phone or email.
 */
export async function createCustomer(input: CreateCustomerInput): Promise<Customer> {
  const fullName = input.full_name?.trim();
  const phone = input.phone?.trim();
  const email = input.email ? input.email.trim().toLowerCase() : null;
  const gender = input.gender || null;
  const address = input.address?.trim() || null;
  const notes = input.notes?.trim() || null;

  if (!fullName || fullName.length < 2) {
    throw new CustomerError(400, 'Customer full name must be at least 2 characters long.');
  }

  if (!phone || phone.length < 6) {
    throw new CustomerError(400, 'A valid customer phone number is required (min 6 characters).');
  }

  if (email && !isValidEmail(email)) {
    throw new CustomerError(400, 'Please provide a valid email address.');
  }

  if (gender && !['male', 'female', 'other'].includes(gender)) {
    throw new CustomerError(400, 'Gender must be male, female, or other.');
  }

  if (!pool) {
    throw new CustomerError(503, 'Database service is currently unavailable.');
  }

  // Check for duplicate phone or email in customers table
  const duplicateCheck = await pool.query<{ id: string; phone: string; email: string | null }>(
    `SELECT id, phone, email FROM customers
     WHERE phone = $1 OR ($2::varchar IS NOT NULL AND email IS NOT NULL AND LOWER(email) = LOWER($2))
     LIMIT 1;`,
    [phone, email]
  );

  if (duplicateCheck.rows.length > 0) {
    const existing = duplicateCheck.rows[0];
    if (existing.phone === phone) {
      throw new CustomerError(409, 'A customer with this phone number already exists.');
    }
    if (email && existing.email && existing.email.toLowerCase() === email) {
      throw new CustomerError(409, 'A customer with this email address already exists.');
    }
  }

  const result = await pool.query<CustomerDbRow>(
    `INSERT INTO customers (full_name, phone, email, gender, address, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, full_name, phone, email, gender, address, notes, created_at, updated_at;`,
    [fullName, phone, email, gender, address, notes]
  );

  const row = result.rows[0];
  return {
    ...row,
    has_account: false,
    account_is_active: null,
  };
}

/**
 * List customers with pagination and optional multi-field search.
 */
export async function getCustomers(options: CustomerQueryOptions): Promise<PaginatedCustomers> {
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 10));
  const offset = (page - 1) * limit;
  const search = options.search?.trim();
  const gender = options.gender;

  if (!pool) {
    throw new CustomerError(503, 'Database service is currently unavailable.');
  }

  // Construct parameterized filter conditions
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    params.push(`%${search}%`);
    const pIndex = params.length;
    conditions.push(`(c.full_name ILIKE $${pIndex} OR c.phone ILIKE $${pIndex} OR c.email ILIKE $${pIndex})`);
  }

  if (gender && ['male', 'female', 'other'].includes(gender)) {
    params.push(gender);
    conditions.push(`c.gender = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total matching count
  const countQuery = `SELECT COUNT(*) AS total FROM customers c ${whereClause};`;
  const countResult = await pool.query<{ total: string }>(countQuery, params);
  const total = parseInt(countResult.rows[0]?.total || '0', 10);

  // Get paginated rows
  const dataParams = [...params, limit, offset];
  const limitIndex = dataParams.length - 1;
  const offsetIndex = dataParams.length;

  const dataQuery = `
    SELECT 
      c.id, c.user_id, c.full_name, c.phone, c.email, c.gender, c.address, c.notes, c.created_at, c.updated_at,
      CASE WHEN u.id IS NOT NULL THEN TRUE ELSE FALSE END AS has_account,
      u.is_active AS account_is_active
    FROM customers c
    LEFT JOIN users u ON u.id = c.user_id
    ${whereClause}
    ORDER BY c.created_at DESC
    LIMIT $${limitIndex} OFFSET $${offsetIndex};
  `;

  const dataResult = await pool.query<CustomerDbRow>(dataQuery, dataParams);

  return {
    customers: dataResult.rows,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

/**
 * Retrieve a single customer by UUID.
 */
export async function getCustomerById(id: string): Promise<Customer> {
  if (!isValidUuid(id)) {
    throw new CustomerError(400, 'Invalid customer ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new CustomerError(503, 'Database service is currently unavailable.');
  }

  const result = await pool.query<CustomerDbRow>(
    `SELECT 
       c.id, c.user_id, c.full_name, c.phone, c.email, c.gender, c.address, c.notes, c.created_at, c.updated_at,
       CASE WHEN u.id IS NOT NULL THEN TRUE ELSE FALSE END AS has_account,
       u.is_active AS account_is_active
     FROM customers c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.id = $1;`,
    [id]
  );

  if (result.rows.length === 0) {
    throw new CustomerError(404, 'Customer not found.');
  }

  return result.rows[0];
}

/**
 * Update an existing customer profile.
 * - Prevents ordinary staff operations from changing or forging user_id.
 * - Handles duplicate phone or email conflicts with other customer records.
 */
export async function updateCustomer(id: string, input: UpdateCustomerInput): Promise<Customer> {
  if (!isValidUuid(id)) {
    throw new CustomerError(400, 'Invalid customer ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new CustomerError(503, 'Database service is currently unavailable.');
  }

  // 1. Verify existence
  const existingResult = await pool.query<CustomerDbRow>(
    `SELECT id, user_id, full_name, phone, email, gender, address, notes
     FROM customers WHERE id = $1;`,
    [id]
  );

  if (existingResult.rows.length === 0) {
    throw new CustomerError(404, 'Customer not found.');
  }

  const existing = existingResult.rows[0];

  // 2. Validate update fields
  const fullName = input.full_name !== undefined ? input.full_name.trim() : existing.full_name;
  if (!fullName || fullName.length < 2) {
    throw new CustomerError(400, 'Customer full name must be at least 2 characters long.');
  }

  const phone = input.phone !== undefined ? input.phone.trim() : existing.phone;
  if (!phone || phone.length < 6) {
    throw new CustomerError(400, 'Customer phone number must be at least 6 characters long.');
  }

  let email: string | null = existing.email;
  if (input.email !== undefined) {
    email = input.email ? input.email.trim().toLowerCase() : null;
    if (email && !isValidEmail(email)) {
      throw new CustomerError(400, 'Please provide a valid email address.');
    }
  }

  let gender: GenderType | null = existing.gender;
  if (input.gender !== undefined) {
    gender = input.gender || null;
    if (gender && !['male', 'female', 'other'].includes(gender)) {
      throw new CustomerError(400, 'Gender must be male, female, or other.');
    }
  }

  const address = input.address !== undefined ? (input.address ? input.address.trim() : null) : existing.address;
  const notes = input.notes !== undefined ? (input.notes ? input.notes.trim() : null) : existing.notes;

  // 3. Check duplicate phone or email on OTHER customers
  const conflictCheck = await pool.query<{ id: string; phone: string; email: string | null }>(
    `SELECT id, phone, email FROM customers
     WHERE id != $1 AND (
       phone = $2 OR 
       ($3::varchar IS NOT NULL AND email IS NOT NULL AND LOWER(email) = LOWER($3))
     )
     LIMIT 1;`,
    [id, phone, email]
  );

  if (conflictCheck.rows.length > 0) {
    const conflict = conflictCheck.rows[0];
    if (conflict.phone === phone) {
      throw new CustomerError(409, 'Another customer with this phone number already exists.');
    }
    if (email && conflict.email && conflict.email.toLowerCase() === email) {
      throw new CustomerError(409, 'Another customer with this email address already exists.');
    }
  }

  // 4. Update customer record (strictly preserving user_id)
  const updateResult = await pool.query<CustomerDbRow>(
    `UPDATE customers
     SET full_name = $1,
         phone = $2,
         email = $3,
         gender = $4,
         address = $5,
         notes = $6
     WHERE id = $7
     RETURNING id, user_id, full_name, phone, email, gender, address, notes, created_at, updated_at;`,
    [fullName, phone, email, gender, address, notes, id]
  );

  const updated = updateResult.rows[0];

  // Retrieve user account presence for complete response
  const userCheck = await pool.query<{ is_active: boolean }>(
    `SELECT is_active FROM users WHERE id = $1;`,
    [updated.user_id]
  );

  return {
    ...updated,
    has_account: Boolean(updated.user_id),
    account_is_active: userCheck.rows[0]?.is_active ?? null,
  };
}
