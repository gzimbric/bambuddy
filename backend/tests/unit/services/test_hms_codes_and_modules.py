"""HMS full-code descriptions and the retained get_version module list.

The MQTT payloads below are verbatim captures from a Bambu Lab P2S
(fw 01.02.00.00, serial 22E8AJ5C2701365) with the External Exhaust Fan kit,
an AMS 2 Pro, an AMS HT and a Filament Buffer attached, taken 2026-07-29.
Three HMS faults were latched at the time, which is what makes this a useful
fixture: the printer's real `hms[]` array is the exact case that previously
rendered as a bare severity badge with no text.
"""

import pytest

from backend.app.services.bambu_mqtt import BambuMQTTClient
from backend.app.services.hms_codes import catalog_size, get_hms_description

# Real `hms[]` array, as pushed by the printer.
LATCHED_HMS = [
    {"attr": 83887616, "code": 131184, "ts_boot": 32012, "ts_unix": "20260728013743"},
    {"attr": 83886592, "code": 196618, "ts_boot": 119134, "ts_unix": "20260728013910"},
    {"attr": 83886848, "code": 131086, "ts_boot": 163225135, "ts_unix": "20260729225736"},
]

# Real `get_version` module list.
GET_VERSION = {
    "command": "get_version",
    "sequence_id": "9901",
    "module": [
        {
            "name": "ota",
            "product_name": "Bambu Lab P2S",
            "hw_ver": "N/A",
            "sw_ver": "01.02.00.00",
            "loader_ver": "00.00.00.00",
            "sn": "22E8AJ5C2701365",
            "visible": True,
            "flag": 3,
        },
        {
            "name": "n3f/0",
            "product_name": "AMS 2 Pro (1)",
            "hw_ver": "N3F05",
            "sw_ver": "04.00.21.87",
            "loader_ver": "00.00.00.00",
            "sn": "19C51A5B24001LQ",
            "visible": True,
            "flag": 0,
        },
        {
            "name": "n3s/128",
            "product_name": "AMS HT (1)",
            "hw_ver": "N3S05",
            "sw_ver": "02.04.19.86",
            "loader_ver": "00.00.00.00",
            "sn": "19F51A6514002GS",
            "visible": True,
            "flag": 0,
        },
        {
            "name": "ahb",
            "product_name": "Filament Buffer - for P2",
            "hw_ver": "AHB-N703",
            "sw_ver": "01.01.16.19",
            "loader_ver": "00.00.05.29",
            "sn": "22F42A5C1015541",
            "visible": True,
            "flag": 0,
        },
        {
            "name": "eef",
            "product_name": "Bambu Lab External Exhaust Fan",
            "hw_ver": "EEF01",
            "sw_ver": "00.00.13.35",
            "loader_ver": "00.00.00.24",
            "sn": "33N42A630635182",
            "visible": True,
            "flag": 0,
        },
        # Internal boards: product_name is empty and visible is False.
        {
            "name": "th",
            "product_name": "",
            "hw_ver": "TH03",
            "sw_ver": "03.00.25.82",
            "loader_ver": "00.00.00.10",
            "sn": "22D06A5B2234006",
            "visible": False,
            "flag": 0,
        },
        {
            "name": "smc",
            "product_name": "",
            "hw_ver": "SMC01",
            "sw_ver": "02.00.13.93",
            "loader_ver": "00.00.06.03",
            "sn": "22V06A5C1523500",
            "visible": False,
            "flag": 0,
        },
        {
            "name": "mc",
            "product_name": "",
            "hw_ver": "MC06",
            "sw_ver": "03.00.85.33",
            "loader_ver": "00.01.02.14",
            "sn": "22C06A5C1523500",
            "visible": False,
            "flag": 0,
        },
        {
            "name": "ap2",
            "product_name": "",
            "hw_ver": "AP02",
            "sw_ver": "00.00.28.53",
            "loader_ver": "00.00.02.04",
            "sn": "22E8AJ5C2701365",
            "visible": False,
            "flag": 0,
        },
    ],
}

# Real upgrade_state from the same pushall. Every *_new_version_number is empty
# because the printer is in LAN-only mode and learns of new versions from the cloud.
UPGRADE_STATE = {
    "ahb_new_version_number": "",
    "ams_new_version_number": "",
    "consistency_request": False,
    "dis_state": 0,
    "err_code": 0,
    "ext_new_version_number": "",
    "force_upgrade": False,
    "idx": 9,
    "lower_limit": "00.00.00.00",
    "message": "",
    "module": "",
    "new_version_state": 0,
    "ota_new_version_number": "",
    "progress": "0",
    "sequence_id": 0,
    "sn": "22E8AJ5C2701365",
    "status": "IDLE",
}


@pytest.fixture
def client():
    return BambuMQTTClient(
        ip_address="10.0.0.1",
        serial_number="22E8AJ5C2701365",
        access_code="00000000",
        model="P2S",
    )


# --------------------------------------------------------------- catalogue only


def test_catalog_covers_bambus_published_hms_codes():
    assert catalog_size() == 557


def test_full_code_lookup_tolerates_separators_and_case():
    canonical = get_hms_description("050003000002000E", "P2S")
    assert canonical
    assert get_hms_description("0500-0300-0002-000e", "P2S") == canonical
    assert get_hms_description("0500_0300_0002_000E", "p2s") == canonical


def test_internal_model_code_is_aliased_to_the_marketing_name():
    """PrinterState.model can hold the SSDP code (N7) rather than "P2S"."""
    assert get_hms_description("050003000002000E", "N7") == get_hms_description("050003000002000E", "P2S")


def test_unknown_code_returns_none_rather_than_a_placeholder():
    assert get_hms_description("DEADBEEFDEADBEEF", "P2S") is None
    assert get_hms_description("", "P2S") is None
    assert get_hms_description("not-a-code", "P2S") is None


def test_model_specific_wording_is_preferred_when_it_exists():
    """0300_0200_0001_0001 is worded per-printer: single- vs right-extruder."""
    single = get_hms_description("0300020000010001", "P2S")
    dual = get_hms_description("0300020000010001", "H2D")
    assert single and dual
    assert single != dual
    assert "right extruder" in dual.lower()
    assert "right extruder" not in single.lower()


def test_short_code_family_is_disjoint_from_the_hms_family():
    """The regression this whole module exists for.

    An `hms[]` code truncated to the 8-hex `print_error` form can never hit
    HMS_ERROR_DESCRIPTIONS, because HMS code_low values never carry the severity
    nibble that every print_error code has.
    """
    from backend.app.services.hms_errors import get_error_description

    attr, code = 0x05000300, 0x0002000E
    short_code = f"{(attr >> 16) & 0xFFFF:04X}_{code & 0xFFFF:04X}"
    assert short_code == "0500_000E"
    assert get_error_description(short_code) is None
    assert get_hms_description(f"{attr:08X}{code:08X}", "P2S") is not None


# ------------------------------------------------------------- hms[] parse path


def test_latched_hms_faults_get_descriptions_where_bambu_documents_them(client):
    client._update_state({"hms": LATCHED_HMS})

    errors = {e.full_code: e for e in client.state.hms_errors}
    assert set(errors) == {"050006000002 0070".replace(" ", ""), "050002000003000A", "050003000002000E"}

    documented = errors["050003000002000E"]
    assert "incompatible with the printer's firmware version" in documented.message

    # The other two are genuinely absent from Bambu's published catalogue, so an
    # empty message is the correct outcome — the frontend keeps its own fallback.
    assert errors["0500060000020070"].message == ""
    assert errors["050002000003000A"].message == ""


def test_severity_comes_from_the_code_not_from_attrs_part_byte(client):
    """Regression: `(attr >> 8) & 0xF` read the part id, which is unbounded.

    0500_0600_0002_0070 yielded 6 — outside the documented 1-4 range.
    """
    client._update_state({"hms": LATCHED_HMS})
    severities = {e.full_code: e.severity for e in client.state.hms_errors}

    assert severities["0500060000020070"] == 2  # serious, was 6
    assert severities["050002000003000A"] == 3  # common, was 2
    assert severities["050003000002000E"] == 2  # serious, was 3
    assert all(1 <= s <= 4 for s in severities.values())


def test_module_id_still_comes_from_attr(client):
    client._update_state({"hms": LATCHED_HMS})
    assert {e.module for e in client.state.hms_errors} == {0x05}


def test_print_error_path_still_uses_the_short_code_table(client):
    """print_error is the 8-hex family, so its descriptions must not regress."""
    client._update_state({"print_error": 0x05004005})
    (error,) = client.state.hms_errors
    assert error.full_code == "05004005"
    assert "updating firmware" in error.message


# ------------------------------------------------------- get_version parse path


def test_every_reported_module_is_retained_in_firmware_order(client):
    client._handle_version_info(GET_VERSION)

    names = [m["name"] for m in client.state.modules]
    assert names == ["ota", "n3f/0", "n3s/128", "ahb", "eef", "th", "smc", "mc", "ap2"]


def test_ota_module_still_drives_firmware_version(client):
    client._handle_version_info(GET_VERSION)
    assert client.state.firmware_version == "01.02.00.00"


def test_accessory_kit_versions_are_exposed(client):
    """The External Exhaust Fan kit reports its own firmware; it used to be dropped."""
    client._handle_version_info(GET_VERSION)
    eef = next(m for m in client.state.modules if m["name"] == "eef")
    assert eef["product_name"] == "Bambu Lab External Exhaust Fan"
    assert eef["sw_ver"] == "00.00.13.35"
    assert eef["hw_ver"] == "EEF01"
    assert eef["loader_ver"] == "00.00.00.24"
    assert eef["visible"] is True


def test_internal_boards_are_marked_not_visible_and_have_no_product_name(client):
    client._handle_version_info(GET_VERSION)
    internal = [m for m in client.state.modules if not m["visible"]]
    assert {m["name"] for m in internal} == {"th", "smc", "mc", "ap2"}
    assert all(m["product_name"] == "" for m in internal)
    assert all(m["sw_ver"] for m in internal)


def test_module_versions_are_independent_of_the_ota_version(client):
    """Why there is no divergence-vs-ota flag.

    The mainboard reports a 03.x line against ota's 01.x. Comparing the two would
    mark every internal board as out of date forever.
    """
    client._handle_version_info(GET_VERSION)
    by_name = {m["name"]: m["sw_ver"] for m in client.state.modules}
    assert by_name["ota"].startswith("01.")
    assert by_name["mc"].startswith("03.")


def test_malformed_module_entries_are_skipped(client):
    client._handle_version_info({"command": "get_version", "module": [{"no_name": 1}, "junk", None]})
    assert client.state.modules == []


def test_ams_firmware_extraction_is_unchanged(client):
    """The pre-existing AMS cache must keep working alongside the retained list."""
    client._handle_version_info(GET_VERSION)
    assert client._ams_version_cache[0]["sw_ver"] == "04.00.21.87"
    assert client._ams_version_cache[0]["module_type"] == "n3f"
    assert client._ams_version_cache[128]["sw_ver"] == "02.04.19.86"


# ------------------------------------------------------------------ upgrade_state


def test_upgrade_state_is_retained_verbatim(client):
    client._update_state({"upgrade_state": UPGRADE_STATE})
    assert client.state.upgrade_state == UPGRADE_STATE


def test_lan_only_printer_announces_no_new_versions(client):
    """Guards the honesty rule: absent announcement is unknown, not up to date."""
    client._update_state({"upgrade_state": UPGRADE_STATE})
    state = client.state.upgrade_state
    assert all(
        not state[field]
        for field in (
            "ota_new_version_number",
            "ams_new_version_number",
            "ahb_new_version_number",
            "ext_new_version_number",
        )
    )
    assert state["consistency_request"] is False


def test_non_dict_upgrade_state_is_ignored(client):
    client._update_state({"upgrade_state": "IDLE"})
    assert client.state.upgrade_state is None
