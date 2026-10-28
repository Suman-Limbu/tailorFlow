import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyToken } from '../utils/security.js';
import { pool } from '../db/pool.js';
import type { AuthUser, UserRole } from '../types/auth.js';

interface UserDbRow {
  id: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  full_name: string;
  is_active: boolean;
  customer_id: string | null;
}

/**
 * Authentication Middleware:
 * Validates JWT token, confirms user identity against the database, and checks active status.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      status: 'error',
      message: 'Authentication token required',
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    res.status(401).json({
      status: 'error',
      message: 'Authentication token missing',
    });
    return;
  }

  try {
    const payload = verifyToken(token);

    if (!pool) {
      res.status(503).json({
        status: 'error',
        message: 'Database connection unavailable',
      });
      return;
    }

    // Query active user state and linked customer record using parameterized query
    const result = await pool.query<UserDbRow>(
      `SELECT u.id, u.email, u.phone, u.role, u.full_name, u.is_active, c.id AS customer_id
       FROM users u
       LEFT JOIN customers c ON c.user_id = u.id
       WHERE u.id = $1;`,
      [payload.userId]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        status: 'error',
        message: 'User account not found or removed',
      });
      return;
    }

    const dbUser = result.rows[0];

    // Check account status
    if (!dbUser.is_active) {
      res.status(403).json({
        status: 'error',
        message: 'Account is deactivated. Please contact the administrator.',
      });
      return;
    }

    const authUser: AuthUser = {
      id: dbUser.id,
      email: dbUser.email,
      phone: dbUser.phone,
      role: dbUser.role,
      full_name: dbUser.full_name,
      is_active: dbUser.is_active,
      customerId: dbUser.customer_id,
    };

    req.user = authUser;
    next();
  } catch (err: unknown) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        status: 'error',
        message: 'Token has expired. Please log in again.',
      });
      return;
    }

    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        status: 'error',
        message: 'Invalid authentication token',
      });
      return;
    }

    console.error('[auth middleware error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Internal authentication error',
    });
  }
}

/**
 * Authorization Middleware:
 * Reusable role checker enforcing backend-level role permissions.
 * Example: requireRole('admin') or requireRole('admin', 'tailor')
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        status: 'error',
        message: 'Authentication required',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        status: 'error',
        message: 'Access denied: insufficient permissions',
      });
      return;
    }

    next();
  };
}
