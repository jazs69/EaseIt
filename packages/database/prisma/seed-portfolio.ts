/**
 * The ten-property demo portfolio: fully configured Indian hospitality fixtures.
 *
 * ===========================================================================
 * Additive and idempotent. This module never deletes another property's data.
 *
 * `seed.ts` owns the reference portfolio at codes 31001-31010 and 31336, and
 * it is deliberately destructive about them: it rebuilds their reservations and
 * inventory from scratch every run. This module is the opposite — it owns
 * exactly the ten codes in `DEMO_PROPERTIES` and touches nothing else, so it
 * can be run against a database holding live demo bookings without losing
 * them. Every write is keyed on a natural key and converges on re-run.
 *
 * It is wired into `seed.ts`'s `main()` so a fresh database gets the whole
 * portfolio from one `pnpm prisma db seed`, and it is also runnable on its own
 * (`pnpm db:seed:portfolio`) for applying it to a database that already has
 * reservations worth keeping.
 *
 * WHAT THIS DELIBERATELY DOES NOT SEED
 * Rate plans (EP/CP/MAP pricing), common-area lock codes, booking-engine
 * configuration, kiosk device keys, per-category self-check-in guides and
 * per-room smart-lock codes have no models in this schema, and property
 * latitude/longitude, website, GSTIN, state code and contact person have no
 * columns. They are not seeded rather than being smuggled into free-text
 * fields that other code reads for other purposes: a GSTIN parked in
 * `legalName` is a field that lies, and `gstin` already means something
 * specific on `Company` (a corporate client's number, unique per property).
 * `MealPlan` on a reservation does record EP/CP/MAP, so the plan a guest is on
 * is seeded; what is missing is the per-person addon *pricing* that a
 * `RatePlan` model would hold.
 * ===========================================================================
 */

import {
  AmenityScope,
  BookingSource,
  FolioLineKind,
  FolioStatus,
  GovtIdType,
  MealPlan,
  MediaCategory,
  PaymentMethod,
  PolicyType,
  PropertyStatus,
  ReservationStatus,
  RoomStatus,
  type PrismaClient,
} from '../generated/client/index.js';

/* -------------------------------------------------------------------------- */
/*  Money                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rupees to integer paise.
 *
 * Every monetary figure in this file is written in rupees for legibility and
 * stored as an integer count of paise (CLAUDE.md section 3.4). `Math.round`
 * rather than a bare multiply because `1500.1 * 100` is 150009.99999999999 in
 * binary floating point, and a seed that stores 150009 has quietly invented a
 * one-paisa discrepancy for every folio built on it.
 */
function rupees(amount: number): number {
  return Math.round(amount * 100);
}

/* -------------------------------------------------------------------------- */
/*  Images                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where the demo photographs come from.
 *
 * ===========================================================================
 * Deterministic placeholders, not invented Unsplash IDs.
 *
 * The brief asked for Unsplash URLs. An `images.unsplash.com/photo-<id>` URL
 * only resolves if the id is a real photo, and I cannot verify a photo id from
 * memory — a plausible-looking wrong one is a broken image on every screen
 * that renders this catalogue, which is worse than an honest placeholder in
 * demo data somebody is going to look at. Unsplash's old `source.unsplash.com`
 * keyword endpoint, which would have solved this, was retired.
 *
 * So these are picsum.photos URLs seeded on the property and shot, which means
 * they resolve, they are stable across re-runs (the same room shows the same
 * picture), and they are visibly placeholders rather than pretending to be a
 * photograph of this specific hotel.
 *
 * To swap in a curated set, change `imageUrl` alone: the media rows are
 * generated from it, so one function is the whole integration point.
 * ===========================================================================
 */
function imageUrl(seed: string, width = 1600, height = 900): string {
  return `https://picsum.photos/seed/${seed}/${String(width)}/${String(height)}`;
}

/* -------------------------------------------------------------------------- */
/*  GST                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The accommodation bands in force since 22 September 2025.
 *
 * ===========================================================================
 * Three bands, not two: exempt up to ₹1,000 a night, 5% **without** input tax
 * credit from ₹1,001 to ₹7,500, and 18% with ITC above that.
 *
 * The brief specified two bands — 5% up to ₹7,500 and 18% above — which has
 * the right middle rate and drops an exemption that still applies. A ₹900
 * homestay room is not a 5% supply, it is exempt, and seeding 5% on it
 * over-charges a guest. The pre-September-2025 table (12% with ITC on the
 * middle band) is what this repository seeded until it was corrected.
 *
 * The band is decided on the **per-night** value, never the stay total: four
 * nights at ₹3,000 is a ₹3,000 room, and banding on ₹12,000 would push it two
 * bands up. Published guidance is not unanimous on whether the ₹7,500 test
 * reads the declared tariff or the value actually billed, so a property that
 * discounts an ₹8,000 room below the line should confirm its own treatment.
 *
 * `cgst` and `sgst` are carried rather than halved at print time, because the
 * split is an intra-state one and an inter-state supply is IGST, unsplit.
 * ===========================================================================
 */
const TAX_SLABS: readonly {
  slabName: string;
  minTariffMinor: number;
  maxTariffMinor: number | null;
  taxRatePercent: string;
  cgstRatePercent: string;
  sgstRatePercent: string;
}[] = [
  {
    slabName: 'Exempt tariff (up to ₹1,000)',
    minTariffMinor: rupees(0),
    maxTariffMinor: rupees(1_000),
    taxRatePercent: '0.00',
    cgstRatePercent: '0.00',
    sgstRatePercent: '0.00',
  },
  {
    slabName: 'Standard tariff (₹1,001 to ₹7,500)',
    minTariffMinor: rupees(1_000),
    maxTariffMinor: rupees(7_500),
    taxRatePercent: '5.00',
    cgstRatePercent: '2.50',
    sgstRatePercent: '2.50',
  },
  {
    slabName: 'Premium tariff (above ₹7,500)',
    minTariffMinor: rupees(7_500),
    maxTariffMinor: null,
    taxRatePercent: '18.00',
    cgstRatePercent: '9.00',
    sgstRatePercent: '9.00',
  },
];

/**
 * The rate for a nightly tariff under the table above.
 *
 * Mirrors `resolveTaxSlab` in the API's tax engine, deliberately rather than
 * importing it: `packages/database` must not depend on `apps/api`. What keeps
 * the two in step is that both read the same half-open `[floor, ceiling)`
 * bands, and this one resolves against the very rows it is about to seed — so
 * the tax on a seeded folio line is by construction the tax the API would
 * compute for that room.
 */
function taxPercentForNightly(nightlyRateMinor: number): number {
  const slab = TAX_SLABS.find(
    (candidate) =>
      nightlyRateMinor >= candidate.minTariffMinor &&
      (candidate.maxTariffMinor === null || nightlyRateMinor < candidate.maxTariffMinor),
  );
  if (slab === undefined) {
    throw new Error(
      `No seeded tax slab covers a nightly tariff of ${String(nightlyRateMinor)} paise.`,
    );
  }
  return Number(slab.taxRatePercent);
}

/* -------------------------------------------------------------------------- */
/*  Amenity catalogue                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Portfolio-wide amenity reference data.
 *
 * No `propertyId`: "Free Wi-Fi" means the same thing at all ten hotels, which
 * is why `amenity` is a global table (CLAUDE.md section 3.2). What differs per
 * property is whether it is offered and what it costs — `PropertyAmenityLink`.
 *
 * Upserted on `slug`, so this extends whatever catalogue already exists rather
 * than replacing it: the reference portfolio's ten amenities keep their ids
 * and their existing links stay intact.
 */
const AMENITY_CATALOGUE: readonly {
  slug: string;
  name: string;
  groupName: string;
  iconName: string;
}[] = [
  { slug: '24hr-power-backup', name: '24-hour power backup', groupName: 'Essentials', iconName: 'Zap' },
  { slug: '24hr-front-desk', name: '24-hour front desk', groupName: 'Services', iconName: 'ConciergeBell' },
  { slug: '24hr-security', name: '24-hour security', groupName: 'Safety & Security', iconName: 'ShieldCheck' },
  { slug: 'free-wifi', name: 'Free Wi-Fi', groupName: 'Essentials', iconName: 'Wifi' },
  { slug: 'air-conditioning', name: 'Air conditioning', groupName: 'Essentials', iconName: 'Snowflake' },
  { slug: 'parking', name: 'On-site parking', groupName: 'Essentials', iconName: 'CircleParking' },
  { slug: 'cctv', name: 'CCTV in common areas', groupName: 'Safety & Security', iconName: 'Cctv' },
  { slug: 'first-aid', name: 'First-aid kit', groupName: 'Safety & Security', iconName: 'BriefcaseMedical' },
  { slug: 'swimming-pool', name: 'Swimming pool', groupName: 'Recreation', iconName: 'Waves' },
  { slug: 'bar', name: 'Bar', groupName: 'Food & Beverage', iconName: 'Martini' },
  { slug: 'on-site-atm', name: 'On-site ATM', groupName: 'Services', iconName: 'Banknote' },
  { slug: 'badminton', name: 'Badminton equipment', groupName: 'Recreation', iconName: 'Volleyball' },
  { slug: 'laundry', name: 'Laundry service', groupName: 'Services', iconName: 'Shirt' },
  { slug: 'airport-transfer', name: 'Airport pickup and drop', groupName: 'Services', iconName: 'Car' },
  { slug: 'babysitting', name: 'Babysitting', groupName: 'Services', iconName: 'Baby' },
];

/**
 * What the paid amenities cost, where a property offers them.
 *
 * A link is PAID only if it appears here *and* the property lists it, because
 * `property_amenity_link_price_matches_scope` requires a paid link to carry a
 * price above zero and a free one to carry none.
 */
const PAID_AMENITY_PRICING: Record<string, { priceMinor: number; pricingUnit: string }> = {
  'airport-transfer': { priceMinor: rupees(1_500), pricingUnit: 'Per trip' },
  laundry: { priceMinor: rupees(250), pricingUnit: 'Per kg' },
  babysitting: { priceMinor: rupees(600), pricingUnit: 'Per hour' },
  badminton: { priceMinor: rupees(200), pricingUnit: 'Per hour' },
};

/** Offered free by every property in the demo portfolio. */
const UNIVERSAL_FREE_AMENITIES: readonly string[] = [
  '24hr-power-backup',
  '24hr-front-desk',
  '24hr-security',
  'free-wifi',
  'air-conditioning',
  'parking',
  'cctv',
  'first-aid',
];

/* -------------------------------------------------------------------------- */
/*  Policies                                                                  */
/* -------------------------------------------------------------------------- */

const POLICIES: readonly {
  type: PolicyType;
  title: string;
  content: string;
  isMandatory: boolean;
  freeCancellationHours: number | null;
  retentionChargePercent: string | null;
}[] = [
  {
    type: PolicyType.CANCELLATION,
    title: 'Cancellation policy',
    content:
      'Free cancellation up to 48 hours before check-in. Cancellations within ' +
      '48 hours incur a 1 night retention fee.',
    isMandatory: true,
    freeCancellationHours: 48,
    // One night of the tariff, which is 100% of one night rather than 100% of
    // the stay. The structured field is a percentage and the prose names the
    // unit; a cancellation path reading this must apply it to one night.
    retentionChargePercent: '100.00',
  },
  {
    type: PolicyType.AMENDMENT,
    title: 'Amendment policy',
    content:
      'Date amendments allowed subject to rate differences up to 24 hours ' +
      'prior to check-in.',
    isMandatory: true,
    freeCancellationHours: 24,
    retentionChargePercent: null,
  },
  {
    type: PolicyType.HOUSE_RULES,
    title: 'House rules',
    content:
      'A valid government photo ID is mandatory for all adults at check-in, as ' +
      'required by law. Visitors are not permitted in guest rooms after ' +
      '10:00 PM. Smoking is permitted only in designated areas. Pets are not ' +
      'allowed unless the booking states otherwise.',
    isMandatory: true,
    freeCancellationHours: null,
    retentionChargePercent: null,
  },
  {
    type: PolicyType.TERMS_AND_CONDITIONS,
    title: 'Terms and conditions',
    content:
      'A valid government photo ID is mandatory for all adults at check-in. ' +
      'The property reserves the right to refuse accommodation where an ID ' +
      'cannot be produced. Tariffs are per room per night and exclude GST ' +
      'unless stated. Early check-in and late check-out are subject to ' +
      'availability and may be charged.',
    isMandatory: true,
    freeCancellationHours: null,
    retentionChargePercent: null,
  },
];

/* -------------------------------------------------------------------------- */
/*  The ten properties                                                        */
/* -------------------------------------------------------------------------- */

interface RoomTypeSeed {
  code: string;
  name: string;
  description: string;
  maxGuests: number;
  maxAdults: number;
  /** Rupees per night, converted to paise on write. */
  nightlyRate: number;
  /** Physical room numbers in this category. */
  numbers: readonly string[];
}

interface DemoProperty {
  code: string;
  slug: string;
  name: string;
  legalName: string;
  /**
   * The free-text operating region. It carries the property's class and star
   * rating because the schema has no column for either, and this field is
   * explicitly documented as free text that nothing branches on — so it is the
   * one honest place to put a descriptor rather than inventing a column.
   */
  division: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
  email: string;
  /** `HH:MM` wall clock in the property's own timezone. */
  checkInTime: string;
  checkOutTime: string;
  status?: PropertyStatus;
  roomTypes: readonly RoomTypeSeed[];
  /** Amenity slugs this property offers beyond the universal free set. */
  extraAmenities: readonly string[];
}

const DEMO_PROPERTIES: readonly DemoProperty[] = [
  {
    code: '31346',
    slug: 'grand-marine-goa-resort',
    name: 'Grand Marine Goa',
    legalName: 'Grand Marine Hospitality Pvt Ltd',
    division: 'Resort · 5 Star · Goa Coastal',
    addressLine1: 'Survey 112/4, Candolim Beach Road',
    addressLine2: 'Near Sinquerim Fort',
    city: 'Candolim',
    state: 'Goa',
    postalCode: '403515',
    phone: '+91 98221 40112',
    email: 'reservations@grandmarinegoa.example',
    // Luxury resorts take a later check-in and an earlier check-out.
    checkInTime: '14:00',
    checkOutTime: '10:00',
    roomTypes: [
      {
        code: 'DLX',
        name: 'Deluxe Garden Room',
        description: 'Garden-facing room with a private balcony and a king bed.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 6_800,
        numbers: ['101', '102', '103', '104'],
      },
      {
        code: 'SEA',
        name: 'Sea View Premium',
        description: 'Arabian Sea views, walk-out terrace and a rain shower.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 9_400,
        numbers: ['201', '202', '203'],
      },
      {
        code: 'SUITE',
        name: 'Marine Suite',
        description: 'Two-bay suite with a plunge pool and a private deck.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 16_500,
        numbers: ['301', '302'],
      },
      {
        code: 'VILLA',
        name: 'Beach Villa',
        description: 'Standalone villa with direct beach access and a butler.',
        maxGuests: 6,
        maxAdults: 4,
        nightlyRate: 24_000,
        numbers: ['V1', 'V2'],
      },
    ],
    extraAmenities: ['swimming-pool', 'bar', 'on-site-atm', 'airport-transfer', 'laundry', 'babysitting'],
  },
  {
    code: '31347',
    slug: 'shubh-shaleen-springs-ujjain',
    name: 'Shubh Shaleen Springs',
    legalName: 'Shubh Shaleen Hospitality LLP',
    division: 'Boutique Resort & Event Venue · 4 Star · Malwa',
    addressLine1: '42, Mahakal Ring Road',
    addressLine2: 'Opposite Rudra Sagar',
    city: 'Ujjain',
    state: 'Madhya Pradesh',
    postalCode: '456010',
    phone: '+91 98260 71337',
    email: 'frontdesk@shubhshaleensprings.example',
    checkInTime: '12:00',
    checkOutTime: '10:00',
    roomTypes: [
      {
        code: 'STD',
        name: 'Standard Room',
        description: 'Compact twin or double room with a work desk.',
        maxGuests: 2,
        maxAdults: 2,
        nightlyRate: 2_700,
        numbers: ['101', '102', '103', '104'],
      },
      {
        code: 'DLX',
        name: 'Deluxe Room',
        description: 'Larger room overlooking the lawn, with a sofa bed.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 4_200,
        numbers: ['201', '202', '203', '204'],
      },
      {
        code: 'SUP',
        name: 'Superior Room',
        description: 'Corner room with a bay window and a lounge chair.',
        maxGuests: 3,
        maxAdults: 3,
        nightlyRate: 5_600,
        numbers: ['301', '302', '303'],
      },
      {
        code: 'EXEC',
        name: 'Executive Suite',
        description: 'Separate living room, ideal for an event host party.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 8_900,
        numbers: ['401', '402'],
      },
    ],
    extraAmenities: ['swimming-pool', 'on-site-atm', 'badminton', 'laundry', 'airport-transfer'],
  },
  {
    code: '31348',
    slug: 'royal-heritage-haveli-jaipur',
    name: 'The Royal Heritage Haveli',
    legalName: 'Royal Heritage Havelis Pvt Ltd',
    division: 'Heritage Hotel · 4 Star · Rajasthan Forts',
    addressLine1: 'Haveli 7, Gangapole Road',
    addressLine2: 'Near Jal Mahal Approach',
    city: 'Jaipur',
    state: 'Rajasthan',
    postalCode: '302002',
    phone: '+91 98290 41338',
    email: 'stay@royalheritagehaveli.example',
    checkInTime: '12:00',
    checkOutTime: '11:00',
    roomTypes: [
      {
        code: 'HER',
        name: 'Heritage Room',
        description: 'Restored haveli room with frescoed walls and jharokhas.',
        maxGuests: 2,
        maxAdults: 2,
        nightlyRate: 5_400,
        numbers: ['11', '12', '13', '14'],
      },
      {
        code: 'ROYAL',
        name: 'Royal Chamber',
        description: 'High-ceilinged chamber with a four-poster bed.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 7_800,
        numbers: ['21', '22', '23'],
      },
      {
        code: 'MAHAL',
        name: 'Mahal Suite',
        description: 'Courtyard-facing suite with a private sit-out.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 13_500,
        numbers: ['31', '32'],
      },
    ],
    extraAmenities: ['swimming-pool', 'bar', 'laundry', 'airport-transfer'],
  },
  {
    code: '31349',
    slug: 'silicon-valley-suites-bengaluru',
    name: 'Silicon Valley Suites',
    legalName: 'Silicon Valley Serviced Residences Pvt Ltd',
    division: 'Business Apart-Hotel · 4 Star · Karnataka Metro',
    addressLine1: '18, Outer Ring Road, Doddanekkundi',
    addressLine2: 'Near Mahadevapura Metro',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560037',
    phone: '+91 98450 61339',
    email: 'desk@siliconvalleysuites.example',
    checkInTime: '12:00',
    checkOutTime: '11:00',
    roomTypes: [
      {
        code: 'STUDIO',
        name: 'Studio Apartment',
        description: 'Serviced studio with a kitchenette and a work desk.',
        maxGuests: 2,
        maxAdults: 2,
        nightlyRate: 4_800,
        numbers: ['101', '102', '103', '104', '105'],
      },
      {
        code: 'ONEBHK',
        name: 'One-Bedroom Residence',
        description: 'Separate bedroom and living room, weekly rates available.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 7_200,
        numbers: ['201', '202', '203', '204'],
      },
      {
        code: 'EXEC',
        name: 'Executive Suite',
        description: 'Corner residence with a meeting table for four.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 10_400,
        numbers: ['301', '302', '303'],
      },
    ],
    extraAmenities: ['bar', 'on-site-atm', 'laundry', 'airport-transfer', 'babysitting'],
  },
  {
    code: '31350',
    slug: 'misty-heights-retreat-munnar',
    name: 'Misty Heights Retreat',
    legalName: 'Misty Heights Plantations & Resorts Pvt Ltd',
    division: 'Hill Station Resort · 4 Star · Kerala High Range',
    addressLine1: 'Pallivasal Estate, Chithirapuram',
    addressLine2: 'Munnar-Adimali Road',
    city: 'Munnar',
    state: 'Kerala',
    postalCode: '685565',
    phone: '+91 94470 81340',
    email: 'reservations@mistyheightsmunnar.example',
    checkInTime: '14:00',
    checkOutTime: '11:00',
    roomTypes: [
      {
        code: 'VALLEY',
        name: 'Valley View Room',
        description: 'Tea-garden views from a glass-fronted balcony.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 5_900,
        numbers: ['101', '102', '103', '104'],
      },
      {
        code: 'COTTAGE',
        name: 'Plantation Cottage',
        description: 'Timber cottage set inside the estate, with a fireplace.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 8_600,
        numbers: ['C1', 'C2', 'C3'],
      },
      {
        code: 'PREM',
        name: 'Premium Mist Suite',
        description: 'Top-floor suite with a wraparound deck and a tub.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 12_800,
        numbers: ['301', '302'],
      },
    ],
    extraAmenities: ['bar', 'badminton', 'laundry', 'airport-transfer'],
  },
  {
    code: '31351',
    slug: 'ganges-serenity-rishikesh',
    name: 'The Ganges Serenity',
    legalName: 'Ganges Serenity Wellness Resorts Pvt Ltd',
    division: 'Wellness & Spa Resort · 5 Star · Uttarakhand Riverfront',
    addressLine1: 'Neelkanth Marg, Tapovan',
    addressLine2: 'Upstream of Lakshman Jhula',
    city: 'Rishikesh',
    state: 'Uttarakhand',
    postalCode: '249192',
    phone: '+91 94120 51341',
    email: 'wellness@gangesserenity.example',
    checkInTime: '14:00',
    checkOutTime: '10:00',
    roomTypes: [
      {
        code: 'RIVER',
        name: 'River View Room',
        description: 'Ganga-facing room with a yoga mat and a meditation nook.',
        maxGuests: 2,
        maxAdults: 2,
        nightlyRate: 8_200,
        numbers: ['101', '102', '103', '104'],
      },
      {
        code: 'SPA',
        name: 'Spa Pavilion',
        description: 'Pavilion with an in-room treatment table and steam.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 14_500,
        numbers: ['201', '202', '203'],
      },
      {
        code: 'RETREAT',
        name: 'Retreat Suite',
        description: 'Two-room suite for residential wellness programmes.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 21_000,
        numbers: ['301', '302'],
      },
    ],
    extraAmenities: ['swimming-pool', 'on-site-atm', 'laundry', 'airport-transfer', 'babysitting'],
  },
  {
    code: '31352',
    slug: 'urban-vista-residency-mumbai',
    name: 'Urban Vista Residency',
    legalName: 'Urban Vista Hotels Pvt Ltd',
    division: 'Boutique City Hotel · 3 Star · Maharashtra Metro',
    addressLine1: '24, Linking Road, Khar West',
    addressLine2: 'Near Khar Railway Station',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400052',
    phone: '+91 98200 71342',
    email: 'frontoffice@urbanvistamumbai.example',
    checkInTime: '12:00',
    checkOutTime: '11:00',
    roomTypes: [
      {
        code: 'COMPACT',
        name: 'Compact Room',
        description: 'Efficient city room for a single business traveller.',
        // Deliberately under ₹1,000: the one tariff in the portfolio that
        // falls in the exempt band, so the GST banding is visibly exercised
        // rather than every room landing on the same rate.
        maxGuests: 2,
        maxAdults: 2,
        nightlyRate: 950,
        numbers: ['101', '102', '103'],
      },
      {
        code: 'STD',
        name: 'Standard Room',
        description: 'Double room with blackout curtains and a work desk.',
        maxGuests: 2,
        maxAdults: 2,
        nightlyRate: 3_400,
        numbers: ['201', '202', '203', '204'],
      },
      {
        code: 'DLX',
        name: 'Deluxe Room',
        description: 'Street-facing room with a seating bay.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 4_900,
        numbers: ['301', '302', '303'],
      },
    ],
    extraAmenities: ['on-site-atm', 'laundry', 'airport-transfer'],
  },
  {
    code: '31353',
    slug: 'oberoi-palm-cove-alibaug',
    name: 'The Oberoi Palm Cove',
    legalName: 'Palm Cove Luxury Villas Pvt Ltd',
    division: 'Luxury Villa Resort · 5 Star · Konkan Coast',
    addressLine1: 'Awas Beach Road, Survey 61',
    addressLine2: 'Near Mandwa Jetty Road',
    city: 'Alibaug',
    state: 'Maharashtra',
    postalCode: '402201',
    phone: '+91 98331 41343',
    email: 'villas@oberoipalmcove.example',
    checkInTime: '14:00',
    checkOutTime: '10:00',
    roomTypes: [
      {
        code: 'GARDEN',
        name: 'Garden Villa',
        description: 'One-bedroom villa with an enclosed garden and outdoor bath.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 18_500,
        numbers: ['G1', 'G2', 'G3'],
      },
      {
        code: 'POOL',
        name: 'Private Pool Villa',
        description: 'Villa with a heated private pool and a sun deck.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 27_000,
        numbers: ['P1', 'P2', 'P3'],
      },
      {
        code: 'COVE',
        name: 'Cove Residence',
        description: 'Two-bedroom beachfront residence with a chef on call.',
        maxGuests: 6,
        maxAdults: 4,
        nightlyRate: 42_000,
        numbers: ['R1', 'R2'],
      },
    ],
    extraAmenities: ['swimming-pool', 'bar', 'laundry', 'airport-transfer', 'babysitting'],
  },
  {
    code: '31354',
    slug: 'taj-gateway-pines-manali',
    name: 'Taj Gateway Pines',
    legalName: 'Gateway Pines Mountain Lodges Pvt Ltd',
    division: 'Mountain Lodge · 4 Star · Himachal Hills',
    addressLine1: 'Log Hut Area, Old Manali',
    addressLine2: 'Above Manalsu Nala',
    city: 'Manali',
    state: 'Himachal Pradesh',
    postalCode: '175131',
    phone: '+91 94180 61344',
    email: 'lodge@tajgatewaypines.example',
    checkInTime: '12:00',
    checkOutTime: '11:00',
    status: PropertyStatus.ONBOARDING,
    roomTypes: [
      {
        code: 'PINE',
        name: 'Pine View Room',
        description: 'Deodar-facing room with a wood-panelled interior.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 4_600,
        numbers: ['101', '102', '103', '104'],
      },
      {
        code: 'LODGE',
        name: 'Lodge Room',
        description: 'Ground-floor room opening onto the orchard.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 6_100,
        numbers: ['201', '202', '203'],
      },
      {
        code: 'ALPINE',
        name: 'Alpine Suite',
        description: 'Attic suite with a log fire and a snow-view dormer.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 11_200,
        numbers: ['301', '302'],
      },
    ],
    extraAmenities: ['bar', 'badminton', 'laundry', 'airport-transfer'],
  },
  {
    code: '31355',
    slug: 'lakeview-oasis-udaipur',
    name: 'The Lakeview Oasis',
    legalName: 'Lakeview Oasis Palace Homestays LLP',
    division: 'Palace & Homestay · 4 Star · Rajasthan Lakes',
    addressLine1: 'Hanuman Ghat, Outside Chandpole',
    addressLine2: 'West Bank of Lake Pichola',
    city: 'Udaipur',
    state: 'Rajasthan',
    postalCode: '313001',
    phone: '+91 94140 51345',
    email: 'hello@lakeviewoasis.example',
    checkInTime: '12:00',
    checkOutTime: '11:00',
    roomTypes: [
      {
        code: 'HOME',
        name: 'Homestay Room',
        description: 'Family-run room on the ghat, breakfast with the hosts.',
        maxGuests: 2,
        maxAdults: 2,
        nightlyRate: 2_300,
        numbers: ['101', '102', '103', '104'],
      },
      {
        code: 'LAKE',
        name: 'Lake View Room',
        description: 'Pichola-facing room with a cushioned window seat.',
        maxGuests: 3,
        maxAdults: 2,
        nightlyRate: 5_100,
        numbers: ['201', '202', '203'],
      },
      {
        code: 'PALACE',
        name: 'Palace Suite',
        description: 'Terrace suite looking across to the Lake Palace.',
        maxGuests: 4,
        maxAdults: 3,
        nightlyRate: 9_700,
        numbers: ['301', '302'],
      },
    ],
    extraAmenities: ['bar', 'on-site-atm', 'laundry', 'airport-transfer'],
  },
];

/* -------------------------------------------------------------------------- */
/*  Reservations                                                              */
/* -------------------------------------------------------------------------- */

interface ReservationSeed {
  /** Suffix of the confirmation code, so it is stable across re-runs. */
  ref: string;
  status: ReservationStatus;
  source: BookingSource;
  mealPlan: MealPlan;
  /** Days from the property's business date. Negative is in the past. */
  arrivalOffset: number;
  departureOffset: number;
  guestFirst: string;
  guestLast: string;
  email: string;
  phone: string;
  adults: number;
  children: number;
  /** Fraction of the stay total already collected, 0 to 1. */
  advanceFraction: number;

  /* -- Master-report columns ------------------------------------------- */

  /**
   * Everything below exists so the master report's sixty-five columns have
   * something to show in a demo database.
   *
   * ===========================================================================
   * Seeded, not faked at render time.
   *
   * These are real columns, added by `20261019140000_master_report_columns`,
   * and the report reads them exactly as it reads a room rate. The difference
   * matters: a production property that has recorded no OTA commission shows
   * zero, truthfully, because nothing invents a figure on the way out. Only
   * this seed — which already fabricates guests, addresses and photographs —
   * puts values in them.
   *
   * The modules that will own these writes do not exist yet: `channels` for
   * the OTA settlement figures, a promotions module for the coupon, the
   * folio's deposits tab for the deposit. Until they land the seed is the only
   * writer, the same position `checkedInAt` was in before the front desk.
   * ===========================================================================
   */

  /** Market segment, as a revenue manager would classify the booking. */
  segment: string;
  /** The operator's own reference, where the booking came with one. */
  bookingReferenceId?: string;
  /** Arrived with little or no luggage — a credit-risk note from the desk. */
  scantyBaggage?: boolean;
  /** A stay given free of charge, and why. */
  complimentary?: { remarks: string };
  /**
   * The channel's cut, as fractions of the stay total.
   *
   * Only meaningful on an OTA booking; a direct one leaves them out and the
   * columns read zero, which is true rather than unknown. `prepaid` is the
   * part the guest paid the channel, which the property never receives and
   * must not count as its own takings.
   */
  ota?: { commissionRate: number; taxRate: number; prepaidRate: number };
  /** A promotion applied at booking: the code, and what it took off. */
  promo?: { code: string; rate: number };
  /** A refundable security deposit held against the stay, in rupees. */
  depositRupees?: number;
  /** Card instrument detail, where the advance was taken on a card. */
  card?: { last4: string; issuer: string };
  /** The advance was collected by the channel rather than at this desk. */
  paidByExternalSource?: boolean;

  /** The channel's own booking number, for an OTA reservation. */
  otaBookingId?: string;
  /** Billed to a corporate account, which carries the GSTIN. */
  corporate?: boolean;
  /** Infants in the party, who occupy no bed. */
  infants?: number;
  /** The registered guest's full detail, for the guest-column block. */
  guestDetail?: {
    addressLine1: string;
    addressLine2: string;
    postalCode: string;
    govtIdType: GovtIdType;
    govtIdNumber: string;
    specialRequest: string;
  };
  /** An extra charged on the folio: a restaurant bill, a laundry docket. */
  service?: { description: string; rupees: number };
  /** Part of the advance taken in cash over the desk. */
  cashRupees?: number;
  /** A refund posted back to the guest. */
  refundRupees?: number;
}

/**
 * Five stays per property, spanning the states the screens have to render.
 *
 * ===========================================================================
 * Chosen so each board has something real on it.
 *
 * `CHECKED_IN` gives the arrivals board an in-house guest and the housekeeping
 * board an occupied room; `CONFIRMED` arriving today gives it an expected
 * arrival; `ON_HOLD` gives the hold-release path something to release;
 * `CONFIRMED` in the future gives the calendar a forward block; and a
 * `CHECKED_OUT` stay gives the folio screens a settled bill to read.
 *
 * Offsets are relative to each property's own business date, not to `now()`.
 * Ten properties can sit on ten different business dates, and a seed that
 * anchored on the machine clock would put a stay "today" at a property whose
 * books closed yesterday (CLAUDE.md section 3.3).
 * ===========================================================================
 */
const RESERVATIONS: readonly ReservationSeed[] = [
  {
    ref: 'A01',
    status: ReservationStatus.CHECKED_IN,
    source: BookingSource.DIRECT_WEB,
    mealPlan: MealPlan.CP,
    arrivalOffset: -1,
    departureOffset: 2,
    guestFirst: 'Siddharth',
    guestLast: 'Jain',
    email: 'siddharth.jain@example.com',
    phone: '+91 98765 43210',
    adults: 2,
    children: 0,
    advanceFraction: 0.4,
    // Direct: no channel cut, so the OTA columns read zero rather than
    // carrying a commission nobody charged.
    segment: 'Leisure',
    promo: { code: 'MONSOON15', rate: 0.15 },
    depositRupees: 2_000,
    card: { last4: '4242', issuer: 'HDFC Bank' },
    infants: 1,
    guestDetail: {
      addressLine1: 'B-402, Sunrise Residency',
      addressLine2: 'Linking Road, Bandra West',
      postalCode: '400050',
      govtIdType: GovtIdType.AADHAAR,
      // A test-pattern number, not a valid Aadhaar. The report masks it to
      // the last four digits regardless, so this is never shown whole.
      govtIdNumber: '9999 8888 7777',
      specialRequest: 'High floor, away from the lift. Early breakfast at 6am.',
    },
    service: { description: 'Restaurant — dinner for two', rupees: 2_400 },
  },
  {
    ref: 'A02',
    status: ReservationStatus.CHECKED_IN,
    source: BookingSource.MAKEMYTRIP,
    mealPlan: MealPlan.MAP,
    arrivalOffset: 0,
    departureOffset: 3,
    guestFirst: 'Ananya',
    guestLast: 'Reddy',
    email: 'ananya.reddy@example.com',
    phone: '+91 99876 54321',
    adults: 2,
    children: 1,
    advanceFraction: 1,
    segment: 'OTA',
    bookingReferenceId: 'MMT-REF-884210',
    // Paid to the channel in full, so the property collects nothing at the
    // desk and the external-source column is where the money shows.
    ota: { commissionRate: 0.18, taxRate: 0.18, prepaidRate: 1 },
    paidByExternalSource: true,
    scantyBaggage: true,
    otaBookingId: 'MMT-8842107731',
    guestDetail: {
      addressLine1: 'Flat 12, Jubilee Enclave',
      addressLine2: 'HITEC City',
      postalCode: '500081',
      govtIdType: GovtIdType.PASSPORT,
      govtIdNumber: 'Z1234567',
      specialRequest: 'Cot for the infant. Vegetarian meals only.',
    },
    service: { description: 'Laundry — 4 kg', rupees: 1_000 },
    refundRupees: 500,
  },
  {
    ref: 'A03',
    status: ReservationStatus.CONFIRMED,
    source: BookingSource.BOOKING_COM,
    mealPlan: MealPlan.EP,
    arrivalOffset: 0,
    departureOffset: 2,
    guestFirst: 'Rohan',
    guestLast: 'Mehta',
    email: 'rohan.mehta@example.com',
    phone: '+91 98111 22334',
    adults: 1,
    children: 0,
    advanceFraction: 0.25,
    segment: 'OTA',
    bookingReferenceId: 'BDC-4471902',
    ota: { commissionRate: 0.15, taxRate: 0.18, prepaidRate: 0.25 },
    paidByExternalSource: true,
    card: { last4: '1881', issuer: 'Visa' },
    otaBookingId: 'BDC-4471902-2',
  },
  {
    ref: 'A04',
    status: ReservationStatus.ON_HOLD,
    source: BookingSource.PHONE,
    mealPlan: MealPlan.CP,
    arrivalOffset: 4,
    departureOffset: 6,
    guestFirst: 'Priya',
    guestLast: 'Nair',
    email: 'priya.nair@example.com',
    phone: '+91 97400 11223',
    adults: 2,
    children: 0,
    // A hold has taken no money. That is the point of a hold, and it is what
    // the auto-release path looks for.
    advanceFraction: 0,
    segment: 'Group',
    // A complimentary stay, so the flag and its reason have something to
    // show. The remark is constrained to complimentary bookings by
    // `reservation_complimentary_remarks_need_complimentary`.
    complimentary: { remarks: 'Site inspection — authorised by the GM' },
  },
  {
    ref: 'A05',
    status: ReservationStatus.CONFIRMED,
    source: BookingSource.CORPORATE,
    mealPlan: MealPlan.EP,
    arrivalOffset: 7,
    departureOffset: 9,
    guestFirst: 'Vikram',
    guestLast: 'Singh',
    email: 'vikram.singh@example.com',
    phone: '+91 98300 44556',
    adults: 1,
    children: 0,
    advanceFraction: 0.5,
    segment: 'Corporate',
    bookingReferenceId: 'PO-2026-00417',
    depositRupees: 5_000,
    // Billed to a company, which is where the GST number on the invoice
    // comes from.
    corporate: true,
    cashRupees: 1_500,
  },
  {
    /**
     * A departed stay.
     *
     * Here so `actualCheckOut` and a CLOSED folio have something behind them.
     * Entirely in the past, so it sits inside the inventory window the
     * calendar builds and its room is free again today.
     */
    ref: 'A07',
    status: ReservationStatus.CHECKED_OUT,
    source: BookingSource.WALK_IN,
    mealPlan: MealPlan.EP,
    arrivalOffset: -4,
    departureOffset: -1,
    guestFirst: 'Arjun',
    guestLast: 'Desai',
    email: 'arjun.desai@example.com',
    phone: '+91 99300 55667',
    adults: 2,
    children: 0,
    advanceFraction: 1,
    segment: 'Walk-in',
    cashRupees: 3_000,
    guestDetail: {
      addressLine1: '7, Shivaji Park',
      addressLine2: 'Dadar West',
      postalCode: '400028',
      govtIdType: GovtIdType.DRIVING_LICENSE,
      govtIdNumber: 'MH0120211234567',
      specialRequest: 'Late checkout if available.',
    },
  },
];

/**
 * One cancelled booking per property, so the cancel-date column and the
 * CANCELLED badge have something real behind them.
 *
 * Separate from the five above because a cancellation is not a stay: it holds
 * no inventory, occupies no room and opens no folio, and threading those
 * exceptions through the main loop would make every one of them conditional.
 */
const CANCELLED_RESERVATION: ReservationSeed & { cancelledDaysAgo: number } = {
  ref: 'A06',
  status: ReservationStatus.CANCELLED,
  source: BookingSource.AGODA,
  mealPlan: MealPlan.EP,
  arrivalOffset: 3,
  departureOffset: 5,
  guestFirst: 'Neha',
  guestLast: 'Kapoor',
  email: 'neha.kapoor@example.com',
  phone: '+91 98200 33445',
  adults: 2,
  children: 0,
  advanceFraction: 0,
  segment: 'OTA',
  bookingReferenceId: 'AGD-77310',
  ota: { commissionRate: 0.17, taxRate: 0.18, prepaidRate: 0 },
  cancelledDaysAgo: 1,
};

/**
 * GST state codes for the states this portfolio sits in.
 *
 * The first two digits of a GSTIN are the state code, so a number that does
 * not start with the right pair is invalid on its face — which is exactly the
 * kind of detail a demo invoice should get right rather than approximate.
 */
const GST_STATE_CODES: Record<string, string> = {
  Goa: '30',
  'Madhya Pradesh': '23',
  Rajasthan: '08',
  Karnataka: '29',
  Kerala: '32',
  Uttarakhand: '05',
  Maharashtra: '27',
  'Himachal Pradesh': '02',
};

/**
 * The corporate account a company-billed stay is charged to.
 *
 * ===========================================================================
 * Upserted on the GSTIN, which is unique per property.
 *
 * `Company` is where a GST number legitimately lives — a hotel's own GSTIN is
 * a different thing from a corporate client's, and this column is the client's.
 * The master report's "Company GST no." reads through the booking's
 * `companyId`, so without one of these the column is blank on every row.
 *
 * The number is a well-formed test pattern: correct state code, correct
 * 15-character shape, and plainly not a real registration.
 * ===========================================================================
 */
async function upsertDemoCompany(
  prisma: PrismaClient,
  propertyId: string,
  seed: DemoProperty,
): Promise<string | null> {
  const stateCode = GST_STATE_CODES[seed.state];
  if (stateCode === undefined) return null;

  const gstin = `${stateCode}AABCD1234E1Z${seed.code.slice(-1)}`;
  const legalName = `${seed.city} Business Travel Pvt Ltd`;

  const company = await prisma.company.upsert({
    where: { company_unique_gstin_per_property: { propertyId, gstin } },
    create: {
      propertyId,
      legalName,
      tradeName: `${seed.city} Business Travel`,
      gstin,
      addressLine1: '1st Floor, Corporate Plaza',
      city: seed.city,
      state: seed.state,
      postalCode: seed.postalCode,
      email: `accounts@${seed.slug}-corp.example`,
      phone: seed.phone,
    },
    update: { legalName },
    select: { id: true },
  });

  return company.id;
}

/**
 * The master-report columns for one seeded booking.
 *
 * ===========================================================================
 * Rates in the fixture, integer minor units in the database.
 *
 * The fixtures carry commission and promo as *fractions* because that is how a
 * contract states them — "18% of the booking value" — and the stored figure is
 * the rupee amount that rate produced. Rounded once, here, so the column a
 * finance team sums is the number that was charged rather than a rate they
 * would have to re-apply (CLAUDE.md section 3.4).
 *
 * Absent fixture fields produce absent keys rather than zeroes, so the column
 * defaults apply and `exactOptionalPropertyTypes` stays satisfied.
 * ===========================================================================
 */
function masterReportFields(
  stay: ReservationSeed & { cancelledDaysAgo?: number },
  totalMinor: number,
  businessDate: Date,
): Record<string, unknown> {
  const ota = stay.ota;
  const promo = stay.promo;

  return {
    segment: stay.segment,
    ...(stay.bookingReferenceId === undefined
      ? {}
      : { bookingReferenceId: stay.bookingReferenceId }),
    ...(stay.scantyBaggage === true ? { scantyBaggage: true } : {}),
    ...(stay.complimentary === undefined
      ? {}
      : { isComplimentary: true, complimentaryRemarks: stay.complimentary.remarks }),

    ...(ota === undefined
      ? {}
      : {
          otaPrepaidAmountMinor: Math.round(totalMinor * ota.prepaidRate),
          otaCommissionMinor: Math.round(totalMinor * ota.commissionRate),
          // GST on the commission, not on the stay — the channel invoices the
          // property for its fee and charges tax on that fee.
          otaTaxMinor: Math.round(totalMinor * ota.commissionRate * ota.taxRate),
          // What the channel actually remits: the booking less its fee and the
          // tax on that fee. Stored rather than derived, because a real
          // channel's remittance will not always equal this arithmetic and the
          // column exists to expose exactly that gap.
          otaNetAmountMinor:
            totalMinor -
            Math.round(totalMinor * ota.commissionRate) -
            Math.round(totalMinor * ota.commissionRate * ota.taxRate),
        }),

    // Both or neither: `reservation_promo_code_matches_amount` rejects a code
    // with no discount and a discount with no code.
    ...(promo === undefined
      ? {}
      : {
          appliedCouponCode: promo.code,
          promoAmountMinor: Math.round(totalMinor * promo.rate),
        }),

    ...(stay.depositRupees === undefined
      ? {}
      : { depositMinor: rupees(stay.depositRupees) }),

    // Only on a cancelled booking — `reservation_cancelled_at_matches_status`
    // rejects it otherwise.
    ...(stay.cancelledDaysAgo === undefined
      ? {}
      : {
          cancelledAt: new Date(
            businessDate.getTime() - stay.cancelledDaysAgo * DAY_MS + 11 * 3_600_000,
          ),
        }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Date helpers                                                              */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

/** Today in a property's own timezone, as a UTC-midnight calendar date. */
function businessDateFor(timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${parts}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/* -------------------------------------------------------------------------- */
/*  Seeding                                                                   */
/* -------------------------------------------------------------------------- */

export interface PortfolioCounters {
  properties: number;
  roomTypes: number;
  rooms: number;
  media: number;
  slabs: number;
  amenityLinks: number;
  policies: number;
  inventoryDays: number;
  reservations: number;
  folios: number;
  folioLines: number;
  grants: number;
}

/**
 * Upserts the portfolio-wide amenity catalogue.
 *
 * Keyed on `slug`, so an amenity the reference portfolio already created keeps
 * its id and every existing link to it stays valid. Returns the ids so the
 * per-property links can be written without re-querying.
 */
async function createAmenities(prisma: PrismaClient): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const amenity of AMENITY_CATALOGUE) {
    const row = await prisma.amenity.upsert({
      where: { slug: amenity.slug },
      create: amenity,
      update: {
        name: amenity.name,
        groupName: amenity.groupName,
        iconName: amenity.iconName,
      },
      select: { id: true },
    });
    ids.set(amenity.slug, row.id);
  }

  return ids;
}

/** The property row itself, plus its settings. */
async function seedPropertyMaster(
  prisma: PrismaClient,
  seed: DemoProperty,
): Promise<{ id: string; businessDate: Date }> {
  const businessDate = businessDateFor('Asia/Kolkata');

  const shared = {
    slug: seed.slug,
    name: seed.name,
    legalName: seed.legalName,
    division: seed.division,
    logoUrl: imageUrl(`${seed.slug}-logo`, 256, 256),
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
    checkInTime: seed.checkInTime,
    checkOutTime: seed.checkOutTime,
    addressLine1: seed.addressLine1,
    addressLine2: seed.addressLine2,
    city: seed.city,
    state: seed.state,
    postalCode: seed.postalCode,
    countryCode: 'IN',
    phone: seed.phone,
    email: seed.email,
    status: seed.status ?? PropertyStatus.ACTIVE,
    /**
     * Null, so the banded slab table is what prices a room.
     *
     * The flat column is a fallback for a property with no slabs, and leaving
     * it set would make these ten properties the only ones whose rate did not
     * come from `property_tax_slab` — which is the thing being demonstrated.
     */
    taxRatePercent: null,
  };

  const property = await prisma.property.upsert({
    where: { code: seed.code },
    // `businessDate` is only set on create. Advancing it is the night audit's
    // job and nothing else's (section 3.3); a re-run must not roll a property's
    // books back to today because the seed happens to be running.
    create: { code: seed.code, businessDate, ...shared },
    update: shared,
    select: { id: true, businessDate: true },
  });

  await prisma.propertySettings.upsert({
    where: { propertyId: property.id },
    create: {
      propertyId: property.id,
      standardCheckInTime: seed.checkInTime,
      standardCheckOutTime: seed.checkOutTime,
      turnaroundGraceMins: 60,
      bookingPrefix: 'SFBOOKING_',
      folioPrefix: 'FOL_',
      invoicePrefix: 'INV_',
      autoHoldReleaseHours: 4,
      nightAuditHour: '02:00',
    },
    update: {
      standardCheckInTime: seed.checkInTime,
      standardCheckOutTime: seed.checkOutTime,
      turnaroundGraceMins: 60,
      bookingPrefix: 'SFBOOKING_',
      folioPrefix: 'FOL_',
      invoicePrefix: 'INV_',
      autoHoldReleaseHours: 4,
      nightAuditHour: '02:00',
    },
    select: { id: true },
  });

  return property;
}

/** The GST bands, keyed on the floor so a re-run converges. */
async function seedTaxSlabs(prisma: PrismaClient, propertyId: string): Promise<number> {
  for (const slab of TAX_SLABS) {
    await prisma.propertyTaxSlab.upsert({
      where: {
        propertyId_minTariffMinor: { propertyId, minTariffMinor: slab.minTariffMinor },
      },
      create: { propertyId, ...slab },
      update: {
        slabName: slab.slabName,
        maxTariffMinor: slab.maxTariffMinor,
        taxRatePercent: slab.taxRatePercent,
        cgstRatePercent: slab.cgstRatePercent,
        sgstRatePercent: slab.sgstRatePercent,
      },
      select: { id: true },
    });
  }
  return TAX_SLABS.length;
}

/** Which amenities this property offers, and at what price. */
async function seedAmenityLinks(
  prisma: PrismaClient,
  propertyId: string,
  seed: DemoProperty,
  amenityIds: Map<string, string>,
): Promise<number> {
  const slugs = [...UNIVERSAL_FREE_AMENITIES, ...seed.extraAmenities];
  let count = 0;

  for (const slug of slugs) {
    const amenityId = amenityIds.get(slug);
    if (amenityId === undefined) {
      throw new Error(`Property ${seed.code} lists unseeded amenity "${slug}".`);
    }

    // Paid only where there is a price for it. The CHECK constraint requires a
    // paid link to carry one and a free link not to, so the scope is derived
    // from the pricing table rather than stated twice.
    const paid = PAID_AMENITY_PRICING[slug];
    const data = {
      scope: paid === undefined ? AmenityScope.FREE : AmenityScope.PAID,
      priceMinor: paid?.priceMinor ?? 0,
      pricingUnit: paid?.pricingUnit ?? null,
    };

    await prisma.propertyAmenityLink.upsert({
      where: { propertyId_amenityId: { propertyId, amenityId } },
      create: { propertyId, amenityId, ...data },
      update: data,
      select: { id: true },
    });
    count += 1;
  }

  return count;
}

/**
 * The published policies.
 *
 * Replaced wholesale for this property, because a policy has no natural key —
 * matching on the title would turn a reworded policy into a second one sitting
 * beside the original. Scoped to `propertyId`, so no other property's policies
 * are in scope.
 */
async function seedPolicies(prisma: PrismaClient, propertyId: string): Promise<number> {
  await prisma.propertyPolicy.deleteMany({ where: { propertyId } });
  await prisma.propertyPolicy.createMany({
    data: POLICIES.map((policy) => ({ propertyId, ...policy })),
  });
  return POLICIES.length;
}

/** Room categories and their physical rooms. */
async function seedRooms(
  prisma: PrismaClient,
  propertyId: string,
  seed: DemoProperty,
): Promise<{
  roomTypeIds: Map<string, string>;
  roomIdsByType: Map<string, string[]>;
  roomTypes: number;
  rooms: number;
}> {
  const roomTypeIds = new Map<string, string>();
  const roomIdsByType = new Map<string, string[]>();
  let rooms = 0;

  for (const [index, type] of seed.roomTypes.entries()) {
    const shared = {
      name: type.name,
      description: type.description,
      maxGuests: type.maxGuests,
      maxAdults: type.maxAdults,
      baseRateMinor: rupees(type.nightlyRate),
      currency: 'INR',
      overbookingAllowance: 0,
      sortOrder: index,
    };

    const roomType = await prisma.roomType.upsert({
      where: { room_type_unique_code_per_property: { propertyId, code: type.code } },
      create: { propertyId, code: type.code, ...shared },
      update: shared,
      select: { id: true },
    });
    roomTypeIds.set(type.code, roomType.id);

    const sellable: string[] = [];

    for (const [position, number] of type.numbers.entries()) {
      /**
       * Mixed housekeeping states, deterministically.
       *
       * The brief asked for CLEAN, DIRTY and INSPECTED; the enum spells these
       * VACANT_CLEAN, VACANT_DIRTY and INSPECTED, and a room's state also has
       * to say whether it is occupied — which the check-in below sets. These
       * are the *starting* states, so the housekeeping board is not uniform.
       */
      const status =
        position % 4 === 1
          ? RoomStatus.VACANT_DIRTY
          : position % 4 === 2
            ? RoomStatus.INSPECTED
            : RoomStatus.VACANT_CLEAN;

      const room = await prisma.room.upsert({
        where: { room_unique_number_per_property: { propertyId, number } },
        update: { roomTypeId: roomType.id, status },
        create: {
          propertyId,
          roomTypeId: roomType.id,
          number,
          // "201" is floor 2; a villa numbered "V1" has no floor to infer, and
          // guessing one would put it on an imaginary storey.
          floor: /^\d{3}$/.test(number) ? number.slice(0, 1) : null,
          status,
        },
        select: { id: true },
      });

      sellable.push(room.id);
      rooms += 1;
    }

    roomIdsByType.set(type.code, sellable);
  }

  return { roomTypeIds, roomIdsByType, roomTypes: seed.roomTypes.length, rooms };
}

/**
 * The photograph catalogue.
 *
 * Meets the setup minimums the brief lists: four exteriors, two reception, two
 * interior, one of each amenity area, and a bedroom and washroom shot per room
 * category. Replaced wholesale for this property so a re-run does not stack up
 * duplicate rows — media has no natural key either.
 */
async function seedMedia(
  prisma: PrismaClient,
  propertyId: string,
  seed: DemoProperty,
  roomTypeIds: Map<string, string>,
): Promise<number> {
  await prisma.propertyMedia.deleteMany({ where: { propertyId } });

  const rows: {
    propertyId: string;
    category: MediaCategory;
    url: string;
    caption: string;
    sortOrder: number;
    isFeatured: boolean;
    roomTypeId: string | null;
  }[] = [];

  let sortOrder = 0;
  const push = (
    category: MediaCategory,
    shot: string,
    caption: string,
    roomTypeId: string | null = null,
  ) => {
    rows.push({
      propertyId,
      category,
      url: imageUrl(`${seed.slug}-${shot}`),
      caption,
      sortOrder: sortOrder,
      // The first exterior is the card image on the group dashboard.
      isFeatured: sortOrder === 0,
      roomTypeId,
    });
    sortOrder += 1;
  };

  push(MediaCategory.EXTERIOR, 'exterior-front', `${seed.name} — main entrance`);
  push(MediaCategory.EXTERIOR, 'exterior-facade', `${seed.name} — facade`);
  push(MediaCategory.EXTERIOR, 'exterior-evening', `${seed.name} — evening view`);
  push(MediaCategory.EXTERIOR, 'exterior-approach', `${seed.name} — approach road`);

  push(MediaCategory.RECEPTION, 'reception-desk', 'Front desk');
  push(MediaCategory.RECEPTION, 'reception-lobby', 'Reception lobby');

  push(MediaCategory.INTERIOR, 'interior-lounge', 'Guest lounge');
  push(MediaCategory.INTERIOR, 'interior-corridor', 'Corridor and seating');

  push(MediaCategory.AMENITY_POOL, 'amenity-pool', 'Swimming pool');
  push(MediaCategory.AMENITY_BANQUET, 'amenity-banquet', 'Banquet hall');
  push(MediaCategory.AMENITY_GARDEN, 'amenity-garden', 'Garden and lawn');
  push(MediaCategory.PARKING, 'parking', 'On-site parking');
  push(MediaCategory.RESTAURANT, 'restaurant', 'Restaurant');

  for (const type of seed.roomTypes) {
    const roomTypeId = roomTypeIds.get(type.code) ?? null;
    push(
      MediaCategory.ROOM_BEDROOM,
      `room-${type.code.toLowerCase()}-bedroom`,
      `${type.name} — bedroom`,
      roomTypeId,
    );
    push(
      MediaCategory.ROOM_WASHROOM,
      `room-${type.code.toLowerCase()}-washroom`,
      `${type.name} — washroom`,
      roomTypeId,
    );
  }

  await prisma.propertyMedia.createMany({ data: rows });
  return rows.length;
}

/**
 * The per-date availability calendar.
 *
 * `physical` is the number of sellable rooms in the category, and `sold` starts
 * at zero — the reservations below increment it inside their own transactions,
 * exactly as the booking path does, so the oversell CHECK is live while the
 * fixtures are written and a contradictory fixture fails the seed rather than
 * producing impossible data (CLAUDE.md section 3.1).
 */
async function seedInventory(
  prisma: PrismaClient,
  propertyId: string,
  businessDate: Date,
  roomTypeIds: Map<string, string>,
  roomIdsByType: Map<string, string[]>,
): Promise<number> {
  const from = addDays(businessDate, -7);
  const to = addDays(businessDate, 120);

  // Owned entirely by this property's seed, so a wholesale rebuild is both
  // correct and far cheaper than upserting ~1,500 rows one at a time.
  await prisma.inventoryDay.deleteMany({ where: { propertyId } });

  const rows: {
    propertyId: string;
    roomTypeId: string;
    stayDate: Date;
    physical: number;
    sold: number;
    blocked: number;
    overbookingAllowance: number;
  }[] = [];

  for (const [code, roomTypeId] of roomTypeIds) {
    const physical = (roomIdsByType.get(code) ?? []).length;

    for (let cursor = from.getTime(); cursor <= to.getTime(); cursor += DAY_MS) {
      rows.push({
        propertyId,
        roomTypeId,
        stayDate: new Date(cursor),
        physical,
        sold: 0,
        blocked: 0,
        overbookingAllowance: 0,
      });
    }
  }

  await prisma.inventoryDay.createMany({ data: rows });
  return rows.length;
}

/**
 * Re-marks the rooms that in-house guests are occupying.
 *
 * ===========================================================================
 * The same re-run bug as `deriveSoldForProperty`, one table along.
 *
 * `seedRooms` resets every room's housekeeping status on each run — it owns the
 * physical layout — and `seedReservationsAndFolios` skips stays it has already
 * seeded, so it never re-applies occupancy. The second run therefore left
 * twenty in-house guests in rooms marked vacant, which is the state the
 * housekeeping board and the arrivals board both read.
 *
 * Derived from the assignments rather than remembered, for the same reason as
 * the inventory counters: an occupancy flag that is written once and reset by
 * something else is a flag that eventually lies.
 *
 * `OCCUPIED_DIRTY` rather than `OCCUPIED_CLEAN`, because that is what the
 * check-in path sets — a room becomes dirty the moment someone is in it.
 * ===========================================================================
 */
async function deriveRoomOccupancyForProperty(
  prisma: PrismaClient,
  propertyId: string,
  businessDate: Date,
): Promise<void> {
  const inHouse = await prisma.reservationRoom.findMany({
    where: {
      propertyId,
      status: ReservationStatus.CHECKED_IN,
      roomId: { not: null },
      arrivalDate: { lte: businessDate },
      departureDate: { gt: businessDate },
    },
    select: { roomId: true },
  });

  const roomIds = inHouse
    .map((assignment) => assignment.roomId)
    .filter((id): id is string => id !== null);
  if (roomIds.length === 0) return;

  await prisma.room.updateMany({
    where: { propertyId, id: { in: roomIds } },
    data: { status: RoomStatus.OCCUPIED_DIRTY },
  });
}

/**
 * Re-derives `sold` for one property from its committed bookings.
 *
 * ===========================================================================
 * This exists because of a bug the second seed run exposed.
 *
 * `seedInventory` rebuilds the calendar with `sold = 0`, and
 * `seedReservationsAndFolios` skips stays it has already seeded. So on a second
 * run the counters were zeroed while fifty reservations stayed where they were,
 * and `inventory_day` then disagreed with the bookings permanently — the exact
 * failure the reference seed's own comment warns about.
 *
 * Deriving rather than re-incrementing is strictly more trustworthy: this is
 * the same query that audits the counters for consistency, so by construction
 * the two cannot disagree. `inventory_day_not_oversold` still rejects the
 * result if it would oversell, so a contradictory fixture fails the seed.
 *
 * **`ON_HOLD` counts here.** A hold that did not consume availability would be
 * nothing to release, which makes `autoHoldReleaseHours` meaningless. Note the
 * reference portfolio's `deriveSoldFromReservations` in `seed.ts` counts only
 * CONFIRMED, CHECKED_IN and CHECKED_OUT — so a held room there is still sold as
 * available. That looks wrong, but changing it would re-derive the counters for
 * 882 existing reservations, which is not this script's call to make.
 *
 * Scoped to one property and parameterised. Raw SQL because this is a
 * correlated aggregate update, which Prisma cannot express (CLAUDE.md section
 * 2 permits `$executeRaw` for exactly that).
 * ===========================================================================
 */
async function deriveSoldForProperty(
  prisma: PrismaClient,
  propertyId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "inventory_day" AS i
    SET "sold" = COALESCE(e.n, 0)
    FROM (
      SELECT
        i2."id",
        (
          SELECT count(*)
          FROM "reservation_room" rr
          JOIN "reservation" res ON res."id" = rr."reservationId"
          WHERE rr."propertyId" = i2."propertyId"
            AND rr."roomTypeId" = i2."roomTypeId"
            AND res."status" IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'ON_HOLD')
            AND rr."arrivalDate" <= i2."stayDate"
            AND rr."departureDate" > i2."stayDate"
        ) AS n
      FROM "inventory_day" i2
      WHERE i2."propertyId" = ${propertyId}::uuid
    ) AS e
    WHERE i."id" = e."id" AND i."sold" <> COALESCE(e.n, 0)
  `;
}

/**
 * Reservations, their room assignments, folios and opening balances.
 *
 * ===========================================================================
 * Each stay is written in ONE transaction, as the real booking path does.
 *
 * Reservation, room assignment, inventory increment, folio and folio lines all
 * commit together. Seeding them separately would leave windows where a room is
 * occupied but still counted available — the state the oversell CHECK exists to
 * make impossible — and a half-built folio whose balance is wrong.
 *
 * The folio is built the way the check-in path builds one: a ROOM_CHARGE line
 * per night at the agreed nightly rate, a TAX child line hanging off each one
 * carrying the banded GST for that night, and a single PAYMENT line for the
 * advance. Nothing stores a balance — it is the sum of the lines (section 3.4).
 * ===========================================================================
 */
async function seedReservationsAndFolios(
  prisma: PrismaClient,
  propertyId: string,
  seed: DemoProperty,
  businessDate: Date,
  roomTypeIds: Map<string, string>,
  roomIdsByType: Map<string, string[]>,
): Promise<{ reservations: number; folios: number; folioLines: number }> {
  let reservations = 0;
  let folios = 0;
  let folioLines = 0;

  // One corporate account per property, for the GSTIN column.
  const companyId = await upsertDemoCompany(prisma, propertyId, seed);

  // Stays are spread across categories so no single room type carries all of
  // them, and so the calendar shows blocks on more than one row.
  const codes = [...roomTypeIds.keys()];

  for (const [index, stay] of RESERVATIONS.entries()) {
    const typeCode = codes[index % codes.length];
    if (typeCode === undefined) continue;
    const roomTypeId = roomTypeIds.get(typeCode);
    const roomPool = roomIdsByType.get(typeCode) ?? [];
    if (roomTypeId === undefined || roomPool.length === 0) continue;

    const confirmationCode = `SFBOOKING_${seed.code}_${stay.ref}`;

    /**
     * Idempotence, with one deliberate exception.
     *
     * ===========================================================================
     * An existing stay keeps its ledger and converges on its demo attributes.
     *
     * The folio is never rebuilt: its lines are immutable by design (section
     * 3.4), a demo may have corrected one, and re-deriving them would discard
     * that. Nor is the room assignment or the inventory it consumed.
     *
     * The master-report attributes *are* re-applied, because they are seed-owned
     * demo data rather than anything a user posted — segment, OTA settlement,
     * promo, deposit. Without this, every stay seeded before those columns
     * existed would sit at its defaults forever and the report's new columns
     * would render empty on exactly the bookings somebody is looking at.
     *
     * Nothing financial moves: the amounts here are attribution the report
     * reads, not folio lines or balances.
     * ===========================================================================
     */
    const existing = await prisma.reservation.findUnique({
      where: {
        reservation_unique_code_per_property: { propertyId, confirmationCode },
      },
      select: { id: true, totalAmountMinor: true },
    });

    if (existing !== null) {
      await prisma.reservation.update({
        where: { id: existing.id },
        data: masterReportFields(stay, existing.totalAmountMinor, businessDate),
        select: { id: true },
      });

      // The card instrument on the advance, for the same reason.
      if (stay.card !== undefined) {
        await prisma.folioLine.updateMany({
          where: {
            propertyId,
            folio: { reservationId: existing.id },
            kind: FolioLineKind.PAYMENT,
          },
          data: {
            paymentMethod: PaymentMethod.CARD,
            cardLast4: stay.card.last4,
            paymentIssuer: stay.card.issuer,
            isExternalCard: stay.paidByExternalSource === true,
            ...(stay.paidByExternalSource === true ? { isExternalSource: true } : {}),
          },
        });
      } else if (stay.paidByExternalSource === true) {
        await prisma.folioLine.updateMany({
          where: {
            propertyId,
            folio: { reservationId: existing.id },
            kind: FolioLineKind.PAYMENT,
          },
          data: { isExternalSource: true },
        });
      }

      // And the folio number, which is derived from the booking ref so it
      // converges rather than conflicting with the unique index.
      await prisma.folio.updateMany({
        where: { propertyId, reservationId: existing.id },
        data: { customFolioId: `FOL-${seed.code}-${stay.ref}` },
      });

      // The guest block, so the address, identity and special-request columns
      // fill in for stays seeded before those fixtures existed.
      if (stay.guestDetail !== undefined) {
        await prisma.reservationGuest.updateMany({
          where: { propertyId, reservationId: existing.id, ordinal: 1 },
          data: {
            addressLine1: stay.guestDetail.addressLine1,
            addressLine2: stay.guestDetail.addressLine2,
            postalCode: stay.guestDetail.postalCode,
            govtIdType: stay.guestDetail.govtIdType,
            govtIdNumber: stay.guestDetail.govtIdNumber,
            specialRequest: stay.guestDetail.specialRequest,
          },
        });
      }

      /**
       * The supplementary folio lines, posted only if absent.
       *
       * This *adds* to the ledger rather than rewriting it, which is the
       * distinction that makes it safe: existing lines are untouched and
       * immutable as ever, and the existence check means a second run posts
       * nothing. Without it, a stay seeded before the service and refund
       * fixtures existed would leave those report columns empty forever.
       */
      const folioRow = await prisma.folio.findUnique({
        where: { reservationId: existing.id },
        select: { id: true },
      });

      if (folioRow !== null) {
        const arrivalDate = addDays(businessDate, stay.arrivalOffset);

        if (stay.service !== undefined) {
          const posted = await prisma.folioLine.count({
            where: { folioId: folioRow.id, kind: FolioLineKind.SERVICE_CHARGE },
          });
          if (posted === 0) {
            const serviceNetMinor = rupees(stay.service.rupees);
            const line = await prisma.folioLine.create({
              data: {
                propertyId,
                folioId: folioRow.id,
                kind: FolioLineKind.SERVICE_CHARGE,
                description: stay.service.description,
                amountMinor: serviceNetMinor,
                currency: 'INR',
                chargeDate: arrivalDate,
              },
              select: { id: true },
            });
            await prisma.folioLine.create({
              data: {
                propertyId,
                folioId: folioRow.id,
                kind: FolioLineKind.TAX,
                description: 'GST @ 18% on services',
                amountMinor: Math.round(serviceNetMinor * 0.18),
                currency: 'INR',
                chargeDate: arrivalDate,
                derivedFromLineId: line.id,
              },
              select: { id: true },
            });
            folioLines += 2;
          }
        }

        if (stay.refundRupees !== undefined) {
          const posted = await prisma.folioLine.count({
            where: { folioId: folioRow.id, kind: FolioLineKind.REFUND },
          });
          if (posted === 0) {
            await prisma.folioLine.create({
              data: {
                propertyId,
                folioId: folioRow.id,
                kind: FolioLineKind.REFUND,
                description: 'Refund — service adjustment',
                amountMinor: rupees(stay.refundRupees),
                currency: 'INR',
                chargeDate: arrivalDate,
                paymentMethod: PaymentMethod.UPI,
              },
              select: { id: true },
            });
            folioLines += 1;
          }
        }

        /**
         * The cash share of the advance.
         *
         * Converted rather than added: the advance total is already correct on
         * the reservation, so posting another payment line would overstate
         * what was collected. Re-pointing part of it at CASH is what makes the
         * offline-payment column non-zero without moving a rupee.
         */
        if (stay.cashRupees !== undefined) {
          const cashPosted = await prisma.folioLine.count({
            where: {
              folioId: folioRow.id,
              kind: FolioLineKind.PAYMENT,
              paymentMethod: PaymentMethod.CASH,
            },
          });
          if (cashPosted === 0) {
            const advance = await prisma.folioLine.findFirst({
              where: { folioId: folioRow.id, kind: FolioLineKind.PAYMENT },
              orderBy: { createdAt: 'asc' },
              select: { id: true, amountMinor: true },
            });
            const cashMinor = rupees(stay.cashRupees);
            if (advance !== null && -advance.amountMinor > cashMinor) {
              await prisma.folioLine.update({
                where: { id: advance.id },
                data: { amountMinor: advance.amountMinor + cashMinor },
                select: { id: true },
              });
              await prisma.folioLine.create({
                data: {
                  propertyId,
                  folioId: folioRow.id,
                  kind: FolioLineKind.PAYMENT,
                  description: 'Advance received — cash',
                  amountMinor: -cashMinor,
                  currency: 'INR',
                  chargeDate: arrivalDate,
                  paymentMethod: PaymentMethod.CASH,
                },
                select: { id: true },
              });
              folioLines += 1;
            }
          }
        }
      }

      // The reservation scalars that are not part of masterReportFields.
      await prisma.reservation.update({
        where: { id: existing.id },
        data: {
          ...(stay.infants === undefined ? {} : { infants: stay.infants }),
          ...(stay.otaBookingId === undefined ? {} : { otaBookingId: stay.otaBookingId }),
          ...(stay.corporate === true && companyId !== null ? { companyId } : {}),
        },
        select: { id: true },
      });

      continue;
    }

    const arrival = addDays(businessDate, stay.arrivalOffset);
    const departure = addDays(businessDate, stay.departureOffset);
    const nights = Math.round((departure.getTime() - arrival.getTime()) / DAY_MS);

    const type = seed.roomTypes.find((candidate) => candidate.code === typeCode);
    if (type === undefined) continue;
    const nightlyRateMinor = rupees(type.nightlyRate);
    const taxPercent = taxPercentForNightly(nightlyRateMinor);

    // Rounded once per night and summed from the rounded figures, so the
    // night-by-night split a guest is shown adds up to the total charged.
    const nightlyTaxMinor = Math.round((nightlyRateMinor * taxPercent) / 100);
    const netMinor = nightlyRateMinor * nights;
    const taxMinor = nightlyTaxMinor * nights;
    const totalMinor = netMinor + taxMinor;
    const paidMinor = Math.round(totalMinor * stay.advanceFraction);

    // A hold holds no room: it consumes room-type availability, which is what
    // makes it worth releasing, but assigning a specific room to an unconfirmed
    // enquiry would block that room for a booking that may never firm up.
    const roomId =
      stay.status === ReservationStatus.ON_HOLD
        ? null
        : (roomPool[index % roomPool.length] ?? null);

    await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.create({
        data: {
          propertyId,
          confirmationCode,
          status: stay.status,
          source: stay.source,
          arrivalDate: arrival,
          departureDate: departure,
          adults: stay.adults,
          children: stay.children,
          guestFirstName: stay.guestFirst,
          guestLastName: stay.guestLast,
          guestEmail: stay.email,
          guestPhone: stay.phone,
          mealPlan: stay.mealPlan,
          totalAmountMinor: totalMinor,
          paidAmountMinor: paidMinor,
          taxAmountMinor: taxMinor,
          isTaxExempt: false,
          currency: 'INR',
          ...(stay.status === ReservationStatus.CHECKED_IN
            ? // 2:00 PM local on the arrival date, which is a real instant the
              // hourly calendar view can position a block against.
              { checkedInAt: new Date(arrival.getTime() + 14 * 3_600_000) }
            : {}),
          ...(stay.status === ReservationStatus.CHECKED_OUT
            ? {
                checkedInAt: new Date(arrival.getTime() + 14 * 3_600_000),
                // 10:30 on the departure morning, before the standard time.
                checkedOutAt: new Date(departure.getTime() + 10.5 * 3_600_000),
              }
            : {}),
          ...(stay.infants === undefined ? {} : { infants: stay.infants }),
          ...(stay.otaBookingId === undefined ? {} : { otaBookingId: stay.otaBookingId }),
          ...(stay.corporate === true && companyId !== null ? { companyId } : {}),
          ...masterReportFields(stay, totalMinor, businessDate),
        },
        select: { id: true },
      });

      await tx.reservationGuest.create({
        data: {
          propertyId,
          reservationId: reservation.id,
          ordinal: 1,
          firstName: stay.guestFirst,
          lastName: stay.guestLast,
          email: stay.email,
          phone: stay.phone,
          city: seed.city,
          state: seed.state,
          countryCode: 'IN',
          // The rest of the guest block, where the fixture supplied it, so the
          // report's address, identity and special-request columns have
          // something to show. The identity number is a test pattern and the
          // report masks it to four digits wherever it appears.
          ...(stay.guestDetail === undefined
            ? {}
            : {
                addressLine1: stay.guestDetail.addressLine1,
                addressLine2: stay.guestDetail.addressLine2,
                postalCode: stay.guestDetail.postalCode,
                govtIdType: stay.guestDetail.govtIdType,
                govtIdNumber: stay.guestDetail.govtIdNumber,
                specialRequest: stay.guestDetail.specialRequest,
              }),
        },
        select: { id: true },
      });

      await tx.reservationRoom.create({
        data: {
          propertyId,
          reservationId: reservation.id,
          roomTypeId,
          roomId,
          arrivalDate: arrival,
          departureDate: departure,
          status: stay.status,
        },
        select: { id: true },
      });

      /**
       * The inventory this stay consumes, one night at a time.
       *
       * Incremented in stay-date ascending order — the fixed lock order from
       * section 3.1 — and left to the `inventory_day_not_oversold` CHECK to
       * reject. A seed has no concurrency, but running the same statement the
       * booking path runs is what makes these fixtures provably sellable
       * rather than merely plausible.
       */
      for (let offset = 0; offset < nights; offset += 1) {
        await tx.inventoryDay.update({
          where: {
            inventory_day_unique_per_date: {
              propertyId,
              roomTypeId,
              stayDate: addDays(arrival, offset),
            },
          },
          data: { sold: { increment: 1 } },
          select: { id: true },
        });
      }

      /**
       * The folio.
       *
       * Opened for every stay that has money against it. A hold has taken no
       * payment and has no charges yet, so it gets no folio — the folio is
       * opened when a clerk first posts to it, and a seeded empty container
       * would make the billing screen show a bill for a booking that is not
       * yet a stay.
       */
      if (stay.status === ReservationStatus.ON_HOLD) return;

      const folio = await tx.folio.create({
        data: {
          propertyId,
          reservationId: reservation.id,
          status:
            stay.status === ReservationStatus.CHECKED_OUT
              ? FolioStatus.CLOSED
              : FolioStatus.OPEN,
          currency: 'INR',
          // The number a clerk quotes down the phone, unique per property.
          // Derived from the booking ref so a re-run converges on the same one.
          customFolioId: `FOL-${seed.code}-${stay.ref}`,
        },
        select: { id: true },
      });
      folios += 1;

      /**
       * Nights already elapsed are posted; nights still ahead are not.
       *
       * The night audit posts a room charge for each night as it closes, so an
       * in-house guest on their second night has one night in the ledger and
       * the rest still to come. Posting the whole stay up front would show a
       * balance the guest does not yet owe, and the folio screen derives its
       * scheduled rows from the agreed tariff for exactly this reason.
       */
      const postedNights = Math.max(
        0,
        Math.min(nights, Math.round((businessDate.getTime() - arrival.getTime()) / DAY_MS)),
      );

      for (let offset = 0; offset < postedNights; offset += 1) {
        const chargeDate = addDays(arrival, offset);

        const charge = await tx.folioLine.create({
          data: {
            propertyId,
            folioId: folio.id,
            kind: FolioLineKind.ROOM_CHARGE,
            description: `${type.name} — room charge`,
            amountMinor: nightlyRateMinor,
            currency: 'INR',
            chargeDate,
          },
          select: { id: true },
        });
        folioLines += 1;

        if (nightlyTaxMinor > 0) {
          // Its own line, hanging off the charge it derives from, never folded
          // into the base amount (section 3.4).
          await tx.folioLine.create({
            data: {
              propertyId,
              folioId: folio.id,
              kind: FolioLineKind.TAX,
              description: `GST @ ${String(taxPercent)}%`,
              amountMinor: nightlyTaxMinor,
              currency: 'INR',
              chargeDate,
              derivedFromLineId: charge.id,
            },
            select: { id: true },
          });
          folioLines += 1;
        }
      }

      /**
       * A service charge and its tax, where the fixture asked for one.
       *
       * Posted on the arrival date with its own TAX child, exactly as a room
       * charge is — so the report's service columns separate correctly from
       * the room ones, which it does by reading the kind of the line each tax
       * hangs off.
       *
       * 18% regardless of the room's band: restaurant and laundry service in
       * a hotel is taxed on its own footing, not the accommodation band.
       */
      if (stay.service !== undefined) {
        const serviceNetMinor = rupees(stay.service.rupees);
        const serviceTaxMinor = Math.round(serviceNetMinor * 0.18);

        const serviceLine = await tx.folioLine.create({
          data: {
            propertyId,
            folioId: folio.id,
            kind: FolioLineKind.SERVICE_CHARGE,
            description: stay.service.description,
            amountMinor: serviceNetMinor,
            currency: 'INR',
            chargeDate: arrival,
          },
          select: { id: true },
        });
        folioLines += 1;

        await tx.folioLine.create({
          data: {
            propertyId,
            folioId: folio.id,
            kind: FolioLineKind.TAX,
            description: 'GST @ 18% on services',
            amountMinor: serviceTaxMinor,
            currency: 'INR',
            chargeDate: arrival,
            derivedFromLineId: serviceLine.id,
          },
          select: { id: true },
        });
        folioLines += 1;
      }

      /**
       * Part of the advance taken in cash.
       *
       * Split off as its own line rather than folded into the one below,
       * because the online/offline columns are read from the instrument on
       * each line — one line cannot be both.
       */
      if (stay.cashRupees !== undefined) {
        await tx.folioLine.create({
          data: {
            propertyId,
            folioId: folio.id,
            kind: FolioLineKind.PAYMENT,
            description: 'Advance received — cash',
            amountMinor: -rupees(stay.cashRupees),
            currency: 'INR',
            chargeDate: arrival,
            paymentMethod: PaymentMethod.CASH,
          },
          select: { id: true },
        });
        folioLines += 1;
      }

      // A refund posted back to the guest. Positive: giving money back
      // increases what they owe, which is why the sign CHECK requires it.
      if (stay.refundRupees !== undefined) {
        await tx.folioLine.create({
          data: {
            propertyId,
            folioId: folio.id,
            kind: FolioLineKind.REFUND,
            description: 'Refund — service adjustment',
            amountMinor: rupees(stay.refundRupees),
            currency: 'INR',
            chargeDate: arrival,
            paymentMethod: PaymentMethod.UPI,
          },
          select: { id: true },
        });
        folioLines += 1;
      }

      // What is left of the advance after the cash line above. Guarded,
      // because a zero remainder would post an empty payment line and a
      // negative one would fail the sign CHECK.
      const remainingAdvanceMinor = paidMinor - rupees(stay.cashRupees ?? 0);

      if (remainingAdvanceMinor > 0) {
        await tx.folioLine.create({
          data: {
            propertyId,
            folioId: folio.id,
            kind: FolioLineKind.PAYMENT,
            description: 'Advance received',
            // Negative: a payment reduces what the guest owes, and
            // `folio_line_sign_matches_kind` enforces the sign rather than
            // trusting each call site.
            //
            // Less whatever was taken in cash above, so the two lines sum to
            // the advance the reservation records rather than exceeding it.
            amountMinor: -remainingAdvanceMinor,
            currency: 'INR',
            chargeDate: arrival,
            paymentMethod:
              stay.card !== undefined
                ? PaymentMethod.CARD
                : stay.source === BookingSource.CORPORATE
                  ? PaymentMethod.BANK_TRANSFER
                  : PaymentMethod.UPI,
            // Instrument detail, where the fixture gave the advance a card.
            // Four digits only: `folio_line_card_last4_is_four_digits`
            // enforces the shape and the schema cannot hold a full PAN.
            ...(stay.card === undefined
              ? {}
              : {
                  cardLast4: stay.card.last4,
                  paymentIssuer: stay.card.issuer,
                  isExternalCard: stay.paidByExternalSource === true,
                }),
            // Collected by the channel rather than at this desk, so it
            // reconciles against the OTA's settlement file.
            ...(stay.paidByExternalSource === true ? { isExternalSource: true } : {}),
          },
          select: { id: true },
        });
        folioLines += 1;
      }
    });

    // Occupancy is not set here. `deriveRoomOccupancyForProperty` does it for
    // every in-house stay once the loop is done, so the create path and the
    // already-seeded path end up in the same state.
    reservations += 1;
  }

  /**
   * The cancelled booking.
   *
   * ===========================================================================
   * Outside the loop, because a cancellation is not a stay.
   *
   * It consumes no inventory — `deriveSoldForProperty` counts only CONFIRMED,
   * CHECKED_IN, CHECKED_OUT and ON_HOLD, so a cancelled booking correctly
   * frees the night back up. It holds no room, so the exclusion constraint has
   * nothing to reject. And it opens no folio, because nothing was ever charged
   * or collected against it.
   *
   * It exists so the master report's cancel-date column and its CANCELLED
   * badge have a real row behind them, and so the gross-versus-revenue note on
   * that report is demonstrably about something.
   * ===========================================================================
   */
  const cancelledCode = `SFBOOKING_${seed.code}_${CANCELLED_RESERVATION.ref}`;
  const alreadyCancelled = await prisma.reservation.findUnique({
    where: {
      reservation_unique_code_per_property: {
        propertyId,
        confirmationCode: cancelledCode,
      },
    },
    select: { id: true },
  });

  if (alreadyCancelled === null) {
    const typeCode = codes[0];
    const roomTypeId = typeCode === undefined ? undefined : roomTypeIds.get(typeCode);
    const type = seed.roomTypes.find((candidate) => candidate.code === typeCode);

    if (roomTypeId !== undefined && type !== undefined) {
      const arrival = addDays(businessDate, CANCELLED_RESERVATION.arrivalOffset);
      const departure = addDays(businessDate, CANCELLED_RESERVATION.departureOffset);
      const nights = Math.round((departure.getTime() - arrival.getTime()) / DAY_MS);
      const nightlyRateMinor = rupees(type.nightlyRate);
      const taxPercent = taxPercentForNightly(nightlyRateMinor);
      const nightlyTaxMinor = Math.round((nightlyRateMinor * taxPercent) / 100);
      const totalMinor = (nightlyRateMinor + nightlyTaxMinor) * nights;

      await prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.create({
          data: {
            propertyId,
            confirmationCode: cancelledCode,
            status: ReservationStatus.CANCELLED,
            source: CANCELLED_RESERVATION.source,
            arrivalDate: arrival,
            departureDate: departure,
            adults: CANCELLED_RESERVATION.adults,
            children: CANCELLED_RESERVATION.children,
            guestFirstName: CANCELLED_RESERVATION.guestFirst,
            guestLastName: CANCELLED_RESERVATION.guestLast,
            guestEmail: CANCELLED_RESERVATION.email,
            guestPhone: CANCELLED_RESERVATION.phone,
            mealPlan: CANCELLED_RESERVATION.mealPlan,
            totalAmountMinor: totalMinor,
            // Nothing was collected, so nothing is refundable and the balance
            // reads as the full value — which is what a cancelled booking
            // inside the retention window actually looks like.
            paidAmountMinor: 0,
            taxAmountMinor: nightlyTaxMinor * nights,
            isTaxExempt: false,
            currency: 'INR',
            ...masterReportFields(CANCELLED_RESERVATION, totalMinor, businessDate),
          },
          select: { id: true },
        });

        await tx.reservationRoom.create({
          data: {
            propertyId,
            reservationId: reservation.id,
            roomTypeId,
            // No room: a cancelled booking blocks nothing.
            roomId: null,
            arrivalDate: arrival,
            departureDate: departure,
            status: ReservationStatus.CANCELLED,
          },
          select: { id: true },
        });
      });

      reservations += 1;
    }
  }

  return { reservations, folios, folioLines };
}

/**
 * Gives the existing property admins access to the new properties.
 *
 * Without a grant a property is invisible: every read in the system traverses
 * from `UserPropertyRole` rather than filtering a global property list
 * (section 3.2), so an ungranted property is never selected at all. The grants
 * mirror whoever already holds PROPERTY_ADMIN somewhere in the portfolio,
 * which is the set of people who would be given these hotels.
 */
async function grantStaffAccess(
  prisma: PrismaClient,
  propertyId: string,
): Promise<number> {
  const role = await prisma.role.findFirst({
    where: { key: 'PROPERTY_ADMIN' },
    select: { id: true },
  });
  if (role === null) return 0;

  const admins = await prisma.userPropertyRole.findMany({
    where: { roleId: role.id },
    select: { userId: true },
    distinct: ['userId'],
  });

  let granted = 0;
  for (const admin of admins) {
    const existing = await prisma.userPropertyRole.findUnique({
      where: {
        user_property_role_unique: {
          userId: admin.userId,
          propertyId,
          roleId: role.id,
        },
      },
      select: { id: true },
    });
    if (existing === null) {
      await prisma.userPropertyRole.create({
        data: { userId: admin.userId, propertyId, roleId: role.id },
        select: { id: true },
      });
      granted += 1;
    }
  }

  return granted;
}

/** Everything for one property. */
async function seedProperty(
  prisma: PrismaClient,
  seed: DemoProperty,
  amenityIds: Map<string, string>,
  counters: PortfolioCounters,
): Promise<void> {
  const property = await seedPropertyMaster(prisma, seed);

  const { roomTypeIds, roomIdsByType, roomTypes, rooms } = await seedRooms(
    prisma,
    property.id,
    seed,
  );

  counters.slabs += await seedTaxSlabs(prisma, property.id);
  counters.amenityLinks += await seedAmenityLinks(prisma, property.id, seed, amenityIds);
  counters.policies += await seedPolicies(prisma, property.id);
  counters.media += await seedMedia(prisma, property.id, seed, roomTypeIds);
  counters.inventoryDays += await seedInventory(
    prisma,
    property.id,
    property.businessDate,
    roomTypeIds,
    roomIdsByType,
  );

  const stays = await seedReservationsAndFolios(
    prisma,
    property.id,
    seed,
    property.businessDate,
    roomTypeIds,
    roomIdsByType,
  );

  // After the stays, always. The inventory rebuild above zeroed the counters
  // and `seedRooms` reset the housekeeping statuses, and a re-run seeds no new
  // stays to restore either — so both are derived rather than written once.
  await deriveSoldForProperty(prisma, property.id);
  await deriveRoomOccupancyForProperty(prisma, property.id, property.businessDate);

  counters.roomTypes += roomTypes;
  counters.rooms += rooms;
  counters.reservations += stays.reservations;
  counters.folios += stays.folios;
  counters.folioLines += stays.folioLines;
  counters.grants += await grantStaffAccess(prisma, property.id);
  counters.properties += 1;

  console.log(
    `  ✔ Created property: ${seed.name} (Code: ${seed.code}) — ` +
      `${String(roomTypes)} categories, ${String(rooms)} rooms, ` +
      `${String(stays.reservations)} stays, ${String(stays.folios)} folios`,
  );
}

/**
 * Seeds the ten-property demo portfolio.
 *
 * Takes the client rather than creating one, so `seed.ts` runs this inside the
 * same connection as the rest of its work and the standalone entry point below
 * owns its own lifecycle.
 */
export async function seedDemoPortfolio(prisma: PrismaClient): Promise<PortfolioCounters> {
  const counters: PortfolioCounters = {
    properties: 0,
    roomTypes: 0,
    rooms: 0,
    media: 0,
    slabs: 0,
    amenityLinks: 0,
    policies: 0,
    inventoryDays: 0,
    reservations: 0,
    folios: 0,
    folioLines: 0,
    grants: 0,
  };

  console.log('\nDemo portfolio (codes 31346-31355)');

  const amenityIds = await createAmenities(prisma);
  console.log(`  ✔ Amenity catalogue: ${String(amenityIds.size)} amenities`);

  for (const seed of DEMO_PROPERTIES) {
    await seedProperty(prisma, seed, amenityIds, counters);
  }

  console.log(
    `  ✔ ${String(counters.properties)} properties · ` +
      `${String(counters.roomTypes)} categories · ${String(counters.rooms)} rooms · ` +
      `${String(counters.media)} photographs · ${String(counters.slabs)} GST slabs · ` +
      `${String(counters.amenityLinks)} amenity links · ${String(counters.policies)} policies`,
  );
  console.log(
    `  ✔ ${String(counters.inventoryDays)} inventory days · ` +
      `${String(counters.reservations)} reservations · ${String(counters.folios)} folios · ` +
      `${String(counters.folioLines)} folio lines · ${String(counters.grants)} role grants`,
  );

  return counters;
}

export { DEMO_PROPERTIES };
