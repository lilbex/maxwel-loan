# Loan Platform

Multi-tenant back office for lending companies. "Loan Platform" is a working name.

This repo covers all eight build steps: the foundation (tenants, staff sign-in, roles, audit log), the double-entry ledger, loan products with the schedule calculator, the path from borrower to disbursed loan, repayments with receipts and statements, late penalties with the collections view, reports, and moving existing loans in from paper.

## Run it locally

You need Node 22+, pnpm and Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
ADMIN_PASSWORD='choose-12-chars-min' pnpm tenant:create --slug demo --name "Demo Finance" \
  --admin-email admin@demo.test --admin-name "Ada Obi"
pnpm dev
```

Open http://localhost:3000 and sign in with workspace `demo`.

`pnpm test` runs the suite against a throwaway `loan_platform_test` database, using the Postgres container. Set `TEST_ADMIN_DATABASE_URL` to use a different server.

## Layout

```text
apps/api              NestJS API (modules: auth, users, audit, ledger, loan-products, borrowers, loans, reports, health)
apps/api/drizzle      Migrations. 0001_security.sql holds RLS, triggers and grants
apps/web              Next.js staff app. The browser reaches the API through /api on this origin
packages/api-client   Shared request schemas, response types and API client
infra/postgres        Database roles for local development
```

## Rules to keep

**Tenant data**

- Reach tenant data only through `DatabaseService.withTenant()`. With no tenant set, queries return no rows.
- The API runs as `loan_app`, which cannot bypass row-level security. It refuses to start as a role that can.
- New tenant tables need `tenant_id`, `unique(tenant_id, id)`, composite foreign keys, and RLS in a migration. A test fails if any table with `tenant_id` lacks RLS.
- Migrations and `tenant:create` use `MIGRATOR_DATABASE_URL`. The running API never gets it.

**Money**

- Amounts are whole kobo: `bigint` in PostgreSQL, `BigInt` in code, strings in JSON. Never use floats.
- All postings go through `LedgerService.post()`, inside the caller's transaction, so a repayment and its journal entry commit together.
- Every posting needs an idempotency key. Retrying with the same content returns the original entry. Reusing a key for different content returns 409.
- Posted entries and audit events are append-only. Correct mistakes with a reversal.

PostgreSQL enforces these ledger rules as well, so a bug in the service layer can't get around them: entries must balance at commit, lines can't be added after posting, and the API role has no UPDATE or DELETE on the journal or audit tables.

**Loan schedules**

- `modules/loan-products/schedule.ts` is pure arithmetic with no database access. It uses exact BigInt fractions and rounds half up.
- Supported methods are flat interest, reducing balance with equal repayments, and reducing balance with equal principal.
- The final installment settles any rounding, so a schedule always totals to the kobo.
- Editing a product changes new loans only. A loan copies the product's terms at approval, and the API role cannot change them afterwards.

**Loan flow**

- An application goes draft, submitted, then approved or rejected. Returning it sends it back to draft. Only a draft can change.
- The person who prepared or submitted an application cannot decide on it. The database also rejects a loan approved by its preparer, so every lender needs at least two staff.
- Approval creates the loan. The repayment schedule and journal entry are created at disbursement, in one transaction.
- Disbursement records money already paid out. It posts principal and upfront fees only.
- Schedules and decisions are append-only. Repayments are recorded separately and never change the schedule.

**Repayments**

- Income is recognised when paid. Each payment credits principal, interest, fee and penalty accounts for the share it covered.
- A payment clears the oldest installment first, following the product's payment order inside each installment. See `modules/loans/allocation.ts`.
- What a borrower owes is always worked out from the schedule and uncorrected payments in `modules/loans/position.ts`. It is never stored.
- A loan closes at zero. Anything above the balance goes to Borrower overpayments, a liability, until refunded.
- A correction is a new record that cancels a payment. Someone other than the recorder must make it, and corrections on a loan run newest first.

**Penalties and collections**

- `modules/loans/penalties.ts` works out every charge a loan should have by a given date. The daily job adds whichever are missing, so it is safe to repeat and a missed run catches up.
- The job runs at 00:30 Lagos time through BullMQ and Redis. If Redis is down, the app keeps working and the run waits. Staff with `penalties.manage` can also apply penalties from the Collections page.
- Each charge is based on what was unpaid on that installment on that date. Penalties do not compound, and charging stops once the installment is cleared.
- A charge touches no ledger account. Penalty income is posted when the penalty is paid, so a waiver needs no ledger entry.
- A backdated payment does not remove charges already made. Staff can waive those.
- Interest needs no daily job, because schedules fix it in advance and it is counted when paid.

**Reports**

- Reports read existing records and store nothing. Profit and loss and the balance sheet come straight from the ledger.
- Money collected groups payments by date. A correction is a negative on its own date, matching its ledger entry, so collected figures tie to the ledger for any range.
- The portfolio report compares loan records with account 1100. A manual journal on that account shows up as a warning.
- FCCPC returns are not built, because their required format still needs confirming.

**Moving from paper**

- An existing loan is a special application, so it gets the same draft, return and second-person check as a new one. It skips the product's amount and term limits, because the loan already exists.
- Confirming creates the loan, its schedule from the original dates, and one opening payment for the total repaid on paper. Normal allocation decides what that covered.
- The principal still owed goes to account 1100 against 3200 Opening balances. No cash or income moves, and opening payments stay out of money collected.
- Lateness before the move is shown as overdue but never penalised. Penalties apply only to dates after the move.
- Opening payments cannot be corrected through the repayment screen.

## Adding a migration

Change `apps/api/src/db/schema.ts`, then run `pnpm --filter @loan-platform/api db:generate`. For RLS, grants and triggers, add a custom migration with `npx drizzle-kit generate --custom`.

## Before real customer data

- Borrower ID checks. BVN and NIN are not stored yet, because they need encryption first
- Document uploads for applications
- FCCPC returns, once the required format is confirmed
- Fixing a moved loan after it is confirmed
- Penalties already owed on paper loans
- Refunding overpayments
- A cap on late penalties. Daily penalties currently run until the installment is cleared
- SMS payment reminders
- Early settlement discounts. Paying off a flat-rate loan early currently means paying all its interest
- Two-factor sign-in for admins and approvers
- Password reset and change
- Disabling staff accounts, including revoking their sessions
- Maker-checker approval for manual journal entries
- Closing accounting periods, so backdated entries can't change a closed month
- Encrypted backups with point-in-time recovery, and a tested restore

## Build order

1. ~~Foundation~~
2. ~~Ledger~~
3. ~~Loan products and the schedule calculator~~ (still to compare with the lender's spreadsheet)
4. ~~Borrowers, applications, approvals and recording disbursements~~
5. ~~Repayments, allocation, receipts and statements~~
6. ~~Daily penalty job and the collections view~~
7. ~~Reports~~
8. ~~Moving existing loans from paper, with a sign-off sheet~~
