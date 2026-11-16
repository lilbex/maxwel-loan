-- Tenant isolation, ledger integrity and least-privilege grants.
-- Expects the loan_app role to exist. See infra/postgres/init.sql.

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO loan_app;
GRANT USAGE ON SCHEMA public TO loan_app;

-- Returns NULL with no tenant set, so an unscoped query matches no rows.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- tenants is the one table that is not FORCE'd, so this function, owned by the migrator,
-- can resolve a login workspace before any tenant context exists.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

CREATE FUNCTION app.tenant_id_by_slug(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT id FROM public.tenants WHERE slug = p_slug AND status = 'active' $$;
REVOKE ALL ON FUNCTION app.tenant_id_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_id_by_slug(text) TO loan_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches', 'users', 'roles', 'role_permissions', 'user_roles', 'sessions',
    'audit_events', 'ledger_accounts', 'journal_entries', 'journal_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
  END LOOP;
END $$;

-- Least privilege for the running API. Nothing here can update or delete a posted record.
GRANT SELECT ON tenants, permissions TO loan_app;
GRANT SELECT, INSERT ON branches, roles, role_permissions, audit_events, ledger_accounts, journal_entries, journal_lines TO loan_app;
GRANT SELECT, INSERT, UPDATE ON users, sessions TO loan_app;
GRANT SELECT, INSERT, DELETE ON user_roles TO loan_app;
GRANT UPDATE (name, is_active) ON ledger_accounts TO loan_app;

-- Append-only: a second line of defence behind the grants, covering the migrator role as well.
-- Corrections are made with reversal entries.
CREATE FUNCTION app.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'LP001';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries', 'journal_lines', 'audit_events'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t
    );
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()', t
    );
  END LOOP;
END $$;

CREATE FUNCTION app.stamp_journal_entry() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.created_txid := pg_current_xact_id();
  NEW.posted_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER stamp BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.stamp_journal_entry();

-- A line may only join an entry created in this same transaction, and only on an active account.
CREATE FUNCTION app.guard_journal_line() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM journal_entries
    WHERE id = NEW.entry_id AND created_txid = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'journal entry % is already posted', NEW.entry_id USING ERRCODE = 'LP001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE id = NEW.account_id AND is_active) THEN
    RAISE EXCEPTION 'ledger account % is inactive', NEW.account_id USING ERRCODE = 'LP003';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_line();

-- Checked at commit, so no code path can leave an entry unbalanced or empty.
CREATE FUNCTION app.assert_entry_balanced() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_entry_id uuid;
  v_debit numeric;
  v_credit numeric;
  v_lines bigint;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    v_entry_id := NEW.id;
  ELSE
    v_entry_id := NEW.entry_id;
  END IF;

  SELECT
    COALESCE(SUM(amount_kobo) FILTER (WHERE side = 'debit'), 0),
    COALESCE(SUM(amount_kobo) FILTER (WHERE side = 'credit'), 0),
    COUNT(*)
  INTO v_debit, v_credit, v_lines
  FROM journal_lines
  WHERE entry_id = v_entry_id;

  IF v_lines < 2 OR v_debit <> v_credit THEN
    RAISE EXCEPTION 'journal entry % does not balance: debits %, credits %, lines %',
      v_entry_id, v_debit, v_credit, v_lines
      USING ERRCODE = 'LP002';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER entry_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_balanced();

CREATE CONSTRAINT TRIGGER line_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_balanced();

INSERT INTO permissions (code, description) VALUES
  ('users.read', 'View staff accounts'),
  ('users.manage', 'Create staff accounts and assign roles'),
  ('audit.read', 'View the audit log'),
  ('ledger.read', 'View ledger accounts, journal entries and reports'),
  ('ledger.post', 'Post manual journal entries'),
  ('ledger.reverse', 'Reverse posted journal entries'),
  ('accounts.manage', 'Create and change ledger accounts');
