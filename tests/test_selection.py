import pytest

from nava import protocol, selection


def test_all_patterns():
    assert selection.parse_patterns("all") == list(range(128))


def test_bank_letter_expands_to_sixteen():
    assert selection.parse_patterns("C") == list(range(32, 48))


def test_range_and_list():
    assert selection.parse_patterns("A1-A4,B3") == [0, 1, 2, 3, 18]


def test_duplicates_collapse_preserving_order():
    assert selection.parse_patterns("B1,A1,B1") == [16, 0]


def test_backwards_range_rejected():
    with pytest.raises(ValueError, match="backwards"):
        selection.parse_patterns("A4-A1")


def test_tracks_are_one_based_on_the_panel():
    assert selection.parse_tracks("1-3") == [0, 1, 2]
    assert selection.parse_tracks("all") == list(range(protocol.MAX_TRACK))


@pytest.mark.parametrize("spec", ["0", "17", "x"])
def test_bad_track_rejected(spec):
    with pytest.raises(ValueError):
        selection.parse_tracks(spec)
