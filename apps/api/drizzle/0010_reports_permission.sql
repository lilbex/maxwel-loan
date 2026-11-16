INSERT INTO permissions (code, description) VALUES ('reports.read', 'View financial and portfolio reports');

DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO role_permissions (tenant_id, role_id, permission_code)
    SELECT r.tenant_id, r.id, 'reports.read'
    FROM roles r
    WHERE r.tenant_id = t AND r.is_system AND r.name IN ('Admin', 'Accountant', 'Approver', 'Auditor')
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
