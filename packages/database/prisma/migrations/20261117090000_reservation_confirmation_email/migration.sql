-- NO-04: booking confirmation email, delivered through the outbox.
-- Additive: one enum value. No existing row is changed.

-- AlterEnum
ALTER TYPE "OutboxEventType" ADD VALUE 'RESERVATION_CONFIRMATION_EMAIL';
