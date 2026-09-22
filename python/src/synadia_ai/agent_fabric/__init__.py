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
* :func:`build_edge_record`, :func:`trace_record_counts` and the rest of the
  vocabulary.
* :func:`scratch_pad_extension` — the fabric's rules for ScratchPad
  references on ``AgentTools``' three extension hooks, over the agent's own
  client behind the :class:`ScratchPad` port.
* :func:`request_grant`, :func:`grant_request_endpoint` — the grant request,
  both sides: asking a reference's creator to let one more agent read it,
  and answering.
* :func:`find_references`, :func:`remove_references` and the rest of the
  references' vocabulary.

Mirrors the TypeScript package ``@synadia-ai/agent-fabric``; the two are
wire-identical.
"""

from __future__ import annotations

from .grant_request import (
    DEFAULT_GRANT_REQUEST_TIMEOUT_S,
    GRANT_REQUEST_ENDPOINT,
    GrantReply,
    GrantRequest,
    GrantRequestEndpoint,
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
    Grantee,
    GrantKind,
    ScratchPad,
    TraceIds,
    find_references,
    grantee_from_identity,
    reads_references,
    reference_creator,
    remove_references,
)
from .scratchpad_extension import (
    READS_SCRATCHPAD_REFERENCES_FIELD,
    ScratchPadExtension,
    scratch_pad_extension,
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
    "EDGE_RECORD_VERSION",
    "GRANT_REQUEST_ENDPOINT",
    "READS_REFERENCES_KEY",
    "READS_SCRATCHPAD_REFERENCES_FIELD",
    "REFERENCE_PREFIX",
    "ROOT_ID_FIELD",
    "ROOT_ID_HEADER",
    "THREAD_ID_FIELD",
    "THREAD_ID_HEADER",
    "THREAD_ID_HEX_LEN",
    "TOOL_CALL_ID_CONTEXT_KEY",
    "TOOL_CALL_ID_MAX",
    "FabricTracing",
    "GrantKind",
    "GrantReply",
    "GrantRequest",
    "GrantRequestEndpoint",
    "Grantee",
    "ScratchPad",
    "ScratchPadExtension",
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
    "count_trace_record_dropped",
    "count_trace_record_published",
    "encode_grant_reply",
    "encode_grant_request",
    "fabric_tracing",
    "find_references",
    "grant_request_endpoint",
    "grant_subject",
    "grantee_from_identity",
    "is_thread_id",
    "random_thread_id",
    "reads_references",
    "reference_creator",
    "remove_references",
    "request_grant",
    "scratch_pad_extension",
    "trace_headers",
    "trace_record_counts",
    "valid_tool_call_id",
]
