"""The package's own export surface.

``__all__`` is what ``from synadia_ai.agent_fabric import *`` promises. A
name listed there but never imported into ``__init__`` makes the star
import raise ``AttributeError`` — and the ordinary ``from ... import name``
fails too.
"""

from __future__ import annotations

import synadia_ai.agent_fabric as m

PUBLIC = {
    # The hooks the SDK takes.
    "fabric_tracing",
    "FabricTracing",
    "TraceOptions",
    # The ambient scope and the proxy headers.
    "active_trace",
    "bind_active_trace",
    "trace_headers",
    "TraceScope",
    # A durable run joined to the task that started it.
    "durable_run_id",
    "durable_trace",
    "durable_headers",
    "DurableTrace",
    # The edge record and the record counts.
    "build_edge_record",
    "trace_record_counts",
    "TraceRecordCounts",
    # The served record and its publisher.
    "build_served_record",
    "valid_harness_thread_id",
    "served_publisher",
    "ServedPublisher",
    "ServedTurn",
    "Harness",
    "ServedPhase",
    "ServedStatus",
    "SERVED_RECORD_VERSION",
    "HARNESS_THREAD_ID_MAX",
    # The ScratchPad extension, its port and its vocabulary.
    "scratch_pad_extension",
    "ScratchPadExtension",
    "ScratchPad",
    "Grantee",
    "GrantKind",
    "TraceIds",
    "find_references",
    "remove_references",
    "reference_creator",
    "reads_references",
    "grantee_from_identity",
    "READS_REFERENCES_KEY",
    # The port's implementation over the sp CLI, and from the environment.
    "ScratchPadClient",
    "ScratchPadError",
    "SpCliScratchPad",
    "SpCliConnection",
    "scratchpad_from_env",
    # The grant request, both sides.
    "request_grant",
    "grant_request_endpoint",
    "answer_grant_request",
    "encode_grant_request",
    "encode_grant_reply",
    "grant_subject",
}


def test_every_name_in_all_is_importable() -> None:
    missing = [name for name in m.__all__ if not hasattr(m, name)]
    assert missing == [], f"__all__ lists names that do not exist: {missing}"


def test_star_import_does_not_raise() -> None:
    exec("from synadia_ai.agent_fabric import *", {})


def test_the_public_surface_is_exported() -> None:
    assert set(m.__all__) >= PUBLIC
