ALTER TABLE "request_logs" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_logs" ALTER COLUMN "created_at" SET DEFAULT now();