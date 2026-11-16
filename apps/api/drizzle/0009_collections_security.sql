DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['penalty_charges', 'penalty_waivers', 'collection_notes'] LOOP
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

-- The daily job runs with no signed-in user. This gives it lender ids and nothing else.
CREATE FUNCTION app.active_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT id FROM public.tenants WHERE status = 'active' $$;
REVOKE ALL ON FUNCTION app.active_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.active_tenant_ids() TO loan_app;

INSERT INTO permissions (code, description) VALUES
  ('penalties.manage', 'Waive late penalties and apply them on demand'),
  ('collections.manage', 'Record collection calls and promises to pay');

DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO role_permissions (tenant_id, role_id, permission_code)
    SELECT r.tenant_id, r.id, p.code
    FROM roles r
    JOIN (VALUES
      ('Admin', 'penalties.manage'), ('Admin', 'collections.manage'),
      ('Accountant', 'penalties.manage'), ('Accountant', 'collections.manage'),
      ('Loan Officer', 'collections.manage')
    ) AS p(role_name, code) ON p.role_name = r.name
    WHERE r.tenant_id = t AND r.is_system
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
