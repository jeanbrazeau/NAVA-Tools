"""The Python half of the cross-implementation contract.

`tests/fixtures/vectors.json` is what the web app is tested against. This asserts
the file still describes what this package actually does, so the fixture cannot
quietly rot into a description of an older `nava` while the browser keeps
matching it.

A failure here means one of two things, and they are fixed differently:

* the change to `nava` was intended - regenerate with
  `uv run python tests/make_vectors.py`, then fix `web/js/` until
  `node --test tests/web/` passes again;
* it was not - the diff below is the regression.
"""

from __future__ import annotations

import json

import pytest

import make_vectors


@pytest.fixture(scope="module")
def committed() -> dict:
    with open(make_vectors.FIXTURE, encoding="utf-8") as handle:
        return json.load(handle)


@pytest.fixture(scope="module")
def generated() -> dict:
    return make_vectors.build()


@pytest.mark.parametrize(
    "section",
    [
        "pack7",
        "messages",
        "pattern_labels",
        "patterns",
        "configs",
        "tracks",
        "selections",
        "ihex",
        "firmware",
        "legend",
    ],
)
def test_section_matches_committed_fixture(committed, generated, section):
    assert generated[section] == committed[section], (
        f"{section} no longer matches tests/fixtures/vectors.json. "
        "If the change was intended, run: uv run python tests/make_vectors.py"
    )


def test_fixture_has_no_extra_sections(committed, generated):
    assert set(committed) == set(generated)
