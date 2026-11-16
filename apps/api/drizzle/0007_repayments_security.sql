DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments', 'payment_allocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT ON %I TO loan_app', t);
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t
    );
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()', t
    );
  END LOOP;
END $$;

-- Checked at commit: a payment must be fully allocated. Corrections carry no allocations.
CREATE FUNCTION app.assert_payment_allocated() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_payment_id uuid;
  v_amount bigint;
  v_reverses uuid;
  v_allocated numeric;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    v_payment_id := NEW.id;
  ELSE
    v_payment_id := NEW.payment_id;
  END IF;

  SELECT amount_kobo, reverses_payment_id INTO v_amount, v_reverses FROM payments WHERE id = v_payment_id;
  SELECT COALESCE(SUM(amount_kobo), 0) INTO v_allocated FROM payment_allocations WHERE payment_id = v_payment_id;

  IF (v_reverses IS NULL AND v_allocated <> v_amount) OR (v_reverses IS NOT NULL AND v_allocated <> 0) THEN
    RAISE EXCEPTION 'payment % has % allocated of %', v_payment_id, v_allocated, v_amount USING ERRCODE = 'LP004';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER payment_allocated AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_payment_allocated();

CREATE CONSTRAINT TRIGGER allocation_complete AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_payment_allocated();

INSERT INTO permissions (code, description) VALUES
  ('payments.record', 'Record repayments'),
  ('payments.reverse', 'Correct repayments recorded by someone else');

DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO role_permissions (tenant_id, role_id, permission_code)
    SELECT r.tenant_id, r.id, p.code
    FROM roles r
    JOIN (VALUES
      ('Admin', 'payments.record'), ('Admin', 'payments.reverse'),
      ('Loan Officer', 'payments.record'),
      ('Accountant', 'payments.record'), ('Accountant', 'payments.reverse')
    ) AS p(role_name, code) ON p.role_name = r.name
    WHERE r.tenant_id = t AND r.is_system
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
