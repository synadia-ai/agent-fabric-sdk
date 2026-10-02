"""synadia_ai.agent_fabric — the SDK for agents on the Synadia Agent Fabric.

Built on the hooks of the protocol SDK (:mod:`synadia_ai.agents`,
:mod:`synadia_ai.agent_service`); it never reaches into their internals.
It carries tracing and the agent tools' ScratchPad extension:

* :func:`fabric_tracing` — the prompt interceptor, the request interceptor
  and the heartbeat extras provider the SDK takes, which together publish
  the signed edge record before each prompt, carry ``thread_id`` /
  ``root_id`` in the envelope, adopt or mint them on the host, and report
  the record counts on the heartbeat.
* :func:`trace_headers` — ``X-Synadia-Thread-ID`` / ``X-Synadia-Root-ID``
  for the model calls a handler makes.
* :func:`active_trace`, :func:`bind_active_trace` — the ambient scope.
* :func:`durable_run_id`, :func:`durable_trace`, :func:`durable_headers` — a
  durable run joined to the task that started it: its run id, the trace for
  its input, the proxy's headers inside a step.
* :func:`build_edge_record`, :func:`trace_record_counts` and the rest of the
  vocabulary.
* :func:`served_publisher`, :func:`build_served_record` — the ``served``
  record, a harness plugin's binding of a served thread to the harness's
  own thread id, and its publisher over the plugin's client.
* :func:`scratch_pad_extension` — the fabric's rules for ScratchPad
  references on ``AgentTools``' three extension hooks, over the agent's own
  client behind the :class:`ScratchPad` port.
* :func:`native_scratchpad`, :func:`native_scratchpad_from_env` — the native
  implementation of that port, binary artifact access, and durable recovery
  on the agent's existing NATS connection. Native operations need Python 3.12+.
  :func:`scratchpad_reader` opens a reader without a writer workspace.
* :class:`SpCliScratchPad`, :func:`scratchpad_from_env` — the optional
  implementation over the sp v2 command line. :class:`ScratchPadError`
  reports CLI failures; :class:`NativeScratchPadError` reports native failures.
* :func:`request_grant`, :func:`grant_request_endpoint` — the grant request,
  both sides: asking a reference's creator to let one more agent read it,
  and answering.
* :func:`find_references`, :func:`remove_references` and the rest of the
  references' vocabulary.

Mirrors the TypeScript package ``@synadia-ai/agent-fabric``; the two are
wire-identical.
"""

from __future__ import annotations

from .durable import DurableTrace, durable_headers, durable_run_id, durable_trace
from .grant_request import (
    DEFAULT_GRANT_REQUEST_TIMEOUT_S,
    GRANT_REQUEST_ENDPOINT,
    GrantReply,
    GrantRequest,
    answer_grant_request,
    encode_grant_reply,
    encode_grant_request,
    grant_request_endpoint,
    grant_subject,
    request_grant,
)
from .scratchpad import (
    READS_REFERENCES_KEY,
    REFERENCE_PREFIX,
    SHORT_REFERENCE_PREFIX,
    Grantee,
    GrantKind,
    ResolvesReferences,
    ScratchPad,
    TraceIds,
    find_references,
    grantee_from_identity,
    reads_references,
    reference_creator,
    remove_references,
)
from .scratchpad_cli import (
    DEFAULT_GRANT_TTL_S,
    DEFAULT_SP_BIN,
    SCRATCHPAD_BIN_VAR,
    SCRATCHPAD_DIR_VAR,
    SCRATCHPAD_GRANT_TTL_S_VAR,
    SCRATCHPAD_VOLUME_VAR,
    ScratchPadClient,
    ScratchPadError,
    SpCliConnection,
    SpCliScratchPad,
    scratchpad_from_env,
)
from .scratchpad_extension import (
    READS_SCRATCHPAD_REFERENCES_FIELD,
    ScratchPadExtension,
    scratch_pad_extension,
)
from .scratchpad_native import (
    DEFAULT_READ_LIMIT_BYTES,
    NativeScratchPad,
    NativeScratchPadError,
    ScratchPadReader,
    decode_reference,
    decode_short_reference,
    encode_reference,
    native_scratchpad,
    native_scratchpad_from_env,
    scratchpad_reader,
)
from .served import (
    HARNESS_THREAD_ID_MAX,
    SERVED_RECORD_VERSION,
    Harness,
    ServedPhase,
    ServedPublisher,
    ServedStatus,
    ServedTurn,
    build_served_record,
    served_publisher,
    unix_seconds,
    valid_harness_thread_id,
)
from .trace import (
    DEFAULT_EDGE_SUBJECT,
    EDGE_RECORD_VERSION,
    ROOT_ID_FIELD,
    ROOT_ID_HEADER,
    THREAD_ID_FIELD,
    THREAD_ID_HEADER,
    THREAD_ID_HEX_LEN,
    TOOL_CALL_ID_MAX,
    TraceOptions,
    TraceRecordCounts,
    TraceScope,
    active_trace,
    bind_active_trace,
    build_edge_record,
    count_trace_record_dropped,
    count_trace_record_published,
    is_thread_id,
    random_thread_id,
    trace_headers,
    trace_record_counts,
    valid_tool_call_id,
)
from .tracing import (
    TOOL_CALL_ID_CONTEXT_KEY,
    FabricTracing,
    TracingPromptInterceptor,
    TracingRequestInterceptor,
    fabric_tracing,
)

__all__ = [
    "DEFAULT_EDGE_SUBJECT",
    "DEFAULT_GRANT_REQUEST_TIMEOUT_S",
    "DEFAULT_GRANT_TTL_S",
    "DEFAULT_READ_LIMIT_BYTES",
    "DEFAULT_SP_BIN",
    "EDGE_RECORD_VERSION",
    "GRANT_REQUEST_ENDPOINT",
    "HARNESS_THREAD_ID_MAX",
    "READS_REFERENCES_KEY",
    "READS_SCRATCHPAD_REFERENCES_FIELD",
    "REFERENCE_PREFIX",
    "ROOT_ID_FIELD",
    "ROOT_ID_HEADER",
    "SCRATCHPAD_BIN_VAR",
    "SCRATCHPAD_DIR_VAR",
    "SCRATCHPAD_GRANT_TTL_S_VAR",
    "SCRATCHPAD_VOLUME_VAR",
    "SERVED_RECORD_VERSION",
    "SHORT_REFERENCE_PREFIX",
    "THREAD_ID_FIELD",
    "THREAD_ID_HEADER",
    "THREAD_ID_HEX_LEN",
    "TOOL_CALL_ID_CONTEXT_KEY",
    "TOOL_CALL_ID_MAX",
    "DurableTrace",
    "FabricTracing",
    "GrantKind",
    "GrantReply",
    "GrantRequest",
    "Grantee",
    "Harness",
    "NativeScratchPad",
    "NativeScratchPadError",
    "ResolvesReferences",
    "ScratchPad",
    "ScratchPadClient",
    "ScratchPadError",
    "ScratchPadExtension",
    "ScratchPadReader",
    "ServedPhase",
    "ServedPublisher",
    "ServedStatus",
    "ServedTurn",
    "SpCliConnection",
    "SpCliScratchPad",
    "TraceIds",
    "TraceOptions",
    "TraceRecordCounts",
    "TraceScope",
    "TracingPromptInterceptor",
    "TracingRequestInterceptor",
    "active_trace",
    "answer_grant_request",
    "bind_active_trace",
    "build_edge_record",
    "build_served_record",
    "count_trace_record_dropped",
    "count_trace_record_published",
    "decode_reference",
    "decode_short_reference",
    "durable_headers",
    "durable_run_id",
    "durable_trace",
    "encode_grant_reply",
    "encode_grant_request",
    "encode_reference",
    "fabric_tracing",
    "find_references",
    "grant_request_endpoint",
    "grant_subject",
    "grantee_from_identity",
    "is_thread_id",
    "native_scratchpad",
    "native_scratchpad_from_env",
    "random_thread_id",
    "reads_references",
    "reference_creator",
    "remove_references",
    "request_grant",
    "scratch_pad_extension",
    "scratchpad_from_env",
    "scratchpad_reader",
    "served_publisher",
    "trace_headers",
    "trace_record_counts",
    "unix_seconds",
    "valid_harness_thread_id",
    "valid_tool_call_id",
]
