# Data Model Proposal (Phase 4)

**Status:** Not started. Scaffold only.
**Blocked on:** Q-005 (which channels ship first) and Phase 5. Writing a schema before the protocols are read would bake in assumptions the OTAs will contradict.

## Note on the candidate entity list

The brief proposes Property, RoomType, RatePlan, Channel, ChannelConnection,
ChannelRoomMapping, ChannelRateMapping, Inventory, RateCalendar, RestrictionCalendar,
SyncJob, SyncAttempt, ExternalReservation, WebhookEvent, AuditLog -- explicitly as
proposals, not a confirmed Stayflexi schema. Agreed, and treated that way.

Four of these already exist here and must not be duplicated:

| Proposed | Already in this repo |
|---|---|
| Property | `Property` |
| RoomType | `RoomType` |
| Inventory | `InventoryDay` (per-date counters, oversell CHECK) |
| AuditLog | `AuditLog` |
| RatePlan | **absent** -- only a `MealPlan` enum; no rate-plan model exists |

So the genuinely new surface is `Channel`, `ChannelConnection`, `ChannelRoomMapping`,
`ChannelRateMapping`, `RateCalendar`, `RestrictionCalendar`, `SyncJob`, `SyncAttempt`,
`ExternalReservation`, `WebhookEvent` -- plus `RatePlan`, which the rates module owes us
and which channel rate mapping depends on.

**Sequencing consequence:** channel rate mapping cannot be built before rate plans exist.
That dependency is not stated in the brief and should drive the backlog order.
