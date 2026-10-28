import type { PaymentStatus } from './order.js';

export type PaymentMethod = 'cash' | 'card' | 'upi_qr' | 'bank_transfer' | 'other';

export type PaymentType = 'advance' | 'installment' | 'final' | 'refund';

export interface Payment {
  id: string;
  order_id: string;
  amount: number;
  payment_method: PaymentMethod;
  transaction_reference: string | null;
  payment_type: PaymentType;
  notes: string | null;
  recorded_by: string | null;
  recorded_by_name?: string | null;
  created_at: string;
}

export interface RecordPaymentInput {
  amount: number;
  payment_method: PaymentMethod;
  payment_type?: 'advance' | 'installment' | 'final';
  transaction_reference?: string | null;
  notes?: string | null;
}

export interface RecordRefundInput {
  amount?: number;
  payment_method?: PaymentMethod;
  transaction_reference?: string | null;
  notes?: string | null;
}

export interface OrderPaymentSummary {
  order_id: string;
  order_number: string;
  status: string;
  total_amount: number;
  discount_amount: number;
  net_payable: number;
  paid_amount: number;
  balance_due: number;
  gross_collected: number;
  total_refunded: number;
  payment_status: PaymentStatus;
  payments: Payment[];
}
