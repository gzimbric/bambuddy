import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SettingsPage saves through two hand-maintained lists:
 *
 *   1. `hasChanges` — a boolean chain comparing each field against the server
 *      copy. A field missing here means the debounced auto-save never fires.
 *   2. `settingsToSave` — the object actually PUT to the API. A field missing
 *      here means the save fires but omits that field.
 *
 * Miss either and the toggle appears to work, then silently reverts on reload —
 * no error, no failed request, nothing in the network tab except GETs. That is
 * exactly how the dev-mode sub-options shipped broken: they were added to the
 * schema, the API, the bool coercion and the UI, but not to these two lists.
 *
 * Rather than assert a fixed field list (which would need maintaining too, and
 * would just move the problem), this walks every field the page *renders a
 * control for* and checks it appears in both lists.
 */

const source = readFileSync(
  resolve(__dirname, '../../pages/SettingsPage.tsx'),
  'utf-8',
);

/** Fields the page mutates via updateSetting(...) — i.e. has a real control for. */
function fieldsWithControls(): string[] {
  const found = new Set<string>();
  // updateSetting('field', ...) and updateSetting("field", ...)
  for (const m of source.matchAll(/updateSetting\(\s*['"]([a-z0-9_]+)['"]/g)) {
    found.add(m[1]);
  }
  // The dev sub-options go through a data-driven map: key: 'field' as const
  for (const m of source.matchAll(/key:\s*['"]([a-z0-9_]+)['"]\s+as const/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

function hasChangesBlock(): string {
  const start = source.indexOf('const hasChanges =');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('if (!hasChanges)', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function settingsToSaveBlock(): string {
  const start = source.indexOf('const settingsToSave: AppSettingsUpdate = {');
  expect(start).toBeGreaterThan(-1);
  // Ends at the mutate call that consumes it.
  const end = source.indexOf('updateMutation.mutate(', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('SettingsPage save-path completeness', () => {
  const controls = fieldsWithControls();

  it('finds the controls it is supposed to check', () => {
    // Guard against the regexes silently matching nothing and the suite passing vacuously.
    expect(controls.length).toBeGreaterThan(20);
    expect(controls).toContain('developer_mode');
    expect(controls).toContain('dev_perf_overlay');
  });

  it('every field with a control is compared in hasChanges', () => {
    const block = hasChangesBlock();
    const missing = controls.filter((f) => !block.includes(`settings.${f}`));
    expect(
      missing,
      `these fields have a control but are never compared, so editing them ` +
        `never triggers a save and the value reverts on reload: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every field with a control is included in settingsToSave', () => {
    const block = settingsToSaveBlock();
    const missing = controls.filter((f) => !new RegExp(`\\b${f}:`).test(block));
    expect(
      missing,
      `these fields have a control but are never sent to the API, so the save ` +
        `fires without them: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
