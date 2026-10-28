export type GenderType = 'male' | 'female' | 'other';

export interface Customer {
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

export interface CreateCustomerInput {
  full_name: string;
  phone: string;
  email?: string | null;
  gender?: GenderType | null;
  address?: string | null;
  notes?: string | null;
}

export interface UpdateCustomerInput {
  full_name?: string;
  phone?: string;
  email?: string | null;
  gender?: GenderType | null;
  address?: string | null;
  notes?: string | null;
}

export interface CustomerQueryOptions {
  page?: number;
  limit?: number;
  search?: string;
  gender?: GenderType;
}

export interface PaginatedCustomers {
  customers: Customer[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}
