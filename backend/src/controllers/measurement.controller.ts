import type { Request, Response } from 'express';
import {
  createMeasurementProfile,
  getProfilesByCustomer,
  getProfileById,
  updateMeasurementProfile,
  setDefaultProfile,
  MeasurementError,
} from '../services/measurement.service.js';
import type { CreateMeasurementProfileInput, UpdateMeasurementProfileInput } from '../types/measurement.js';

export async function handleCreateMeasurementProfile(req: Request, res: Response): Promise<void> {
  try {
    const { customerId } = req.params;
    const { title, garment_type, measurements, notes, is_default } = req.body as CreateMeasurementProfileInput;

    const profile = await createMeasurementProfile(customerId, {
      title,
      garment_type,
      measurements,
      notes,
      is_default,
    });

    res.status(201).json({
      status: 'success',
      message: 'Measurement profile created successfully',
      data: {
        profile,
      },
    });
  } catch (err: unknown) {
    if (err instanceof MeasurementError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[create measurement profile error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to create measurement profile due to an internal server error',
    });
  }
}

export async function handleGetProfilesByCustomer(req: Request, res: Response): Promise<void> {
  try {
    const { customerId } = req.params;
    const garment_type = typeof req.query.garment_type === 'string' ? req.query.garment_type : undefined;

    const profiles = await getProfilesByCustomer(customerId, garment_type);

    res.status(200).json({
      status: 'success',
      data: {
        profiles,
        count: profiles.length,
      },
    });
  } catch (err: unknown) {
    if (err instanceof MeasurementError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[get measurement profiles error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve measurement profiles due to an internal server error',
    });
  }
}

export async function handleGetProfileById(req: Request, res: Response): Promise<void> {
  try {
    const { customerId, profileId } = req.params;
    const profile = await getProfileById(customerId, profileId);

    res.status(200).json({
      status: 'success',
      data: {
        profile,
      },
    });
  } catch (err: unknown) {
    if (err instanceof MeasurementError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[get measurement profile by id error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve measurement profile due to an internal server error',
    });
  }
}

export async function handleUpdateMeasurementProfile(req: Request, res: Response): Promise<void> {
  try {
    const { customerId, profileId } = req.params;
    const { title, garment_type, measurements, notes, is_default } = req.body as UpdateMeasurementProfileInput;

    const profile = await updateMeasurementProfile(customerId, profileId, {
      title,
      garment_type,
      measurements,
      notes,
      is_default,
    });

    res.status(200).json({
      status: 'success',
      message: 'Measurement profile updated successfully',
      data: {
        profile,
      },
    });
  } catch (err: unknown) {
    if (err instanceof MeasurementError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[update measurement profile error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update measurement profile due to an internal server error',
    });
  }
}

export async function handleSetDefaultProfile(req: Request, res: Response): Promise<void> {
  try {
    const { customerId, profileId } = req.params;
    const profile = await setDefaultProfile(customerId, profileId);

    res.status(200).json({
      status: 'success',
      message: 'Measurement profile set as default successfully',
      data: {
        profile,
      },
    });
  } catch (err: unknown) {
    if (err instanceof MeasurementError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[set default measurement profile error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to set default measurement profile due to an internal server error',
    });
  }
}
