CREATE TYPE "public"."etl_job_kind" AS ENUM('full', 'transform', 'load');--> statement-breakpoint
CREATE TYPE "public"."etl_job_state" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."etl_job_step" AS ENUM('extract', 'transform', 'load');--> statement-breakpoint
CREATE TABLE "etl_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arc_id" integer NOT NULL,
	"kind" "etl_job_kind" NOT NULL,
	"requested_by" text NOT NULL,
	"state" "etl_job_state" DEFAULT 'queued' NOT NULL,
	"current_step" "etl_job_step",
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "etl_job" ADD CONSTRAINT "etl_job_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "etl_job_one_active_per_arc" ON "etl_job" USING btree ("arc_id") WHERE "etl_job"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "etl_job_arc_created_idx" ON "etl_job" USING btree ("arc_id","created_at","id");