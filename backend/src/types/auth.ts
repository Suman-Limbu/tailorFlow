export type UserRole = 'admin' | 'tailor' | 'customer';

export interface AuthTokenPayload {
  userId: string;
  email: string | null;
  role: UserRole;
  customerId?: string | null;
}

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  full_name: string;
  is_active: boolean;
  customerId?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
