CREATE TYPE "public"."collection_outcome" AS ENUM('called', 'no_answer', 'promised', 'visited', 'other');--> statement-breakpoint
CREATE TABLE "collection_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"outcome" "collection_outcome" NOT NULL,
	"note" text NOT NULL,
	"promised_date" date,
	"promised_amount_kobo" bigint,
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "penalty_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"schedule_item_id" uuid NOT NULL,
	"charge_date" date NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"basis_kobo" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "penalty_charges_once_a_day" UNIQUE("tenant_id","schedule_item_id","charge_date"),
	CONSTRAINT "penalty_charges_amount" CHECK ("penalty_charges"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "penalty_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"schedule_item_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"waived_on" date NOT NULL,
	"reason" text NOT NULL,
	"waived_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "penalty_waivers_amount" CHECK ("penalty_waivers"."amount_kobo" > 0)
);
--> statement-breakpoint
ALTER TABLE "collection_notes" ADD CONSTRAINT "collection_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_notes" ADD CONSTRAINT "collection_notes_tenant_id_loan_id_loans_tenant_id_id_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_notes" ADD CONSTRAINT "collection_notes_tenant_id_recorded_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","recorded_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_charges" ADD CONSTRAINT "penalty_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_charges" ADD CONSTRAINT "penalty_charges_tenant_id_loan_id_loans_tenant_id_id_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_charges" ADD CONSTRAINT "penalty_charges_tenant_id_schedule_item_id_schedule_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","schedule_item_id") REFERENCES "public"."schedule_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_waivers" ADD CONSTRAINT "penalty_waivers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_waivers" ADD CONSTRAINT "penalty_waivers_tenant_id_loan_id_loans_tenant_id_id_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_waivers" ADD CONSTRAINT "penalty_waivers_tenant_id_schedule_item_id_schedule_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","schedule_item_id") REFERENCES "public"."schedule_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_waivers" ADD CONSTRAINT "penalty_waivers_tenant_id_waived_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","waived_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_notes_tenant_id_loan_id_created_at_index" ON "collection_notes" USING btree ("tenant_id","loan_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "penalty_charges_tenant_id_loan_id_index" ON "penalty_charges" USING btree ("tenant_id","loan_id");--> statement-breakpoint
CREATE INDEX "penalty_waivers_tenant_id_loan_id_index" ON "penalty_waivers" USING btree ("tenant_id","loan_id");