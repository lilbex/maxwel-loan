CREATE TYPE "public"."application_decision" AS ENUM('approved', 'rejected', 'returned');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."disbursement_method" AS ENUM('cash', 'bank');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('approved', 'active', 'cancelled');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"decision" "application_decision" NOT NULL,
	"note" text,
	"decided_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "borrowers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"address" text NOT NULL,
	"business_name" text,
	"occupation" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "borrowers_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "borrowers_reference" UNIQUE("tenant_id","reference"),
	CONSTRAINT "borrowers_phone" UNIQUE("tenant_id","phone")
);
--> statement-breakpoint
CREATE TABLE "collateral" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"estimated_value_kobo" bigint NOT NULL,
	CONSTRAINT "collateral_value" CHECK ("collateral"."estimated_value_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "guarantors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"address" text NOT NULL,
	"relationship" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"status" "application_status" DEFAULT 'draft' NOT NULL,
	"borrower_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"principal_kobo" bigint NOT NULL,
	"term_count" integer NOT NULL,
	"purpose" text NOT NULL,
	"prepared_by_user_id" uuid NOT NULL,
	"submitted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_applications_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_applications_reference" UNIQUE("tenant_id","reference"),
	CONSTRAINT "loan_applications_principal" CHECK ("loan_applications"."principal_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"application_id" uuid NOT NULL,
	"borrower_id" uuid NOT NULL,
	"status" "loan_status" DEFAULT 'approved' NOT NULL,
	"principal_kobo" bigint NOT NULL,
	"term_count" integer NOT NULL,
	"terms" jsonb NOT NULL,
	"prepared_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disbursement_date" date,
	"disbursement_method" "disbursement_method",
	"disbursement_reference" text,
	"disbursed_by_user_id" uuid,
	"disbursement_entry_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loans_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "loans_reference" UNIQUE("tenant_id","reference"),
	CONSTRAINT "loans_one_per_application" UNIQUE("tenant_id","application_id"),
	CONSTRAINT "loans_maker_checker" CHECK ("loans"."approved_by_user_id" <> "loans"."prepared_by_user_id"),
	CONSTRAINT "loans_principal" CHECK ("loans"."principal_kobo" > 0),
	CONSTRAINT "loans_active_is_disbursed" CHECK ("loans"."status" <> 'active' OR ("loans"."disbursement_entry_id" IS NOT NULL AND "loans"."disbursement_date" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "schedule_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"due_date" date NOT NULL,
	"principal_kobo" bigint NOT NULL,
	"interest_kobo" bigint NOT NULL,
	"fee_kobo" bigint NOT NULL,
	"total_kobo" bigint NOT NULL,
	"balance_after_kobo" bigint NOT NULL,
	CONSTRAINT "schedule_items_number" UNIQUE("tenant_id","loan_id","number"),
	CONSTRAINT "schedule_items_total" CHECK ("schedule_items"."total_kobo" = "schedule_items"."principal_kobo" + "schedule_items"."interest_kobo" + "schedule_items"."fee_kobo")
);
--> statement-breakpoint
CREATE TABLE "tenant_counters" (
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" bigint NOT NULL,
	CONSTRAINT "tenant_counters_tenant_id_name_pk" PRIMARY KEY("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_application_id_loan_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."loan_applications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_decided_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","decided_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrowers" ADD CONSTRAINT "borrowers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collateral" ADD CONSTRAINT "collateral_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collateral" ADD CONSTRAINT "collateral_tenant_id_application_id_loan_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."loan_applications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantors" ADD CONSTRAINT "guarantors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantors" ADD CONSTRAINT "guarantors_tenant_id_application_id_loan_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."loan_applications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_tenant_id_borrower_id_borrowers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","borrower_id") REFERENCES "public"."borrowers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_tenant_id_product_id_loan_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."loan_products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_tenant_id_prepared_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","prepared_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_tenant_id_submitted_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","submitted_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_application_id_loan_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."loan_applications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_borrower_id_borrowers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","borrower_id") REFERENCES "public"."borrowers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_prepared_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","prepared_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_approved_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","approved_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_disbursed_by_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","disbursed_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_disbursement_entry_id_journal_entries_tenant_id_id_fk" FOREIGN KEY ("tenant_id","disbursement_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_tenant_id_loan_id_loans_tenant_id_id_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_counters" ADD CONSTRAINT "tenant_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_tenant_id_application_id_index" ON "approvals" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "borrowers_tenant_id_full_name_index" ON "borrowers" USING btree ("tenant_id","full_name");--> statement-breakpoint
CREATE INDEX "collateral_tenant_id_application_id_index" ON "collateral" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "guarantors_tenant_id_application_id_index" ON "guarantors" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "loan_applications_tenant_id_status_index" ON "loan_applications" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "loan_applications_tenant_id_borrower_id_index" ON "loan_applications" USING btree ("tenant_id","borrower_id");--> statement-breakpoint
CREATE INDEX "loans_tenant_id_status_index" ON "loans" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "loans_tenant_id_borrower_id_index" ON "loans" USING btree ("tenant_id","borrower_id");--> statement-breakpoint
CREATE INDEX "schedule_items_tenant_id_due_date_index" ON "schedule_items" USING btree ("tenant_id","due_date");