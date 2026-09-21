"""synadia_ai.agent_fabric — the SDK for agents on the Synadia Agent Fabric.

Built on the hooks of the protocol SDK (:mod:`synadia_ai.agents`,
:mod:`synadia_ai.agent_service`); it never reaches into their internals.
Today it carries tracing:

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

Mirrors the TypeScript package ``@synadia-ai/agent-fabric``; the two are
wire-identical.
"""

from __future__ import annotations

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
    "EDGE_RECORD_VERSION",
    "ROOT_ID_FIELD",
    "ROOT_ID_HEADER",
    "THREAD_ID_FIELD",
    "THREAD_ID_HEADER",
    "THREAD_ID_HEX_LEN",
    "TOOL_CALL_ID_CONTEXT_KEY",
    "TOOL_CALL_ID_MAX",
    "FabricTracing",
    "TraceOptions",
    "TraceRecordCounts",
    "TraceScope",
    "TracingPromptInterceptor",
    "TracingRequestInterceptor",
    "active_trace",
    "bind_active_trace",
    "build_edge_record",
    "count_trace_record_dropped",
    "count_trace_record_published",
    "fabric_tracing",
    "is_thread_id",
    "random_thread_id",
    "trace_headers",
    "trace_record_counts",
    "valid_tool_call_id",
]
