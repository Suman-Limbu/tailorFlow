import { pool } from '../db/pool.js';
import { hashPassword, comparePassword, generateToken } from '../utils/security.js';
import type { UserRole, AuthTokenPayload } from '../types/auth.js';

export interface RegisterCustomerInput {
  full_name: string;
  email?: string;
  phone: string;
  password: string;
}

export interface LoginInput {
  identifier: string; // email or phone
  password: string;
}

export interface CreateStaffInput {
  full_name: string;
  email?: string;
  phone?: string;
  password: string;
  role: 'tailor' | 'admin';
}

export interface AuthResponse {
  user: {
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    role: UserRole;
    is_active: boolean;
    created_at?: string;
  };
  customerId?: string | null;
  token: string;
}

export class AuthError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AuthError';
  }
}

/**
 * Register a new customer account.
 * - Always assigns role = 'customer' on the server.
 * - Enforces transactional consistency across users and customers tables.
 * - Links to an existing walk-in customer profile if matching phone/email exists.
 */
export async function registerCustomer(input: RegisterCustomerInput): Promise<AuthResponse> {
  const fullName = input.full_name?.trim();
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim();
  const password = input.password;

  // Validation
  if (!fullName || fullName.length < 2) {
    throw new AuthError(400, 'Full name must be at least 2 characters long.');
  }

  if (!phone || phone.length < 6) {
    throw new AuthError(400, 'A valid phone number is required.');
  }

  if (!password || password.length < 8) {
    throw new AuthError(400, 'Password must be at least 8 characters long.');
  }

  if (email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new AuthError(400, 'Please provide a valid email address.');
    }
  }

  if (!pool) {
    throw new AuthError(503, 'Database service is currently unavailable.');
  }

  // Check for duplicate account in users
  const duplicateCheck = await pool.query<{ id: string }>(
    `SELECT id FROM users 
     WHERE (email IS NOT NULL AND LOWER(email) = LOWER($1))
        OR (phone IS NOT NULL AND phone = $2);`,
    [email, phone]
  );

  if (duplicateCheck.rows.length > 0) {
    throw new AuthError(409, 'An account with this email or phone number already exists.');
  }

  // Hash password using bcrypt
  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create user account with server-enforced role = 'customer'
    const userResult = await client.query<{
      id: string;
      full_name: string;
      email: string | null;
      phone: string | null;
      role: UserRole;
      is_active: boolean;
      created_at: string;
    }>(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, 'customer')
       RETURNING id, full_name, email, phone, role, is_active, created_at;`,
      [fullName, email, phone, passwordHash]
    );

    const newUser = userResult.rows[0];

    // 2. Check for an existing unlinked customer profile (e.g. created for a walk-in customer)
    const existingCustomerResult = await client.query<{ id: string }>(
      `SELECT id FROM customers 
       WHERE (phone = $1 OR (email IS NOT NULL AND LOWER(email) = LOWER($2)))
         AND user_id IS NULL
       ORDER BY created_at ASC
       LIMIT 1;`,
      [phone, email]
    );

    let customerId: string;

    if (existingCustomerResult.rows.length > 0) {
      // Link to existing customer profile
      customerId = existingCustomerResult.rows[0].id;
      await client.query(
        `UPDATE customers 
         SET user_id = $1, 
             email = COALESCE(email, $2)
         WHERE id = $3;`,
        [newUser.id, email, customerId]
      );
    } else {
      // Create new customer profile
      const newCustomerResult = await client.query<{ id: string }>(
        `INSERT INTO customers (user_id, full_name, phone, email)
         VALUES ($1, $2, $3, $4)
         RETURNING id;`,
        [newUser.id, fullName, phone, email]
      );
      customerId = newCustomerResult.rows[0].id;
    }

    await client.query('COMMIT');

    // Generate signed JWT token
    const tokenPayload: AuthTokenPayload = {
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
      customerId,
    };
    const token = generateToken(tokenPayload);

    return {
      user: newUser,
      customerId,
      token,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Log in with email or phone + password.
 * Employs generic error responses to prevent account enumeration.
 */
export async function login(input: LoginInput): Promise<AuthResponse> {
  const identifier = input.identifier?.trim();
  const password = input.password;

  if (!identifier || !password) {
    throw new AuthError(400, 'Please provide both your email/phone and password.');
  }

  if (!pool) {
    throw new AuthError(503, 'Database service is currently unavailable.');
  }

  // Look up user by email or phone
  const userResult = await pool.query<{
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    password_hash: string;
    role: UserRole;
    is_active: boolean;
    customer_id: string | null;
  }>(
    `SELECT u.id, u.full_name, u.email, u.phone, u.password_hash, u.role, u.is_active, c.id AS customer_id
     FROM users u
     LEFT JOIN customers c ON c.user_id = u.id
     WHERE (u.email IS NOT NULL AND LOWER(u.email) = LOWER($1))
        OR (u.phone IS NOT NULL AND u.phone = $1)
     LIMIT 1;`,
    [identifier]
  );

  if (userResult.rows.length === 0) {
    // Generic error: do not leak whether account exists
    throw new AuthError(401, 'Invalid email/phone or password.');
  }

  const dbUser = userResult.rows[0];

  // Verify password using bcrypt
  const isMatch = await comparePassword(password, dbUser.password_hash);
  if (!isMatch) {
    throw new AuthError(401, 'Invalid email/phone or password.');
  }

  // Check whether the account is active
  if (!dbUser.is_active) {
    throw new AuthError(403, 'Account is deactivated. Please contact the administrator.');
  }

  const tokenPayload: AuthTokenPayload = {
    userId: dbUser.id,
    email: dbUser.email,
    role: dbUser.role,
    customerId: dbUser.customer_id,
  };
  const token = generateToken(tokenPayload);

  return {
    user: {
      id: dbUser.id,
      full_name: dbUser.full_name,
      email: dbUser.email,
      phone: dbUser.phone,
      role: dbUser.role,
      is_active: dbUser.is_active,
    },
    customerId: dbUser.customer_id,
    token,
  };
}

/**
 * Admin-only: Create a staff account (tailor or admin).
 */
export async function createStaffAccount(input: CreateStaffInput): Promise<{
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  is_active: boolean;
}> {
  const fullName = input.full_name?.trim();
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim() || null;
  const password = input.password;
  const role = input.role;

  if (!['tailor', 'admin'].includes(role)) {
    throw new AuthError(400, 'Staff role must be tailor or admin.');
  }

  if (!fullName || fullName.length < 2) {
    throw new AuthError(400, 'Full name must be at least 2 characters.');
  }

  if (!password || password.length < 8) {
    throw new AuthError(400, 'Password must be at least 8 characters long.');
  }

  if (!email && !phone) {
    throw new AuthError(400, 'Either email or phone is required for staff accounts.');
  }

  if (!pool) {
    throw new AuthError(503, 'Database service is currently unavailable.');
  }

  // Check duplicate
  const duplicateCheck = await pool.query<{ id: string }>(
    `SELECT id FROM users 
     WHERE (email IS NOT NULL AND LOWER(email) = LOWER($1))
        OR (phone IS NOT NULL AND phone = $2);`,
    [email, phone]
  );

  if (duplicateCheck.rows.length > 0) {
    throw new AuthError(409, 'An account with this email or phone number already exists.');
  }

  const passwordHash = await hashPassword(password);

  const result = await pool.query<{
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    role: UserRole;
    is_active: boolean;
  }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, full_name, email, phone, role, is_active;`,
    [fullName, email, phone, passwordHash, role]
  );

  return result.rows[0];
}
