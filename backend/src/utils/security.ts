import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { AuthTokenPayload } from '../types/auth.js';

const SALT_ROUNDS = 12;

/**
 * Hash a plain-text password using bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plain-text password against a bcrypt hash.
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a signed JWT token.
 */
export function generateToken(payload: AuthTokenPayload, expiresIn: string = env.JWT_EXPIRES_IN): string {
  // cast as object for jsonwebtoken typing
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Verify a JWT token and extract the payload.
 * Throws JsonWebTokenError or TokenExpiredError if invalid.
 */
export function verifyToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  return decoded as AuthTokenPayload;
}
