'use client';

/**
 * The property configuration, and the three ways to change it.
 *
 * ===========================================================================
 * One state container for five tabs, because it is one record.
 *
 * Every write returns the whole recomputed configuration, so this replaces its
 * state wholesale rather than patching the field that was edited. That is the
 * same rule the folio page follows and for the same reason: a client that
 * patches one field drifts from the server the first time a write has an
 * effect it did not predict — and here a wrong tax rate is a wrong invoice.
 *
 * **Nothing is optimistic.** A save is one short round trip, and showing a GST
 * rate as saved before the server validated the table would mean showing a
 * figure no guest will ever be charged. The pending flag disables the form; it
 * does not pretend the write already landed.
 *
 * The server payload is *tagged*, not copied into state by an effect. A bare
 * `useState(initial)` captures the first server render forever, so a
 * `router.refresh()` would leave the screen showing configuration the database
 * no longer holds; copying props in an effect is the cascading render
 * `react-hooks/set-state-in-effect` rejects. Tagging gets both right: when a
 * new payload arrives, `from` no longer matches and the fresh one wins.
 * ===========================================================================
 */

import { useCallback, useMemo, useState } from 'react';
import type {
  PropertySetup,
  ReplaceAmenities,
  ReplaceFees,
  ReplacePolicies,
  ReplaceTaxSlabs,
  TaxSlab,
  UpdatePropertySettings,
} from '@repo/types';

import {
  replacePropertyAmenities,
  replacePropertyFees,
  replacePropertyPolicies,
  replacePropertyTaxSlabs,
  updatePropertySettings,
} from '@/lib/properties-client';

export interface PropertySettingsState {
  /** The live configuration: the server's last word on it. */
  setup: PropertySetup;
  /** True while a save is in flight; the forms disable themselves. */
  saving: boolean;
  /** The last failure, for the banner. Cleared when a save succeeds. */
  error: string | null;
  /** Which tab's save last succeeded, for the transient confirmation. */
  savedTab: string | null;
  saveSettings: (patch: UpdatePropertySettings, tabId: string) => Promise<boolean>;
  saveTaxSlabs: (slabs: readonly TaxSlab[], reason: string | null) => Promise<boolean>;
  saveAmenities: (
    amenities: ReplaceAmenities['amenities'],
    reason: string | null,
  ) => Promise<boolean>;
  savePolicies: (
    policies: ReplacePolicies['policies'],
    reason: string | null,
  ) => Promise<boolean>;
  saveFees: (fees: ReplaceFees['fees'], reason: string | null) => Promise<boolean>;
  dismissError: () => void;
}

export function usePropertySettings(
  hotelId: string,
  initial: PropertySetup,
): PropertySettingsState {
  const [local, setLocal] = useState<{ from: PropertySetup; value: PropertySetup } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTab, setSavedTab] = useState<string | null>(null);

  const setup = local !== null && local.from === initial ? local.value : initial;

  /**
   * Runs one save, funnelling both endpoints through the same bookkeeping.
   *
   * Returns whether it succeeded so a tab can keep the operator's edits on
   * screen after a rejection — discarding what they typed because the server
   * disagreed with one field of it is how a form loses ten minutes of work.
   */
  const run = useCallback(
    async (
      request: () => Promise<PropertySetup>,
      tabId: string | null,
    ): Promise<boolean> => {
      setSaving(true);
      setError(null);

      try {
        const next = await request();
        setLocal({ from: initial, value: next });
        setSavedTab(tabId);
        return true;
      } catch (cause) {
        setError(messageFor(cause));
        setSavedTab(null);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [initial],
  );

  const saveSettings = useCallback(
    (patch: UpdatePropertySettings, tabId: string) =>
      run(() => updatePropertySettings(hotelId, patch), tabId),
    [hotelId, run],
  );

  const saveTaxSlabs = useCallback(
    (slabs: readonly TaxSlab[], reason: string | null) => {
      // `id` is the server's, and the endpoint replaces the table rather than
      // updating rows — sending ids back would imply an identity the new rows
      // will not have.
      const body: ReplaceTaxSlabs = {
        slabs: slabs.map(({ id: _id, ...slab }) => slab),
        reason,
      };
      return run(() => replacePropertyTaxSlabs(hotelId, body), 'taxes');
    },
    [hotelId, run],
  );

  const saveAmenities = useCallback(
    (amenities: ReplaceAmenities['amenities'], reason: string | null) =>
      run(() => replacePropertyAmenities(hotelId, { amenities, reason }), 'amenities'),
    [hotelId, run],
  );

  const savePolicies = useCallback(
    (policies: ReplacePolicies['policies'], reason: string | null) =>
      run(() => replacePropertyPolicies(hotelId, { policies, reason }), 'policies'),
    [hotelId, run],
  );

  const saveFees = useCallback(
    (fees: ReplaceFees['fees'], reason: string | null) =>
      run(() => replacePropertyFees(hotelId, { fees, reason }), 'taxes'),
    [hotelId, run],
  );

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  return useMemo(
    () => ({
      setup,
      saving,
      error,
      savedTab,
      saveSettings,
      saveTaxSlabs,
      saveAmenities,
      savePolicies,
      saveFees,
      dismissError,
    }),
    [
      setup,
      saving,
      error,
      savedTab,
      saveSettings,
      saveTaxSlabs,
      saveAmenities,
      savePolicies,
      saveFees,
      dismissError,
    ],
  );
}

/**
 * A failure an operator can act on.
 *
 * The API returns `{ code, message, details }`, and for a validation failure
 * `details.issues` names the fields. Those field messages are the useful part
 * — "A gap sits between Standard and Premium" tells someone what to fix, where
 * "Request failed" tells them to call somebody.
 */
function messageFor(cause: unknown): string {
  if (cause === null || typeof cause !== 'object') {
    return 'The configuration could not be saved.';
  }

  const details = (cause as { details?: unknown }).details;
  if (details !== null && typeof details === 'object') {
    const issues = (details as { issues?: unknown }).issues;
    if (issues !== null && typeof issues === 'object') {
      const messages = Object.values(issues as Record<string, unknown>)
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim());
      if (messages.length > 0) return messages.join(' ');
    }
  }

  const message = (cause as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0
    ? message
    : 'The configuration could not be saved.';
}
