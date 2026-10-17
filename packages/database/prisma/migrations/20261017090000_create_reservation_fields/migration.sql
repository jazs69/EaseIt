-- ===========================================================================
-- Fields the Create Reservation form needs: infants, ID type, and tax.
--
-- Effect on existing rows: additive, all defaulted, nothing rewritten. The 883
-- seeded reservations get infants = 0, govtIdType = NULL and taxAmountMinor = 0.
-- A zero tax on historical rows is accurate in the only sense available: no tax
-- was ever computed for them, because nothing computed tax until now.
--
-- `infants` is separate from `children` because an under-2 consumes neither
-- capacity nor rate. Folding them together would inflate occupancy and price.
--
-- `taxAmountMinor` is provisional and documented as such in the schema. Tax
-- properly belongs on its own folio line referencing the charge it derives
-- from (CLAUDE.md section 3.4), and there is no Folio table. The choice is
-- between storing the figure beside the gross total or discarding it at the
-- moment of booking and leaving every total un-reconcilable. It sits next to
-- `paidAmountMinor`, which is provisional for the same reason, and both are
-- dropped when `folios` lands.
--
-- Deliberately NOT added, though the brief listed them:
--   * A `Guest` table. Guest identity stays denormalised on the reservation;
--     normalising it is the `frontdesk` guest-profile work, and a half-built
--     Guest table now would create two sources of guest truth.
--   * `Folio` / `FolioLine` / `FolioPayment`. The brief asks to post room
--     charges at booking time, but section 3.3 step 3 has the night audit post
--     room charges per business date — doing both would double-post every
--     stay. Payment taken at booking goes to `paidAmountMinor` until folios
--     exist to hold it properly.
--   * `segment` / `subSegment` columns. `BookingSource` already models how a
--     booking arrived; two more columns over the same ground is the
--     near-synonym trap section 6.1 warns about. The form's segment and
--     sub-segment map onto `source`.
--
-- As with every migration since 20261016140000, `prisma migrate diff` again
-- proposed dropping the tenant-coherence constraints it cannot see in
-- schema.prisma. They are stripped from the generated SQL, never from the
-- database (CLAUDE.md section 6.2):
--   * ALTER TABLE "inventory_day" DROP CONSTRAINT "inventory_day_same_property_as_room_type";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room_type";
--   * ALTER TABLE "room" DROP CONSTRAINT "room_same_property_as_room_type";
--   * DROP INDEX "reservation_property_id_unique_pair";
--   * DROP INDEX "room_property_id_unique_pair";
--   * DROP INDEX "room_type_property_id_unique_pair";
-- ===========================================================================

-- CreateEnum
CREATE TYPE "GovtIdType" AS ENUM ('AADHAAR', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'PAN');

-- AlterTable
ALTER TABLE "reservation" ADD COLUMN     "govtIdType" "GovtIdType",
ADD COLUMN     "infants" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "taxAmountMinor" INTEGER NOT NULL DEFAULT 0;
