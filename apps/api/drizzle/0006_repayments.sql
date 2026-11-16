CREATE TYPE "public"."allocation_bucket" AS ENUM('penalty', 'fee', 'interest', 'principal', 'overpayment');
--> statement-breakpoint
ALTER TYPE "public"."loan_status" ADD VALUE 'closed' BEFORE 'cancelled';
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"schedule_item_id" uuid,
	"bucket" "allocation_bucket" NOT NULL,
	"amount_kobo" bigint NOT NULL,
	CONSTRAINT "payment_allocations_amount" CHECK ("payment_allocations"."amount_kobo" > 0),
	CONSTRAINT "payment_allocations_item" CHECK (("payment_allocations"."bucket" = 'overpayment') = ("payment_allocations"."schedule_item_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"loan_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"payment_date" date NOT NULL,
	"method" "disbursement_method" NOT NULL,
	"external_reference" text,
	"note" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"reverses_payment_id" uuid,
	"balance_after_kobo" bigint NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_reference" UNIQUE("tenant_id","reference"),
	CONSTRAINT "payments_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "payments_one_reversal" UNIQUE("tenant_id","reverses_payment_id"),
	CONSTRAINT "payments_amount" CHECK ("payments"."amount_kobo" > 0)
);
--> statement-breakpoint
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_tenant_id_id_unique" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenant_id_payment_id_payments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenant_id_schedule_item_id_schedule_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","schedule_item_id") REFERENCES "public"."schedule_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_loan_id_loans_tenant_id_id_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_reverses_payment_id_payments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","reverses_payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_journal_entry_id_journal_entries_tenant_id_id_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_recorded_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","recorded_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "payment_allocations_tenant_id_payment_id_index" ON "payment_allocations" USING btree ("tenant_id","payment_id");
--> statement-breakpoint
CREATE INDEX "payments_tenant_id_loan_id_index" ON "payments" USING btree ("tenant_id","loan_id");
--> statement-breakpoint
CREATE INDEX "payments_tenant_id_created_at_index" ON "payments" USING btree ("tenant_id","created_at" DESC NULLS LAST);