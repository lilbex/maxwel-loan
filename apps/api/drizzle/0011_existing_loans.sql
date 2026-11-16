CREATE TYPE "public"."record_origin" AS ENUM('new', 'existing');--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "kind" "record_origin" DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "existing_disbursement_date" date;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "existing_first_due_date" date;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "existing_paid_kobo" bigint;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "paper_reference" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "origin" "record_origin" DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "penalties_after" date;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "is_opening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_existing_details" CHECK (("loan_applications"."kind" = 'existing') = ("loan_applications"."existing_disbursement_date" IS NOT NULL AND "loan_applications"."existing_paid_kobo" IS NOT NULL));