'use client';

/**
 * Timings & operations.
 *
 * Every field here is read by something that has already been built, which is
 * why this is the tab with no caveats on it: the check-in and check-out times
 * place reservation strips on the calendar grid, the turnaround grace is the
 * gap drawn between a departure and the next arrival, and the hold release and
 * audit hour are what the night audit and the booking path will schedule
 * against.
 *
 * The times are wall-clock in the property's own timezone and are stored as
 * `HH:MM` strings, never as instants. A check-out time is "11:00 wherever this
 * hotel is", which is not a moment — turning it into one at save time would
 * make it drift by an hour twice a year (CLAUDE.md section 3.3).
 */

import { useState } from 'react';
import { DAY_OF_WEEK_SHORT, type PropertySettings, type PropertySetup } from '@repo/types';

import { Field, SaveBar, Section, TextInput } from './fields';
import type { PropertySettingsState } from './use-property-settings';

type Draft = {
  standardCheckInTime: string;
  standardCheckOutTime: string;
  turnaroundGraceMins: string;
  autoHoldReleaseHours: string;
  nightAuditHour: string;
  /**
   * Which days this property calls its weekend, 0 = Sunday … 6 = Saturday.
   *
   * Kept as numbers rather than a string, unlike the other fields here: there
   * is nothing for an operator to mistype, so there is no intermediate text
   * state to preserve.
   */
  weekendDays: number[];
};

const DAYS_OF_WEEK = [0, 1, 2, 3, 4, 5, 6];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function TimingsTab({ state }: { state: PropertySettingsState }) {
  const { setup, saving, savedTab, saveSettings } = state;

  const [draft, setDraft] = useState<{ from: PropertySetup; value: Draft } | null>(null);
  const current = draft !== null && draft.from === setup ? draft.value : fromSetup(setup);
  const original = fromSetup(setup);

  const dirty = (Object.keys(original) as (keyof Draft)[]).some((key) => {
    // `weekendDays` is an array, so identity comparison would report every
    // render as dirty. Compared by value, order-independently, because
    // {Sat, Sun} and {Sun, Sat} are the same weekend.
    if (key === 'weekendDays') {
      const a = [...current.weekendDays].sort((x, y) => x - y).join(',');
      const b = [...original.weekendDays].sort((x, y) => x - y).join(',');
      return a !== b;
    }
    return current[key] !== original[key];
  });

  const update = (patch: Partial<Draft>) => {
    setDraft({ from: setup, value: { ...current, ...patch } });
  };

  /**
   * Validated here as well as at the boundary.
   *
   * The zod schema and the service reject these too; checking in the form is
   * what lets an operator see *which* field is wrong next to the field, rather
   * than a banner saying the save failed.
   */
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (!TIME_PATTERN.test(current.standardCheckInTime)) {
    errors.standardCheckInTime = 'A 24-hour time, like 14:00.';
  }
  if (!TIME_PATTERN.test(current.standardCheckOutTime)) {
    errors.standardCheckOutTime = 'A 24-hour time, like 11:00.';
  }
  if (!TIME_PATTERN.test(current.nightAuditHour)) {
    errors.nightAuditHour = 'A 24-hour time, like 02:00.';
  }
  const grace = Number(current.turnaroundGraceMins);
  if (!Number.isInteger(grace) || grace < 0 || grace > 1440) {
    errors.turnaroundGraceMins = 'Whole minutes, 0 to 1440.';
  }
  const hold = Number(current.autoHoldReleaseHours);
  if (!Number.isInteger(hold) || hold < 1 || hold > 168) {
    errors.autoHoldReleaseHours = 'Whole hours, 1 to 168.';
  }

  const valid = Object.keys(errors).length === 0;

  const save = () => {
    if (!valid) return;
    const patch: PropertySettings = {
      standardCheckInTime: current.standardCheckInTime,
      standardCheckOutTime: current.standardCheckOutTime,
      turnaroundGraceMins: grace,
      autoHoldReleaseHours: hold,
      nightAuditHour: current.nightAuditHour,
      weekendDays: current.weekendDays,
      // Owned by the General tab; sent unchanged so the patch is explicit
      // about every field it touches rather than relying on absence.
      bookingPrefix: setup.settings.bookingPrefix,
      folioPrefix: setup.settings.folioPrefix,
      invoicePrefix: setup.settings.invoicePrefix,
      gstin: setup.settings.gstin,
    };
    void saveSettings(patch, 'timings');
  };

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Desk times"
        description="Wall-clock times in this property's own timezone. The calendar anchors every reservation strip to them."
        action={
          <SaveBar
            dirty={dirty && valid}
            saving={saving}
            saved={savedTab === 'timings'}
            onSave={save}
            onReset={() => {
              setDraft(null);
            }}
          />
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Check-in from"
            htmlFor="check-in-time"
            hint={`In ${setup.timezone}.`}
            error={errors.standardCheckInTime}
          >
            <TextInput
              id="check-in-time"
              value={current.standardCheckInTime}
              disabled={saving}
              inputMode="numeric"
              invalid={errors.standardCheckInTime !== undefined}
              onChange={(standardCheckInTime) => {
                update({ standardCheckInTime });
              }}
            />
          </Field>
          <Field
            label="Check-out by"
            htmlFor="check-out-time"
            hint="A room checked out in the morning is sellable that night."
            error={errors.standardCheckOutTime}
          >
            <TextInput
              id="check-out-time"
              value={current.standardCheckOutTime}
              disabled={saving}
              inputMode="numeric"
              invalid={errors.standardCheckOutTime !== undefined}
              onChange={(standardCheckOutTime) => {
                update({ standardCheckOutTime });
              }}
            />
          </Field>
          <Field
            label="Turnaround grace (minutes)"
            htmlFor="grace"
            hint="Housekeeping's window between a departure and the next arrival."
            error={errors.turnaroundGraceMins}
          >
            <TextInput
              id="grace"
              value={current.turnaroundGraceMins}
              disabled={saving}
              inputMode="numeric"
              invalid={errors.turnaroundGraceMins !== undefined}
              onChange={(turnaroundGraceMins) => {
                update({ turnaroundGraceMins });
              }}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Operations"
        description="When unconfirmed inventory is released, and when the books close."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Release a hold after (hours)"
            htmlFor="hold"
            hint="An unconfirmed hold stops blocking inventory once this elapses."
            error={errors.autoHoldReleaseHours}
          >
            <TextInput
              id="hold"
              value={current.autoHoldReleaseHours}
              disabled={saving}
              inputMode="numeric"
              invalid={errors.autoHoldReleaseHours !== undefined}
              onChange={(autoHoldReleaseHours) => {
                update({ autoHoldReleaseHours });
              }}
            />
          </Field>
          <Field
            label="Night audit at"
            htmlFor="audit-hour"
            hint={`Scheduled in ${setup.timezone}, independently of the other properties.`}
            error={errors.nightAuditHour}
          >
            <TextInput
              id="audit-hour"
              value={current.nightAuditHour}
              disabled={saving}
              inputMode="numeric"
              invalid={errors.nightAuditHour !== undefined}
              onChange={(nightAuditHour) => {
                update({ nightAuditHour });
              }}
            />
          </Field>
        </div>

        {/* F3: the property's own weekend definition.
            Weekend pricing cannot be built on a guess -- Saturday-Sunday is
            right for a Goa resort, wrong for a Gulf property, and wrong again
            for a city hotel whose peak is Sunday to Thursday. A WEEKEND
            pricing rule asks "is this night a weekend night" and only the
            property can answer. Nothing else in the product reads this yet;
            the timeline's own weekend shading still assumes Saturday and
            Sunday, which is recorded as a known inconsistency. */}
        <fieldset className="mt-4 flex flex-col gap-1.5">
          <legend className="text-sm font-medium">Weekend days</legend>
          <p className="text-xs text-muted-foreground">
            Used by weekend pricing rules on the Rates &amp; inventory screen.
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {DAYS_OF_WEEK.map((day) => {
              const on = current.weekendDays.includes(day);
              return (
                <label
                  key={day}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                    on
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-input bg-background text-muted-foreground hover:bg-accent'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={saving}
                    onChange={() => {
                      update({
                        weekendDays: on
                          ? current.weekendDays.filter((value) => value !== day)
                          : [...current.weekendDays, day].sort((a, b) => a - b),
                      });
                    }}
                    className="size-3.5 accent-primary"
                  />
                  {DAY_OF_WEEK_SHORT[day]}
                </label>
              );
            })}
          </div>
          {current.weekendDays.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No weekend set. Weekend pricing rules will match no nights.
            </p>
          ) : null}
        </fieldset>
      </Section>
    </div>
  );
}

function fromSetup(setup: PropertySetup): Draft {
  return {
    standardCheckInTime: setup.settings.standardCheckInTime,
    standardCheckOutTime: setup.settings.standardCheckOutTime,
    turnaroundGraceMins: String(setup.settings.turnaroundGraceMins),
    autoHoldReleaseHours: String(setup.settings.autoHoldReleaseHours),
    nightAuditHour: setup.settings.nightAuditHour,
    weekendDays: [...setup.settings.weekendDays],
  };
}
