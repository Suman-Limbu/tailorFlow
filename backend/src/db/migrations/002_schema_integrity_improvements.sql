-- TailorFlow Native SQL Migration: 002_schema_integrity_improvements.sql
-- Description: Enhances schema integrity:
--  1. Adds assigned_tailor_id to order_items for garment-level tailor assignment.
--  2. Enforces database-level immutability (blocks UPDATE) on order_measurement_snapshots.
--  3. Protects order_measurement_snapshots against accidental deletion for active/completed orders.
--  4. Enforces discount_amount <= total_amount check constraint on orders.
--  5. Sets default user role to 'customer' for secure registration.

-- 1. Garment-level Tailor Assignment
ALTER TABLE order_items 
ADD COLUMN IF NOT EXISTS assigned_tailor_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_tailor ON order_items(assigned_tailor_id);

-- 2. Database-level Protection Against UPDATE on order_measurement_snapshots
CREATE OR REPLACE FUNCTION prevent_measurement_snapshot_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Order measurement snapshots are immutable and cannot be updated. Snapshot ID: %', OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_order_measurement_snapshots_update ON order_measurement_snapshots;

CREATE TRIGGER trg_protect_order_measurement_snapshots_update
BEFORE UPDATE ON order_measurement_snapshots
FOR EACH ROW
EXECUTE FUNCTION prevent_measurement_snapshot_update();

-- 3. Deletion Protection on order_measurement_snapshots
-- Prevents deleting measurement snapshots if the parent order is in production or completed.
CREATE OR REPLACE FUNCTION prevent_measurement_snapshot_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_order_status VARCHAR(50);
BEGIN
    SELECT status INTO v_order_status FROM orders WHERE id = OLD.order_id;
    IF v_order_status IS NOT NULL AND v_order_status NOT IN ('Pending', 'Cancelled') THEN
        RAISE EXCEPTION 'Cannot delete measurement snapshot for active or fulfilled order % (current status: %)', OLD.order_id, v_order_status;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_order_measurement_snapshots_delete ON order_measurement_snapshots;

CREATE TRIGGER trg_protect_order_measurement_snapshots_delete
BEFORE DELETE ON order_measurement_snapshots
FOR EACH ROW
EXECUTE FUNCTION prevent_measurement_snapshot_deletion();

-- 4. Financial Consistency: discount_amount cannot exceed total_amount
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_discount_limit'
    ) THEN
        ALTER TABLE orders ADD CONSTRAINT chk_orders_discount_limit CHECK (discount_amount <= total_amount);
    END IF;
END $$;

-- 5. Authentication Security: Default role to 'customer'
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'customer';
