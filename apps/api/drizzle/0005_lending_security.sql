DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_counters', 'borrowers', 'loan_applications', 'guarantors', 'collateral',
    'approvals', 'loans', 'schedule_items'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON tenant_counters, borrowers, loan_applications TO loan_app;
GRANT SELECT, INSERT, DELETE ON guarantors, collateral TO loan_app;
GRANT SELECT, INSERT ON approvals, schedule_items, loans TO loan_app;

-- A loan's money terms cannot be changed after approval. Only disbursement details and status can.
GRANT UPDATE (
  status, disbursement_date, disbursement_method, disbursement_reference,
  disbursed_by_user_id, disbursement_entry_id, updated_at
) ON loans TO loan_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approvals', 'schedule_items'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t
    );
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()', t
    );
  END LOOP;
END $$;

INSERT INTO permissions (code, description) VALUES
  ('borrowers.read', 'View borrowers'),
  ('borrowers.manage', 'Add and change borrowers'),
  ('loans.read', 'View loan applications and loans'),
  ('loans.apply', 'Prepare and submit loan applications'),
  ('loans.approve', 'Approve, reject or return loan applications'),
  ('loans.disburse', 'Record loan disbursements');

-- Existing lenders get the new permissions and the two new roles.
DO $$
DECLARE
  t uuid;
  role_name text;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    FOREACH role_name IN ARRAY ARRAY['Loan Officer', 'Approver'] LOOP
      INSERT INTO roles (tenant_id, name, is_system) VALUES (t, role_name, true)
      ON CONFLICT (tenant_id, name) DO NOTHING;
    END LOOP;

    INSERT INTO role_permissions (tenant_id, role_id, permission_code)
    SELECT r.tenant_id, r.id, p.code
    FROM roles r
    JOIN (VALUES
      ('Admin', 'borrowers.read'), ('Admin', 'borrowers.manage'), ('Admin', 'loans.read'),
      ('Admin', 'loans.apply'), ('Admin', 'loans.approve'), ('Admin', 'loans.disburse'),
      ('Loan Officer', 'borrowers.read'), ('Loan Officer', 'borrowers.manage'), ('Loan Officer', 'loans.read'),
      ('Loan Officer', 'loans.apply'), ('Loan Officer', 'products.read'),
      ('Approver', 'borrowers.read'), ('Approver', 'loans.read'), ('Approver', 'loans.approve'),
      ('Approver', 'products.read'),
      ('Accountant', 'borrowers.read'), ('Accountant', 'loans.read'), ('Accountant', 'loans.disburse'),
      ('Auditor', 'borrowers.read'), ('Auditor', 'loans.read')
    ) AS p(role_name, code) ON p.role_name = r.name
    WHERE r.tenant_id = t AND r.is_system
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
