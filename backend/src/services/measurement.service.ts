import { pool } from '../db/pool.js';
import { isValidUuid, validateMeasurements } from '../utils/validation.js';
import type {
  MeasurementProfile,
  CreateMeasurementProfileInput,
  UpdateMeasurementProfileInput,
} from '../types/measurement.js';

export class MeasurementError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'MeasurementError';
  }
}

interface MeasurementProfileDbRow {
  id: string;
  customer_id: string;
  title: string;
  garment_type: string;
  measurements: Record<string, number>;
  notes: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Helper to verify that customer exists.
 */
async function ensureCustomerExists(customerId: string): Promise<void> {
  if (!isValidUuid(customerId)) {
    throw new MeasurementError(400, 'Invalid customer ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new MeasurementError(503, 'Database service is currently unavailable.');
  }

  const res = await pool.query<{ id: string }>('SELECT id FROM customers WHERE id = $1;', [customerId]);
  if (res.rows.length === 0) {
    throw new MeasurementError(404, 'Customer not found.');
  }
}

/**
 * Create a measurement profile for a customer.
 */
export async function createMeasurementProfile(
  customerId: string,
  input: CreateMeasurementProfileInput
): Promise<MeasurementProfile> {
  await ensureCustomerExists(customerId);

  const title = input.title?.trim();
  const garmentType = input.garment_type?.trim().toLowerCase();
  const notes = input.notes !== undefined ? (input.notes ? input.notes.trim() : null) : null;
  const isDefault = Boolean(input.is_default);

  if (!title || title.length < 2) {
    throw new MeasurementError(400, 'Profile title must be at least 2 characters long.');
  }

  if (!garmentType || garmentType.length < 2) {
    throw new MeasurementError(400, 'Garment type is required (e.g. shirt, trouser, suit).');
  }

  const validation = validateMeasurements(input.measurements);
  if (!validation.valid) {
    throw new MeasurementError(400, validation.error || 'Invalid measurements.');
  }

  if (!pool) {
    throw new MeasurementError(503, 'Database service is currently unavailable.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // If marked as default, unset previous default for this customer and garment_type
    if (isDefault) {
      await client.query(
        `UPDATE measurement_profiles 
         SET is_default = FALSE 
         WHERE customer_id = $1 AND garment_type = $2 AND is_default = TRUE;`,
        [customerId, garmentType]
      );
    }

    const insertResult = await client.query<MeasurementProfileDbRow>(
      `INSERT INTO measurement_profiles (customer_id, title, garment_type, measurements, notes, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, customer_id, title, garment_type, measurements, notes, is_default, created_at, updated_at;`,
      [customerId, title, garmentType, JSON.stringify(input.measurements), notes, isDefault]
    );

    await client.query('COMMIT');
    return insertResult.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List all measurement profiles for a given customer.
 */
export async function getProfilesByCustomer(
  customerId: string,
  garmentType?: string
): Promise<MeasurementProfile[]> {
  await ensureCustomerExists(customerId);

  if (!pool) {
    throw new MeasurementError(503, 'Database service is currently unavailable.');
  }

  const cleanGarmentType = garmentType?.trim().toLowerCase();
  let queryText = `
    SELECT id, customer_id, title, garment_type, measurements, notes, is_default, created_at, updated_at
    FROM measurement_profiles
    WHERE customer_id = $1
  `;
  const params: unknown[] = [customerId];

  if (cleanGarmentType) {
    params.push(cleanGarmentType);
    queryText += ` AND garment_type = $2`;
  }

  queryText += ` ORDER BY is_default DESC, created_at DESC;`;

  const result = await pool.query<MeasurementProfileDbRow>(queryText, params);
  return result.rows;
}

/**
 * Retrieve a single measurement profile by ID, scoped to customer.
 */
export async function getProfileById(customerId: string, profileId: string): Promise<MeasurementProfile> {
  await ensureCustomerExists(customerId);

  if (!isValidUuid(profileId)) {
    throw new MeasurementError(400, 'Invalid measurement profile ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new MeasurementError(503, 'Database service is currently unavailable.');
  }

  const result = await pool.query<MeasurementProfileDbRow>(
    `SELECT id, customer_id, title, garment_type, measurements, notes, is_default, created_at, updated_at
     FROM measurement_profiles
     WHERE id = $1 AND customer_id = $2;`,
    [profileId, customerId]
  );

  if (result.rows.length === 0) {
    throw new MeasurementError(404, 'Measurement profile not found for this customer.');
  }

  return result.rows[0];
}

/**
 * Update an existing measurement profile.
 */
export async function updateMeasurementProfile(
  customerId: string,
  profileId: string,
  input: UpdateMeasurementProfileInput
): Promise<MeasurementProfile> {
  await ensureCustomerExists(customerId);

  if (!isValidUuid(profileId)) {
    throw new MeasurementError(400, 'Invalid measurement profile ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new MeasurementError(503, 'Database service is currently unavailable.');
  }

  // Check profile existence for this customer
  const existingRes = await pool.query<MeasurementProfileDbRow>(
    `SELECT id, customer_id, title, garment_type, measurements, notes, is_default
     FROM measurement_profiles
     WHERE id = $1 AND customer_id = $2;`,
    [profileId, customerId]
  );

  if (existingRes.rows.length === 0) {
    throw new MeasurementError(404, 'Measurement profile not found for this customer.');
  }

  const existing = existingRes.rows[0];

  const title = input.title !== undefined ? input.title.trim() : existing.title;
  if (!title || title.length < 2) {
    throw new MeasurementError(400, 'Profile title must be at least 2 characters long.');
  }

  const garmentType = input.garment_type !== undefined ? input.garment_type.trim().toLowerCase() : existing.garment_type;
  if (!garmentType || garmentType.length < 2) {
    throw new MeasurementError(400, 'Garment type cannot be empty.');
  }

  let measurements = existing.measurements;
  if (input.measurements !== undefined) {
    const validation = validateMeasurements(input.measurements);
    if (!validation.valid) {
      throw new MeasurementError(400, validation.error || 'Invalid measurements.');
    }
    measurements = input.measurements;
  }

  const notes = input.notes !== undefined ? (input.notes ? input.notes.trim() : null) : existing.notes;
  const isDefault = input.is_default !== undefined ? Boolean(input.is_default) : existing.is_default;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // If changing to default or updating garment_type of a default profile
    if (isDefault) {
      await client.query(
        `UPDATE measurement_profiles 
         SET is_default = FALSE 
         WHERE customer_id = $1 AND garment_type = $2 AND id != $3 AND is_default = TRUE;`,
        [customerId, garmentType, profileId]
      );
    }

    const updateRes = await client.query<MeasurementProfileDbRow>(
      `UPDATE measurement_profiles
       SET title = $1,
           garment_type = $2,
           measurements = $3,
           notes = $4,
           is_default = $5
       WHERE id = $6 AND customer_id = $7
       RETURNING id, customer_id, title, garment_type, measurements, notes, is_default, created_at, updated_at;`,
      [title, garmentType, JSON.stringify(measurements), notes, isDefault, profileId, customerId]
    );

    await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Set a measurement profile as the customer's default profile for its garment type.
 * Executes atomically in a transaction.
 */
export async function setDefaultProfile(customerId: string, profileId: string): Promise<MeasurementProfile> {
  await ensureCustomerExists(customerId);

  if (!isValidUuid(profileId)) {
    throw new MeasurementError(400, 'Invalid measurement profile ID format. Must be a valid UUID.');
  }

  if (!pool) {
    throw new MeasurementError(503, 'Database service is currently unavailable.');
  }

  // Look up profile
  const profileRes = await pool.query<{ id: string; garment_type: string }>(
    `SELECT id, garment_type 
     FROM measurement_profiles 
     WHERE id = $1 AND customer_id = $2;`,
    [profileId, customerId]
  );

  if (profileRes.rows.length === 0) {
    throw new MeasurementError(404, 'Measurement profile not found for this customer.');
  }

  const garmentType = profileRes.rows[0].garment_type;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Unset existing default for this customer & garment_type
    await client.query(
      `UPDATE measurement_profiles 
       SET is_default = FALSE 
       WHERE customer_id = $1 AND garment_type = $2 AND is_default = TRUE;`,
      [customerId, garmentType]
    );

    // 2. Set this profile as default
    const updateRes = await client.query<MeasurementProfileDbRow>(
      `UPDATE measurement_profiles 
       SET is_default = TRUE 
       WHERE id = $1 AND customer_id = $2
       RETURNING id, customer_id, title, garment_type, measurements, notes, is_default, created_at, updated_at;`,
      [profileId, customerId]
    );

    await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
