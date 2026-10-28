const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidUuid(id: string): boolean {
  if (typeof id !== 'string') return false;
  return UUID_REGEX.test(id.trim());
}

export function isValidEmail(email: string): boolean {
  if (typeof email !== 'string') return false;
  return EMAIL_REGEX.test(email.trim());
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates that measurements is a non-empty object with positive, realistic numeric values.
 * Rejects silent conversions, strings, negative numbers, zero, NaN, and excessive numbers (> 300).
 */
export function validateMeasurements(measurements: unknown): ValidationResult {
  if (!measurements || typeof measurements !== 'object' || Array.isArray(measurements)) {
    return {
      valid: false,
      error: 'Measurements must be an object containing garment measurement fields.',
    };
  }

  const entries = Object.entries(measurements as Record<string, unknown>);
  if (entries.length === 0) {
    return {
      valid: false,
      error: 'Measurements object must contain at least one measurement dimension.',
    };
  }

  for (const [key, value] of entries) {
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      return {
        valid: false,
        error: 'Measurement dimension names must be non-empty strings.',
      };
    }

    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
      return {
        valid: false,
        error: `Measurement value for "${key}" must be a valid number. Strings and nulls are not allowed.`,
      };
    }

    if (value <= 0) {
      return {
        valid: false,
        error: `Measurement value for "${key}" must be greater than zero.`,
      };
    }

    if (value > 300) {
      return {
        valid: false,
        error: `Measurement value for "${key}" (${value}) exceeds reasonable range (maximum 300).`,
      };
    }
  }

  return { valid: true };
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(dateStr: string): boolean {
  if (typeof dateStr !== 'string') return false;
  if (!DATE_REGEX.test(dateStr.trim())) return false;
  const parsed = new Date(dateStr.trim());
  return !Number.isNaN(parsed.getTime());
}
