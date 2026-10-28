import { Router } from 'express';
import {
  handleCreateMeasurementProfile,
  handleGetProfilesByCustomer,
  handleGetProfileById,
  handleUpdateMeasurementProfile,
  handleSetDefaultProfile,
} from '../controllers/measurement.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const measurementRouter = Router({ mergeParams: true });

// Require authentication and staff role (Admin or Tailor)
measurementRouter.use(authenticate, requireRole('admin', 'tailor'));

measurementRouter.post('/', handleCreateMeasurementProfile);
measurementRouter.get('/', handleGetProfilesByCustomer);
measurementRouter.get('/:profileId', handleGetProfileById);
measurementRouter.put('/:profileId', handleUpdateMeasurementProfile);
measurementRouter.patch('/:profileId/default', handleSetDefaultProfile);
