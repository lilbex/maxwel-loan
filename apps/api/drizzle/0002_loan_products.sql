CREATE TYPE "public"."interest_method" AS ENUM('flat', 'reducing_equal_installment', 'reducing_equal_principal');--> statement-breakpoint
CREATE TYPE "public"."period_basis" AS ENUM('simple', 'calendar');--> statement-breakpoint
CREATE TYPE "public"."loan_product_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."rate_period" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TYPE "public"."repayment_frequency" AS ENUM('daily', 'weekly', 'biweekly', 'monthly');--> statement-breakpoint
CREATE TABLE "loan_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "loan_product_status" DEFAULT 'active' NOT NULL,
	"interest_method" "interest_method" NOT NULL,
	"rate_percent" numeric(7, 4) NOT NULL,
	"rate_period" "rate_period" NOT NULL,
	"repayment_frequency" "repayment_frequency" NOT NULL,
	"period_basis" "period_basis" NOT NULL,
	"min_principal_kobo" bigint NOT NULL,
	"max_principal_kobo" bigint NOT NULL,
	"min_term" integer NOT NULL,
	"max_term" integer NOT NULL,
	"rounding_unit_kobo" integer NOT NULL,
	"fees" jsonb NOT NULL,
	"penalty" jsonb NOT NULL,
	"allocation_order" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_products_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_products_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "loan_products_rate" CHECK ("loan_products"."rate_percent" >= 0),
	CONSTRAINT "loan_products_principal_range" CHECK ("loan_products"."min_principal_kobo" > 0 AND "loan_products"."min_principal_kobo" <= "loan_products"."max_principal_kobo"),
	CONSTRAINT "loan_products_term_range" CHECK ("loan_products"."min_term" > 0 AND "loan_products"."min_term" <= "loan_products"."max_term")
);
--> statement-breakpoint
ALTER TABLE "loan_products" ADD CONSTRAINT "loan_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;