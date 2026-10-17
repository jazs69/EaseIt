/**
 * GSTIN structure and checksum.
 *
 * ===========================================================================
 * This validates a GSTIN. It does **not** verify one, and the difference
 * matters enough to be the first thing in the file.
 *
 * Validating is arithmetic: a GSTIN carries a mod-36 check digit, so a typo is
 * detectable offline with certainty. That is what this does, and it catches
 * the overwhelming majority of real errors — a transposed digit on a number
 * read off an invoice.
 *
 * Verifying means asking the GST Network whether that number is registered,
 * to whom, and at what address. It needs credentialled access to a government
 * API this deployment does not have. The brief suggested returning a "verified
 * Legal Name and Principal Place of Business", and inventing those would be
 * the single worst thing in this feature: the legal name on a tax invoice is
 * the thing the invoice is *for*, and a plausible-looking fabrication would be
 * filed, claimed against, and discovered by an auditor rather than by us.
 *
 * So the lookup returns what can be known offline — validity, the state the
 * code belongs to, and the embedded PAN — and the operator types the legal
 * name. When GSTN credentials exist, this is where the call goes, and the
 * response shape already has room for it.
 * ===========================================================================
 */

/** Positional values: digits then letters, 0-35. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** State codes as published by the GST Council. */
const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

/**
 * `22AAAAA0000A1Z5`: 2-digit state, 10-character PAN, entity digit, `Z`,
 * check character.
 */
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export interface GstinInspection {
  gstin: string;
  isValid: boolean;
  /** Why it was rejected, for the operator rather than for a log. */
  reason: string | null;
  stateCode: string | null;
  stateName: string | null;
  /** The PAN embedded in characters 3-12. */
  pan: string | null;
}

/**
 * The published mod-36 check digit.
 *
 * Each of the first fourteen characters takes its position value, multiplied
 * alternately by 1 and 2. The products' digit sums (in base 36) are totalled,
 * and the check character is whatever brings that total to a multiple of 36.
 */
function checkCharacter(first14: string): string {
  let sum = 0;

  for (let index = 0; index < first14.length; index += 1) {
    const value = ALPHABET.indexOf(first14.charAt(index));
    if (value < 0) return '';
    const product = value * (index % 2 === 0 ? 1 : 2);
    // Base-36 digit sum: the carry plus the remainder.
    sum += Math.floor(product / 36) + (product % 36);
  }

  return ALPHABET.charAt((36 - (sum % 36)) % 36);
}

export function inspectGstin(raw: string): GstinInspection {
  const gstin = raw.trim().toUpperCase();

  const base: GstinInspection = {
    gstin,
    isValid: false,
    reason: null,
    stateCode: null,
    stateName: null,
    pan: null,
  };

  if (gstin.length !== 15) {
    return { ...base, reason: 'A GSTIN is exactly 15 characters.' };
  }
  if (!GSTIN_SHAPE.test(gstin)) {
    return {
      ...base,
      reason: 'That is not the shape of a GSTIN: 2 digits, a PAN, an entity code, Z, then a check character.',
    };
  }

  const stateCode = gstin.slice(0, 2);
  const stateName = STATE_CODES[stateCode];
  if (stateName === undefined) {
    return { ...base, stateCode, reason: `${stateCode} is not a GST state code.` };
  }

  const expected = checkCharacter(gstin.slice(0, 14));
  if (expected !== gstin.charAt(14)) {
    return {
      ...base,
      stateCode,
      stateName,
      // The expected character is deliberately not revealed: it would let
      // anyone manufacture a structurally valid GSTIN for a number they made
      // up, which is the opposite of what this check is for.
      reason: 'The check character does not match. Re-read the number.',
    };
  }

  return {
    gstin,
    isValid: true,
    reason: null,
    stateCode,
    stateName,
    pan: gstin.slice(2, 12),
  };
}
