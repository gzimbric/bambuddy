import { describe, it, expect } from 'vitest';
import { filterKnownHMSErrors, selectUndocumentedHMSErrors } from '../../components/HMSErrorModal';
import type { HMSError } from '../../api/client';

// #2728 splits into two questions that one function used to answer badly:
//   what COUNTS (badges, pips, "has a problem")  -> filterKnownHMSErrors
//   what is DISPLAYED in the modal               -> plus selectUndocumentedHMSErrors
//
// The codes below are real. All three were latched on the P2S in #2728; the two
// undocumented ones appear nowhere in the 3397 codes Bambu's HMS index publishes,
// so no catalogue work can ever resolve them. The printer's own screen does not
// surface them either, which is why they must not raise an alert in Bambuddy.
const UNDOCUMENTED_A = '0500060000020070';
const UNDOCUMENTED_B = '050002000003000A';
const DOCUMENTED = '050003000002000E';

const hms = (over: Partial<HMSError> = {}): HMSError => ({
  code: '0x20070',
  attr: 0x05000600,
  module: 0x05,
  severity: 2,
  full_code: UNDOCUMENTED_A,
  ...over,
});

describe('filterKnownHMSErrors — what counts (#2728)', () => {
  it('does not count an undocumented hms[] fault', () => {
    expect(filterKnownHMSErrors([hms()])).toHaveLength(0);
  });

  it('counts a documented hms[] fault the backend resolved', () => {
    const e = hms({ full_code: DOCUMENTED, message: 'Nozzle temperature malfunction.' });
    expect(filterKnownHMSErrors([e])).toHaveLength(1);
  });

  it('still counts a fault carrying firmware actions (the #1840 branch)', () => {
    expect(filterKnownHMSErrors([hms({ actions: ['CHECK_FILAMENT'] })])).toHaveLength(1);
  });
});

describe('selectUndocumentedHMSErrors — what is displayed anyway (#2728)', () => {
  it('surfaces an undocumented hms[] fault so it can still be seen', () => {
    expect(selectUndocumentedHMSErrors([hms()])).toHaveLength(1);
  });

  it('surfaces the second undocumented P2S fault too', () => {
    const e = hms({ code: '0x3000a', attr: 0x05000200, full_code: UNDOCUMENTED_B });
    expect(selectUndocumentedHMSErrors([e])).toHaveLength(1);
  });

  it('does not repeat a fault that already counts', () => {
    const e = hms({ full_code: DOCUMENTED, message: 'Nozzle temperature malfunction.' });
    expect(selectUndocumentedHMSErrors([e])).toHaveLength(0);
  });

  it('ignores 8-hex print_error faults — this is an hms[]-only concern', () => {
    const e = hms({ code: '0xdead', attr: 0x0500dead, full_code: '0500DEAD' });
    expect(selectUndocumentedHMSErrors([e])).toHaveLength(0);
  });

  it('ignores a fault with no full_code rather than assuming it is hms[]', () => {
    expect(selectUndocumentedHMSErrors([hms({ full_code: undefined })])).toHaveLength(0);
  });

  it('the two lists are complementary and never overlap', () => {
    const all = [
      hms(),
      hms({ code: '0x3000a', attr: 0x05000200, full_code: UNDOCUMENTED_B }),
      hms({ full_code: DOCUMENTED, message: 'Nozzle temperature malfunction.' }),
      hms({ actions: ['CHECK_FILAMENT'] }),
    ];
    const counted = filterKnownHMSErrors(all);
    const shown = selectUndocumentedHMSErrors(all);
    expect(counted).toHaveLength(2);
    expect(shown).toHaveLength(2);
    expect(counted.filter((e) => shown.includes(e))).toHaveLength(0);
  });
});
