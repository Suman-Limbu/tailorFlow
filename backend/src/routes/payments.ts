import { Router } from 'express';
import {
  handleRecordPayment,
  handleRecordRefund,
  handleGetOrderPayments,
} from '../controllers/payment.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const paymentRouter = Router({ mergeParams: true });

// Require authentication for all payment operations
paymentRouter.use(authenticate);

// View payment history & balances: accessible to staff (Admin and Tailor)
paymentRouter.get('/', requireRole('admin', 'tailor'), handleGetOrderPayments);

// Financial transactions: strictly restricted to Admin
paymentRouter.post('/', requireRole('admin'), handleRecordPayment);
paymentRouter.post('/:paymentId/refund', requireRole('admin'), handleRecordRefund);
