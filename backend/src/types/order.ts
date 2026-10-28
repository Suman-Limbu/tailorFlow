export type OrderStatus =
  | 'Pending'
  | 'on work'
  | 'Finishing'
  | 'Ready for Pickup'
  | 'Completed'
  | 'Cancelled';

export type OrderPriority = 'low' | 'normal' | 'high' | 'urgent';

export type PaymentStatus = 'Unpaid' | 'Partial' | 'Paid' | 'Refunded';

export interface CreateOrderItemInput {
  garment_type: string;
  item_name: string;
  quantity: number;
  unit_price: number;
  measurement_profile_id?: string | null;
  custom_measurements?: Record<string, number> | null;
  assigned_tailor_id?: string | null;
  fabric_details?: string | null;
  special_instructions?: string | null;
}

export interface CreateOrderInput {
  customer_id: string;
  due_date?: string | null;
  priority?: OrderPriority;
  assigned_tailor_id?: string | null;
  discount_amount?: number;
  notes?: string | null;
  items: CreateOrderItemInput[];
}

export interface UpdateOrderInput {
  due_date?: string | null;
  priority?: OrderPriority;
  assigned_tailor_id?: string | null;
  discount_amount?: number;
  notes?: string | null;
}

export interface ChangeOrderStatusInput {
  status: OrderStatus;
  comments?: string | null;
}

export interface OrderQueryOptions {
  page?: number;
  limit?: number;
  status?: OrderStatus;
  customer_id?: string;
  assigned_tailor_id?: string;
  priority?: OrderPriority;
  due_date?: string;
  search?: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  garment_type: string;
  item_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  fabric_details: string | null;
  special_instructions: string | null;
  item_status: OrderStatus;
  assigned_tailor_id: string | null;
  assigned_tailor_name?: string | null;
  created_at: string;
  updated_at: string;
  snapshot?: {
    id: string;
    profile_source_id: string | null;
    garment_type: string;
    snapshot_data: Record<string, number>;
    captured_at: string;
  } | null;
}

export interface OrderStatusHistoryItem {
  id: string;
  order_id: string;
  previous_status: string | null;
  new_status: string;
  changed_by: string | null;
  changed_by_name?: string | null;
  comments: string | null;
  created_at: string;
}

export interface OrderDetail {
  id: string;
  order_number: string;
  customer_id: string;
  customer: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
  };
  assigned_tailor_id: string | null;
  assigned_tailor_name: string | null;
  status: OrderStatus;
  priority: OrderPriority;
  due_date: string | null;
  total_amount: number;
  discount_amount: number;
  net_payable: number;
  paid_amount: number;
  payment_status: PaymentStatus;
  notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  items: OrderItem[];
  status_history: OrderStatusHistoryItem[];
}
