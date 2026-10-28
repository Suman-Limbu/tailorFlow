import { Router } from 'express';
import {
  handleCreateOrder,
  handleGetOrders,
  handleGetOrderById,
  handleUpdateOrder,
  handleChangeOrderStatus,
  handleAssignItemTailor,
} from '../controllers/order.controller.js';
import { paymentRouter } from './payments.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const orderRouter = Router();

// Staff-only endpoints: Admin and Tailor
orderRouter.use(authenticate, requireRole('admin', 'tailor'));

orderRouter.post('/', handleCreateOrder);
orderRouter.get('/', handleGetOrders);
orderRouter.get('/:id', handleGetOrderById);
orderRouter.put('/:id', handleUpdateOrder);
orderRouter.patch('/:id/status', handleChangeOrderStatus);
orderRouter.patch('/:id/items/:itemId/tailor', handleAssignItemTailor);

// Payment & Refund sub-routes
orderRouter.use('/:orderId/payments', paymentRouter);
