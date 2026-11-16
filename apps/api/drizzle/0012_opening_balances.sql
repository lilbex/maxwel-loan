-- Existing lenders get the Opening balances account that new lenders start with.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO ledger_accounts (tenant_id, code, name, type)
    VALUES (t, '3200', 'Opening balances', 'equity')
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

GRANT UPDATE (penalties_after) ON loans TO loan_app;
