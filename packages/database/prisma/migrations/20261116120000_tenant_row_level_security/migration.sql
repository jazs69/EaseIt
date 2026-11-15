-- MT-04: PostgreSQL row-level security as the tenancy backstop (CLAUDE.md section 3.2).
--
-- Every table whose "propertyId" is NOT NULL gets a default-deny policy: a row
-- is visible, and may be written, only when the transaction's
-- app.current_property_id names its property, or app.tenant_bypass is 'on'
-- (set only by withoutTenantScope(), which is logged). With neither set, a
-- query sees zero rows. The application sets both with set_config(..., true),
-- i.e. transaction-local, in the same transaction as the query.
--
-- FORCE so the policy also binds the table owner if the owner is ever not a
-- superuser. Superusers and BYPASSRLS roles are exempt by PostgreSQL design,
-- which is why the API and worker connect as the non-superuser role created by
-- scripts/db-app-role.mjs, while migrations, seeds and test fixtures keep the
-- owner login. Foreign-key checks and ON DELETE CASCADE are not subject to RLS.
--
-- Existing rows are untouched: this adds policies only.

CREATE OR REPLACE FUNCTION "tenant_row_visible"("rowPropertyId" uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.tenant_bypass', true) = 'on'
        OR "rowPropertyId" = NULLIF(current_setting('app.current_property_id', true), '')::uuid
  $$;

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_log"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "company"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "daily_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "daily_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "daily_snapshot"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "fee_and_surcharge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fee_and_surcharge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fee_and_surcharge"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "folio" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folio" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "folio"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "folio_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folio_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "folio_line"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "inventory_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory_day"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "night_audit_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "night_audit_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "night_audit_run"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "night_audit_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "night_audit_step" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "night_audit_step"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "outbox_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "outbox_event"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "payment_gateway_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_gateway_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payment_gateway_config"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "promo_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promo_code" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "promo_code"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "promotion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "promotion"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "promotion_rate_plan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_rate_plan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "promotion_rate_plan"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "promotion_redemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_redemption" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "promotion_redemption"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "promotion_room_type" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_room_type" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "promotion_room_type"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "property_amenity_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "property_amenity_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "property_amenity_link"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "property_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "property_media" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "property_media"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "property_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "property_policy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "property_policy"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "property_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "property_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "property_settings"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "property_tax_slab" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "property_tax_slab" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "property_tax_slab"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "rate_plan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_plan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rate_plan"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "rate_plan_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_plan_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rate_plan_day"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "rate_plan_room_type" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_plan_room_type" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rate_plan_room_type"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "rate_pricing_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_pricing_rule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rate_pricing_rule"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "rate_pricing_rule_price" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_pricing_rule_price" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rate_pricing_rule_price"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "rate_restriction_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_restriction_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rate_restriction_day"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reservation"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "reservation_guest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_guest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reservation_guest"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "reservation_night" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_night" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reservation_night"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "reservation_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_note" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reservation_note"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "reservation_room" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_room" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reservation_room"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "room" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "room" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "room"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "room_block" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "room_block" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "room_block"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "room_type" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "room_type" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "room_type"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "user_property_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_property_role" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "user_property_role"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

