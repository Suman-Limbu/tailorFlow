export type GarmentType =
  | 'shirt'
  | 'trouser'
  | 'pant'
  | 'suit'
  | 'blazer'
  | 'coat'
  | 'kurta'
  | 'waistcoat'
  | 'other';

export type MeasurementValues = Record<string, number>;

export interface MeasurementProfile {
  id: string;
  customer_id: string;
  title: string;
  garment_type: string;
  measurements: MeasurementValues;
  notes: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateMeasurementProfileInput {
  title: string;
  garment_type: string;
  measurements: MeasurementValues;
  notes?: string | null;
  is_default?: boolean;
}

export interface UpdateMeasurementProfileInput {
  title?: string;
  garment_type?: string;
  measurements?: MeasurementValues;
  notes?: string | null;
  is_default?: boolean;
}
