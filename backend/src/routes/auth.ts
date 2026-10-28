import { Router } from 'express';
import {
  handleRegister,
  handleLogin,
  handleGetMe,
  handleCreateStaff,
} from '../controllers/auth.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const authRouter = Router();

// Public routes
authRouter.post('/register', handleRegister);
authRouter.post('/login', handleLogin);

// Protected routes
authRouter.get('/me', authenticate, handleGetMe);

// Admin-only staff provisioning
authRouter.post('/staff', authenticate, requireRole('admin'), handleCreateStaff);
