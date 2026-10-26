'use client';

/**
 * Amenities.
 *
 * The catalogue is portfolio-wide reference data — "Wi-Fi" means the same
 * thing at all ten hotels, so `amenity` carries no `propertyId` and is listed
 * in `global-tables.ts` (CLAUDE.md section 3.2). What this tab edits is the
 * *link*: whether this property offers each one, and at what price.
 *
 * Only the amenities already linked can be configured here, because the
 * response carries the links rather than the catalogue. Adding one the
 * property has never offered needs a catalogue read, which the setup endpoint
 * does not return — stated plainly below rather than left to be discovered.
 *
 * A paid amenity must carry a price and a free one must not: that is
 * `property_amenity_link_price_matches_scope`, enforced in the database, the
 * schema and here. Switching the toggle moves the price with it so the two can
 * never disagree.
 */

import { useState } from 'react';
import type { AmenityLink, PropertySetup } from '@repo/types';

import { formatMoney } from '@/lib/money';
import { Field, NotWiredNotice, SaveBar, Section, TextInput, Toggle } from './fields';
import type { PropertySettingsState } from './use-property-settings';

interface LinkDraft {
  amenityId: string;
  name: string;
  groupName: string;
  paid: boolean;
  priceMajor: string;
  pricingUnit: string;
}

export function AmenitiesTab({ state }: { state: PropertySettingsState }) {
  const { setup, saving, savedTab, saveAmenities } = state;

  const [draft, setDraft] = useState<{ from: PropertySetup; value: LinkDraft[] } | null>(
    null,
  );
  const links = draft !== null && draft.from === setup ? draft.value : toDrafts(setup.amenities);
  const dirty = JSON.stringify(links) !== JSON.stringify(toDrafts(setup.amenities));

  const parsed = links.map(parseLink);
  const valid = parsed.every((row) => row.error === null);

  const patch = (amenityId: string, change: Partial<LinkDraft>) => {
    setDraft({
      from: setup,
      value: links.map((link) =>
        link.amenityId === amenityId ? { ...link, ...change } : link,
      ),
    });
  };

  // Grouped for reading, not for saving: the request is a flat list.
  const groups = [...new Set(links.map((link) => link.groupName))].sort();

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="What this property offers"
        description="Free or charged for, and at what price. The booking engine shows this list to guests."
        action={
          <SaveBar
            dirty={dirty && valid}
            saving={saving}
            saved={savedTab === 'amenities'}
            onSave={() => {
              void saveAmenities(
                parsed
                  .map((row) => row.link)
                  .filter((link): link is NonNullable<typeof link> => link !== null),
                null,
              );
            }}
            onReset={() => {
              setDraft(null);
            }}
          />
        }
      >
        {links.length === 0 ? (
          <p className="text-xs text-zinc-500">No amenities linked to this property.</p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <div key={group}>
                <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
                  {group}
                </h3>
                <div className="flex flex-col divide-y divide-white/[0.05]">
                  {links
                    .filter((link) => link.groupName === group)
                    .map((link) => {
                      const row = parsed.find((entry) => entry.id === link.amenityId);
                      return (
                        <div
                          key={link.amenityId}
                          className="flex flex-wrap items-start gap-3 py-3"
                        >
                          <span className="min-w-[12rem] flex-1 pt-1.5 text-sm text-zinc-200">
                            {link.name}
                          </span>

                          <div className="pt-1.5">
                            <Toggle
                              checked={link.paid}
                              disabled={saving}
                              label={link.paid ? 'Charged' : 'Included'}
                              onChange={(paid) => {
                                // The price moves with the scope: a free
                                // amenity carrying a price is exactly what the
                                // CHECK constraint refuses.
                                patch(link.amenityId, {
                                  paid,
                                  priceMajor: paid ? link.priceMajor : '0',
                                  pricingUnit: paid ? link.pricingUnit : '',
                                });
                              }}
                            />
                          </div>

                          {link.paid ? (
                            <>
                              <div className="w-32">
                                <Field
                                  label={`Price (${setup.currency})`}
                                  error={row?.error ?? undefined}
                                >
                                  <TextInput
                                    value={link.priceMajor}
                                    disabled={saving}
                                    inputMode="decimal"
                                    invalid={row?.error !== null && row?.error !== undefined}
                                    onChange={(priceMajor) => {
                                      patch(link.amenityId, { priceMajor });
                                    }}
                                  />
                                </Field>
                              </div>
                              <div className="w-36">
                                <Field label="Per">
                                  <TextInput
                                    value={link.pricingUnit}
                                    disabled={saving}
                                    placeholder="Per trip"
                                    onChange={(pricingUnit) => {
                                      patch(link.amenityId, { pricingUnit });
                                    }}
                                  />
                                </Field>
                              </div>
                            </>
                          ) : (
                            <span className="w-[17rem] pt-2 text-xs text-zinc-500">
                              Included in the tariff.
                            </span>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5">
          <NotWiredNotice>
            Only amenities already linked to this property appear here. Offering one it
            has never offered — or withdrawing it entirely rather than marking it
            included — needs a read of the portfolio-wide catalogue, which this screen
            does not fetch. Prices are recorded; nothing posts them to a folio yet.
          </NotWiredNotice>
        </div>
      </Section>

      <Section title="Summary" description="What a guest would see.">
        <dl className="grid gap-3 sm:grid-cols-3">
          <Stat label="Offered" value={String(links.length)} />
          <Stat
            label="Included"
            value={String(links.filter((link) => !link.paid).length)}
          />
          <Stat
            label="Charged for"
            value={links
              .filter((link) => link.paid)
              .map((link) => {
                const parsedRow = parsed.find((entry) => entry.id === link.amenityId);
                return parsedRow?.link === null || parsedRow?.link === undefined
                  ? link.name
                  : `${link.name} ${formatMoney(parsedRow.link.priceMinor, setup.currency)}`;
              })
              .join(', ')}
          />
        </dl>
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] px-3 py-2">
      <dt className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-zinc-200">{value === '' ? '—' : value}</dd>
    </div>
  );
}

function toDrafts(amenities: readonly AmenityLink[]): LinkDraft[] {
  return amenities.map((link) => ({
    amenityId: link.amenityId,
    name: link.name,
    groupName: link.groupName,
    paid: link.scope === 'PAID',
    priceMajor: (link.priceMinor / 100).toFixed(2).replace(/\.00$/, ''),
    pricingUnit: link.pricingUnit ?? '',
  }));
}

function parseLink(draft: LinkDraft): {
  id: string;
  link: {
    amenityId: string;
    scope: 'FREE' | 'PAID';
    priceMinor: number;
    pricingUnit: string | null;
  } | null;
  error: string | null;
} {
  if (!draft.paid) {
    return {
      id: draft.amenityId,
      link: {
        amenityId: draft.amenityId,
        scope: 'FREE',
        priceMinor: 0,
        pricingUnit: null,
      },
      error: null,
    };
  }

  const trimmed = draft.priceMajor.trim();
  if (trimmed === '' || !/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { id: draft.amenityId, link: null, error: 'A figure, to at most two decimals.' };
  }
  const priceMinor = Math.round(Number(trimmed) * 100);
  if (priceMinor <= 0) {
    return {
      id: draft.amenityId,
      link: null,
      error: 'A charged amenity needs a price above zero.',
    };
  }

  return {
    id: draft.amenityId,
    link: {
      amenityId: draft.amenityId,
      scope: 'PAID',
      priceMinor,
      pricingUnit: draft.pricingUnit.trim() === '' ? null : draft.pricingUnit.trim(),
    },
    error: null,
  };
}
