CREATE TYPE "public"."currency" AS ENUM('TON', 'USDT');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('matched', 'underpaid', 'unmatched', 'ignored');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"kind" text DEFAULT 'order_paid' NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"product_id" uuid NOT NULL,
	"product_title" text NOT NULL,
	"currency" "currency" NOT NULL,
	"amount" bigint NOT NULL,
	"jetton_master" text,
	"merchant_address" text NOT NULL,
	"payer_address" text,
	"payer_jetton_wallet" text,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone,
	"ext_msg_hash" text,
	"paid_late" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" bigint,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_id_format" CHECK ("orders"."id" ~ '^[0-9a-hjkmnp-tv-z]{16}$'),
	CONSTRAINT "orders_amount_positive" CHECK ("orders"."amount" > 0),
	CONSTRAINT "orders_usdt_has_master" CHECK ("orders"."currency" <> 'USDT' OR "orders"."jetton_master" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account" text NOT NULL,
	"tx_hash" text NOT NULL,
	"tx_lt" bigint NOT NULL,
	"tx_now" timestamp with time zone NOT NULL,
	"mc_block_seqno" bigint NOT NULL,
	"trace_id" text,
	"currency" "currency",
	"jetton_master" text,
	"source_wallet" text,
	"amount" bigint NOT NULL,
	"sender_address" text,
	"comment" text,
	"order_id" text,
	"status" "payment_status" NOT NULL,
	"reason" text,
	"payer_mismatch" boolean DEFAULT false NOT NULL,
	"attached_by" bigint,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tx_hash_unique" UNIQUE("tx_hash"),
	CONSTRAINT "payments_tx_hash_hex" CHECK ("payments"."tx_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payments_amount_nonnegative" CHECK ("payments"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"image_url" text,
	"price_ton_nano" bigint,
	"price_usdt_units" bigint,
	"delivery_payload" text,
	"deliver_in_chat" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_price_ton_positive" CHECK ("products"."price_ton_nano" IS NULL OR "products"."price_ton_nano" > 0),
	CONSTRAINT "products_price_usdt_positive" CHECK ("products"."price_usdt_units" IS NULL OR "products"."price_usdt_units" > 0),
	CONSTRAINT "products_has_price" CHECK ("products"."price_ton_nano" IS NOT NULL OR "products"."price_usdt_units" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "scan_cursors" (
	"account" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"last_lt" bigint DEFAULT 0 NOT NULL,
	"last_hash" text,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"telegram_id" bigint PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text,
	"username" text,
	"language_code" text,
	"photo_url" text,
	"is_premium" boolean DEFAULT false NOT NULL,
	"allows_write_to_pm" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_telegram_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("telegram_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_order_kind_uq" ON "notifications" USING btree ("order_id","kind");--> statement-breakpoint
CREATE INDEX "notifications_pending_next_idx" ON "notifications" USING btree ("next_attempt_at") WHERE "notifications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_status_expires_idx" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_account_lt_uq" ON "payments" USING btree ("account","tx_lt");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_matched_per_order" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'matched';--> statement-breakpoint
CREATE INDEX "payments_status_created_idx" ON "payments" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "products_active_sort_idx" ON "products" USING btree ("is_active","sort_order");