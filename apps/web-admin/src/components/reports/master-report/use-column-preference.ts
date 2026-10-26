'use client';

/**
 * Remembers which columns an operator chose.
 *
 * ===========================================================================
 * `localStorage`, per property, and the page works without it.
 *
 * The brief offered a database preferences endpoint as an alternative. There is
 * no user-preference table in this schema, and adding one for a column list
 * would be a migration plus an endpoint plus a cache for something that is
 * genuinely per-browser — the operator who widens this table on their desk
 * machine does not want the same forty columns on a phone.
 *
 * Stored **per property**, because a city hotel and a resort are read
 * differently and a shared key would make switching property silently
 * rearrange the report.
 *
 * Every read and write is wrapped: storage throws in a private window, comes
 * back empty when site data is cleared, and is absent during a thumbnail
 * capture. The default preset is what the page renders when any of that
 * happens, so a broken storage is a cosmetic loss rather than a blank table.
 *
 * The URL still wins. A link someone was sent carries its own columns and must
 * show those, not the recipient's saved preference — so the hook only supplies
 * a default for when the URL says nothing.
 * ===========================================================================
 */

import { useCallback } from 'react';
import { MASTER_REPORT_DEFAULT_COLUMNS, resolveMasterReportColumns } from '@repo/types';

const KEY_PREFIX = 'easeit.master-report.columns';

function storageKey(hotelId: string): string {
  return `${KEY_PREFIX}.${hotelId}`;
}

/** The saved selection, or null when there is none to read. */
export function readColumnPreference(hotelId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(storageKey(hotelId));
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    const keys = parsed.filter((entry): entry is string => typeof entry === 'string');
    // Run it through the same resolver the server uses, so a preference
    // naming a column since withdrawn degrades to the rest rather than
    // rendering a header with no data under it.
    const resolved = resolveMasterReportColumns(keys).map((column) => column.key);
    return resolved.length > 0 ? resolved : null;
  } catch {
    // Private window, blocked site data, or malformed JSON. The caller falls
    // back to the default preset.
    return null;
  }
}

export interface ColumnPreference {
  save: (keys: readonly string[]) => void;
  clear: () => void;
  defaults: readonly string[];
}

export function useColumnPreference(hotelId: string): ColumnPreference {
  const save = useCallback(
    (keys: readonly string[]) => {
      try {
        window.localStorage.setItem(storageKey(hotelId), JSON.stringify([...keys]));
      } catch {
        // Nothing to do and nothing worth telling the operator: the columns
        // they just chose are applied either way, they simply will not
        // survive a reload.
      }
    },
    [hotelId],
  );

  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey(hotelId));
    } catch {
      /* As above. */
    }
  }, [hotelId]);

  return { save, clear, defaults: MASTER_REPORT_DEFAULT_COLUMNS };
}
