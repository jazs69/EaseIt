'use client';

/**
 * General & media.
 *
 * Property identity — name, code, timezone, currency, business date — is shown
 * read-only, and deliberately. Those live on `Property` rather than
 * `PropertySettings`, and each has consequences this screen cannot carry:
 * changing a timezone moves every property's night-audit schedule and the
 * meaning of every stored business date; changing a currency would reinterpret
 * every integer minor unit already posted. They are not "settings an operator
 * edits" (CLAUDE.md section 3.3 and 3.4), so there is no endpoint for them and
 * this tab says why rather than offering a field that silently fails.
 *
 * What *is* editable here is the document prefixes, which are cosmetic for
 * identifiers not yet issued, and the media list.
 */

import { useState } from 'react';
import { ImagePlus, Star } from 'lucide-react';
import type { PropertyMedia, PropertySetup } from '@repo/types';

import { addPropertyMedia } from '@/lib/properties-client';
import { Field, NotWiredNotice, SaveBar, Section, Select, TextInput } from './fields';
import type { PropertySettingsState } from './use-property-settings';

const MEDIA_CATEGORIES = [
  { value: 'EXTERIOR', label: 'Exterior' },
  { value: 'INTERIOR', label: 'Interior' },
  { value: 'RECEPTION', label: 'Reception' },
  { value: 'ROOM_BEDROOM', label: 'Room — bedroom' },
  { value: 'ROOM_WASHROOM', label: 'Room — washroom' },
  { value: 'AMENITY_BANQUET', label: 'Banquet' },
  { value: 'AMENITY_POOL', label: 'Pool' },
  { value: 'AMENITY_GARDEN', label: 'Garden' },
  { value: 'PARKING', label: 'Parking' },
  { value: 'RESTAURANT', label: 'Restaurant' },
  { value: 'OTHERS', label: 'Other' },
] as const;

type MediaCategory = (typeof MEDIA_CATEGORIES)[number]['value'];

export function GeneralTab({
  state,
  hotelId,
}: {
  state: PropertySettingsState;
  hotelId: string;
}) {
  const { setup, saving, savedTab, saveSettings } = state;

  // Tagged against the server payload, so a save that returns new prefixes
  // replaces the draft instead of being overwritten by it.
  const [draft, setDraft] = useState<{
    from: PropertySetup;
    value: { bookingPrefix: string; folioPrefix: string; invoicePrefix: string };
  } | null>(null);

  const prefixes =
    draft !== null && draft.from === setup
      ? draft.value
      : {
          bookingPrefix: setup.settings.bookingPrefix,
          folioPrefix: setup.settings.folioPrefix,
          invoicePrefix: setup.settings.invoicePrefix,
        };

  const dirty =
    prefixes.bookingPrefix !== setup.settings.bookingPrefix ||
    prefixes.folioPrefix !== setup.settings.folioPrefix ||
    prefixes.invoicePrefix !== setup.settings.invoicePrefix;

  const update = (patch: Partial<typeof prefixes>) => {
    setDraft({ from: setup, value: { ...prefixes, ...patch } });
  };

  const [media, setMedia] = useState<readonly PropertyMedia[]>(setup.media);
  const [mediaFrom, setMediaFrom] = useState<PropertySetup>(setup);
  const shownMedia = mediaFrom === setup ? media : setup.media;

  const [newUrl, setNewUrl] = useState('');
  const [newCategory, setNewCategory] = useState<MediaCategory>('EXTERIOR');
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const addMedia = async () => {
    setAdding(true);
    setMediaError(null);
    try {
      const created = await addPropertyMedia(hotelId, {
        category: newCategory,
        url: newUrl.trim(),
        caption: null,
        sortOrder: shownMedia.length,
        isFeatured: false,
        roomTypeId: null,
      });
      setMedia([...shownMedia, created]);
      setMediaFrom(setup);
      setNewUrl('');
    } catch {
      setMediaError('That image could not be recorded. Check the address is a full URL.');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Property identity"
        description="Set when the property was created, and not editable here — see below."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Name">
            <ReadOnly value={setup.name} />
          </Field>
          <Field label="Code">
            <ReadOnly value={setup.code} />
          </Field>
          <Field label="Timezone">
            <ReadOnly value={setup.timezone} />
          </Field>
          <Field label="Currency">
            <ReadOnly value={setup.currency} />
          </Field>
          <Field label="Business date" hint="Advanced only by the night audit.">
            <ReadOnly value={setup.businessDate} />
          </Field>
        </div>

        <div className="mt-4">
          <NotWiredNotice>
            These are not settings so much as the property&rsquo;s identity. Changing the
            timezone would move the night-audit schedule and alter what every stored
            business date means; changing the currency would reinterpret every amount
            already posted, which are integers in that currency&rsquo;s minor units. Both
            need a migration of existing rows rather than a form, so there is no endpoint
            for them and this tab does not pretend otherwise.
          </NotWiredNotice>
        </div>
      </Section>

      <Section
        title="Document prefixes"
        description="Applied to identifiers issued from now on. Existing bookings, folios and invoices keep the prefix they were issued with."
        action={
          <SaveBar
            dirty={dirty}
            saving={saving}
            saved={savedTab === 'general'}
            onSave={() => {
              void saveSettings(prefixes, 'general');
            }}
            onReset={() => {
              setDraft(null);
            }}
          />
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Booking prefix" htmlFor="booking-prefix">
            <TextInput
              id="booking-prefix"
              value={prefixes.bookingPrefix}
              disabled={saving}
              onChange={(bookingPrefix) => {
                update({ bookingPrefix });
              }}
            />
          </Field>
          <Field label="Folio prefix" htmlFor="folio-prefix">
            <TextInput
              id="folio-prefix"
              value={prefixes.folioPrefix}
              disabled={saving}
              onChange={(folioPrefix) => {
                update({ folioPrefix });
              }}
            />
          </Field>
          <Field label="Invoice prefix" htmlFor="invoice-prefix">
            <TextInput
              id="invoice-prefix"
              value={prefixes.invoicePrefix}
              disabled={saving}
              onChange={(invoicePrefix) => {
                update({ invoicePrefix });
              }}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Photographs"
        description="Where the property's images live. The booking engine reads this list."
      >
        <NotWiredNotice>
          This records an image&rsquo;s address, it does not upload one — nothing in this
          repository stores files yet. Paste a URL from wherever the images are already
          hosted. Removing an entry needs a delete endpoint that is not built.
        </NotWiredNotice>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-48">
            <Field label="Category" htmlFor="media-category">
              <Select
                id="media-category"
                value={newCategory}
                options={MEDIA_CATEGORIES}
                disabled={adding}
                onChange={setNewCategory}
              />
            </Field>
          </div>
          <div className="min-w-0 flex-1">
            <Field
              label="Image address"
              htmlFor="media-url"
              error={mediaError ?? undefined}
            >
              <TextInput
                id="media-url"
                value={newUrl}
                disabled={adding}
                placeholder="https://…"
                onChange={setNewUrl}
              />
            </Field>
          </div>
          <button
            type="button"
            disabled={adding || newUrl.trim() === ''}
            onClick={() => {
              void addMedia();
            }}
            className="flex h-[38px] shrink-0 items-center gap-1.5 rounded-lg bg-blue-500 px-4 text-xs font-bold tracking-wider text-white uppercase transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ImagePlus className="size-3.5" aria-hidden="true" />
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>

        {shownMedia.length === 0 ? (
          <p className="mt-4 text-xs text-zinc-500">No photographs recorded yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-white/[0.06]">
            {shownMedia.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2">
                <span className="w-36 shrink-0 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                  {MEDIA_CATEGORIES.find((c) => c.value === item.category)?.label ??
                    item.category}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                  {item.url}
                </span>
                {item.isFeatured ? (
                  <Star
                    className="size-3.5 shrink-0 text-amber-400"
                    aria-label="Featured"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ReadOnly({ value }: { value: string }) {
  return (
    <span className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-zinc-400">
      {value}
    </span>
  );
}
