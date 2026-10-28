import { Router } from 'express';
import {
  handleCreateCustomer,
  handleGetCustomers,
  handleGetCustomerById,
  handleUpdateCustomer,
} from '../controllers/customer.controller.js';
import { measurementRouter } from './measurements.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const customerRouter = Router();

// Staff-only customer management endpoints (Admin and Tailor)
customerRouter.use(authenticate, requireRole('admin', 'tailor'));

customerRouter.post('/', handleCreateCustomer);
customerRouter.get('/', handleGetCustomers);
customerRouter.get('/:id', handleGetCustomerById);
customerRouter.put('/:id', handleUpdateCustomer);

// Sub-resource routes: Clothing Measurement Profiles
customerRouter.use('/:customerId/measurements', measurementRouter);
