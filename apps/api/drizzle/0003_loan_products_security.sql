ALTER TABLE loan_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loan_products
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Products are archived rather than deleted.
GRANT SELECT, INSERT, UPDATE ON loan_products TO loan_app;

INSERT INTO permissions (code, description) VALUES
  ('products.read', 'View loan products and preview schedules'),
  ('products.manage', 'Create and change loan products');

-- Give lenders that already exist the new permissions. role_permissions is FORCE'd, so each
-- tenant's rows need that tenant's context, even when run by the table owner.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO role_permissions (tenant_id, role_id, permission_code)
    SELECT r.tenant_id, r.id, p.code
    FROM roles r
    CROSS JOIN (VALUES ('products.read'), ('products.manage')) AS p(code)
    WHERE r.tenant_id = t
      AND r.is_system
      AND (r.name = 'Admin' OR (r.name IN ('Accountant', 'Auditor') AND p.code = 'products.read'));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
