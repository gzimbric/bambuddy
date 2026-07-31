"""HMS code descriptions, keyed by the printer's full 16-hex HMS identifier.

Bambu printers report faults through two structurally distinct code families,
and Bambuddy has only ever had descriptions for one of them:

* ``print_error`` — a 32-bit value rendered as an 8-hex short code
  (``0500_8061``). The low 16 bits always carry a severity nibble, so these
  codes are ``4xxx`` / ``8xxx`` / ``Cxxx``. This family is what
  :mod:`backend.app.services.hms_errors` (``HMS_ERROR_DESCRIPTIONS``) and
  ``hms_actions.json`` are keyed by.

* ``hms[]`` — an array of ``{"attr": u32, "code": u32}`` objects rendered as a
  64-bit, 16-hex identifier (``0500_0300_0002_000E``). Here the severity lives
  in the *high* half of ``code``, so the low 16 bits are small ordinals
  (``000E``, ``0070``) and never carry a severity nibble.

Truncating an ``hms[]`` fault to the 8-hex short form (``attr >> 16`` +
``code & 0xFFFF``) therefore produces a key that can never match
``HMS_ERROR_DESCRIPTIONS`` — the two families are disjoint by construction, not
by accident. Across Bambu's published catalogue of 557 HMS codes, that
truncation also collapses them onto just 176 distinct short keys (``0300_0001``
alone absorbs 65 different faults), so the short form cannot be made to work
even in principle. Hence this separate, full-code-keyed table.

Data file: ``backend/app/data/hms_codes.json``. See its ``_source`` field for
provenance — the descriptions are Bambu's own English wording, with a small
number machine-translated from the Chinese pages where no English source
existed.
"""

import json
import re
from pathlib import Path

_DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "hms_codes.json"

# Loaded eagerly at import, matching hms_actions.py — ~145KB read once.
with _DATA_FILE.open("r", encoding="utf-8") as _f:
    _payload: dict = json.load(_f)

_CODES: dict[str, list[dict]] = _payload.get("codes", {})

# Internal SSDP/firmware model codes that appear in PrinterState.model instead of
# the marketing name Bambu's code tables use. Mirrors camera_profiles._MODEL_ALIASES.
_MODEL_ALIASES: dict[str, str] = {
    "N7": "P2S",
    "N2S": "X1E",
    "BL_P001": "X1",
    "BL_P002": "X1C",
    "C11": "P1P",
    "C12": "P1S",
    "C13": "X1E",
    "N1": "A1MINI",
    "N2": "A1",
}


def _normalise_model(model: str | None) -> str:
    """Reduce a model string to the comparison form used in the data file."""
    key = re.sub(r"[^A-Z0-9]", "", (model or "").upper())
    return _MODEL_ALIASES.get(key, key)


def get_hms_description(full_code: str, model: str | None = None) -> str | None:
    """Look up the English description for a 16-hex ``hms[]`` identifier.

    Args:
        full_code: The firmware's matching key, ``f"{attr:08X}{code:08X}"``.
            Separators (``-`` or ``_``) and case are tolerated.
        model: Optional printer model. 32 of the 557 codes have printer-specific
            wording; when the model matches one of those variants it is
            preferred, otherwise the widest-applicability entry is returned.

    Returns:
        The description, or ``None`` if the code is not in Bambu's published
        catalogue. Two of the three codes latched on the author's own P2S are
        genuinely absent from it, so ``None`` is an expected outcome and callers
        must keep their existing fallback.
    """
    key = re.sub(r"[^0-9A-F]", "", (full_code or "").upper())
    entries = _CODES.get(key)
    if not entries:
        return None

    wanted = _normalise_model(model)
    if wanted:
        for entry in entries:
            if wanted in entry.get("m", ()):
                return entry.get("d") or None

    # Entries are pre-sorted widest-applicability first by the generator.
    return entries[0].get("d") or None


def get_hms_entry(full_code: str, model: str | None = None) -> dict | None:
    """Like :func:`get_hms_description` but returns the whole record.

    Useful for surfacing provenance (``s``) or the applicable-model list (``m``)
    in diagnostics without a second lookup.
    """
    key = re.sub(r"[^0-9A-F]", "", (full_code or "").upper())
    entries = _CODES.get(key)
    if not entries:
        return None
    wanted = _normalise_model(model)
    if wanted:
        for entry in entries:
            if wanted in entry.get("m", ()):
                return entry
    return entries[0]


def catalog_size() -> int:
    """Number of distinct HMS codes bundled. Exposed for tests and diagnostics."""
    return len(_CODES)
