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
import type { PropertySettings, PropertySetup } from '@repo/types';

import { Field, SaveBar, Section, TextInput } from './fields';
import type { PropertySettingsState } from './use-property-settings';

type Draft = {
  standardCheckInTime: string;
  standardCheckOutTime: string;
  turnaroundGraceMins: string;
  autoHoldReleaseHours: string;
  nightAuditHour: string;
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function TimingsTab({ state }: { state: PropertySettingsState }) {
  const { setup, saving, savedTab, saveSettings } = state;

  const [draft, setDraft] = useState<{ from: PropertySetup; value: Draft } | null>(null);
  const current = draft !== null && draft.from === setup ? draft.value : fromSetup(setup);
  const original = fromSetup(setup);

  const dirty = (Object.keys(original) as (keyof Draft)[]).some(
    (key) => current[key] !== original[key],
  );

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
      // Owned by the General tab; sent unchanged so the patch is explicit
      // about every field it touches rather than relying on absence.
      bookingPrefix: setup.settings.bookingPrefix,
      folioPrefix: setup.settings.folioPrefix,
      invoicePrefix: setup.settings.invoicePrefix,
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
  };
}
