"""A subject that can never be published to fails at construction.

Edge publishing is fail-open, so without this check a misconfigured
``edge_subject`` would only ever show up as a logged exception on every
prompt. ``TraceOptions`` is the single place :func:`fabric_tracing` accepts
it, so it validates itself. The TypeScript package applies the same rules.
"""

from __future__ import annotations

import pytest

from synadia_ai.agent_fabric import DEFAULT_EDGE_SUBJECT, TraceOptions, fabric_tracing


@pytest.mark.parametrize(
    "subject",
    [DEFAULT_EDGE_SUBJECT, None, "acme.TRACE.edges.v2"],
    ids=["default", "propagate-only", "deeper"],
)
def test_accepts_a_publishable_subject(subject: str | None) -> None:
    assert TraceOptions(edge_subject=subject).edge_subject == subject


def test_the_defaults_are_valid() -> None:
    assert TraceOptions().edge_subject == DEFAULT_EDGE_SUBJECT == "TRACE.edges"


@pytest.mark.parametrize(
    "subject",
    [
        "",
        "TRACE..edges",
        "TRACE.edges.",
        "TRACE edges",
        "TRACE\x00edges",
        "TRACE.\ufeffedges",
        "TRACE.\x1cedges",
        "TRACE.*",
        "TRACE.>",
        "TRACE.ed>ges",
    ],
    ids=[
        "empty",
        "empty-token",
        "trailing-dot",
        "whitespace",
        "nul",
        "byte-order-mark",
        "c0-separator",
        "star",
        "full-wildcard",
        "wildcard-inside-token",
    ],
)
def test_rejects_a_subject_that_can_never_be_published_to(subject: str) -> None:
    with pytest.raises(ValueError, match="edge_subject"):
        TraceOptions(edge_subject=subject)


def test_fabric_tracing_takes_the_defaults_and_propagate_only_mode() -> None:
    fabric_tracing()
    fabric_tracing(TraceOptions())
    fabric_tracing(TraceOptions(edge_subject=None))


def test_fabric_tracing_refuses_anything_but_trace_options() -> None:
    with pytest.raises(TypeError):
        fabric_tracing({"edge_subject": None})  # type: ignore[arg-type]
