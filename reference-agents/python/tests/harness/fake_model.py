"""A fake model on the proxy's path, for the agent tests.

It records every request (headers and body) and plays a model with four
moves: on a ``tool`` message that carries a question it asks for
``answer_agent``, answering "yes"; on any other ``tool`` message it answers
with the tool's result; on a user message containing ``delegate to <address>``
it asks for ``prompt_agent`` to that address, with ``ping`` or with the text
after ``: ``; otherwise it answers plainly. A prompt that starts ``hush``
makes it answer the question with nothing once, then with ``answer_agent``
when told the call waits; ``mute``, with nothing every time; ``blank``,
with nothing to a plain prompt. The same server
can serve two agents at once, so the interop test uses one for both.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

_DELEGATE = re.compile(r"delegate to ([^\s:]+)(?:: (.*))?")
_SILENT = re.compile(r"(hush|mute|blank) ")
_TOLD = "Your last answer was empty"


@dataclass
class Recorded:
    headers: dict[str, str]
    body: dict[str, Any]


@dataclass
class FakeModel:
    requests: list[Recorded] = field(default_factory=list)
    usage_mode: bool = False
    _server: ThreadingHTTPServer | None = None
    _thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def start(self) -> FakeModel:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:  # quiet
                pass

            def do_POST(self) -> None:  # noqa: N802 — http.server's name
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw)
                fake.requests.append(Recorded({k.lower(): v for k, v in self.headers.items()}, body))
                last = body["messages"][-1]
                content = last.get("content") or ""
                tools_offered = bool(body.get("tools"))
                # The prompt being served: the last user message that is not the loop's own word.
                served = next(
                    (
                        m.get("content") or ""
                        for m in reversed(body["messages"])
                        if m["role"] == "user" and not (m.get("content") or "").startswith(_TOLD)
                    ),
                    "",
                )
                silent = m.group(1) if (m := _SILENT.match(served)) else None
                message: dict[str, Any]
                if fake.usage_mode and last["role"] != "tool":
                    message = {
                        "role": "assistant", "content": "",
                        "tool_calls": [{"id": "usage_1", "type": "function", "function": {"name": "scratchpad_usage", "arguments": "{}"}}],
                    }
                elif fake.usage_mode:
                    message = {"role": "assistant", "content": "storage: " + content}
                elif last["role"] == "user" and content.startswith(_TOLD):
                    # Told that a call waits: "hush" answers it now, "mute" stays silent.
                    waiting = next(
                        (
                            r
                            for msg in reversed(body["messages"])
                            if msg["role"] == "tool" and (r := json.loads(msg["content"])).get("state") == "input_required"
                        ),
                        None,
                    )
                    if silent == "hush" and waiting is not None:
                        message = {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_fake_3",
                                    "type": "function",
                                    "function": {
                                        "name": "answer_agent",
                                        "arguments": json.dumps({"call_id": waiting["call_id"], "answer": "yes"}),
                                    },
                                }
                            ],
                        }
                    else:
                        message = {"role": "assistant", "content": None}
                elif (
                    last["role"] == "tool"
                    and silent is not None
                    and json.loads(content).get("state") == "input_required"
                ):
                    # The model that ends its turn with nothing while a call waits.
                    message = {"role": "assistant", "content": None}
                elif last["role"] == "tool" and (result := json.loads(content)).get("state") == "input_required":
                    message = {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_fake_2",
                                "type": "function",
                                "function": {
                                    "name": "answer_agent",
                                    "arguments": json.dumps({"call_id": result["call_id"], "answer": "yes"}),
                                },
                            }
                        ],
                    }
                elif last["role"] == "tool":
                    message = {
                        "role": "assistant",
                        "content": f"they said: {result.get('reply', result.get('error'))}",
                    }
                elif (m := _DELEGATE.search(content)) and tools_offered:
                    message = {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_fake_1",
                                "type": "function",
                                "function": {
                                    "name": "prompt_agent",
                                    "arguments": json.dumps({"address": m.group(1), "prompt": m.group(2) or "ping"}),
                                },
                            }
                        ],
                    }
                elif silent == "blank":
                    message = {"role": "assistant", "content": None}
                else:
                    message = {"role": "assistant", "content": f"plain answer to: {content}"}
                reply = json.dumps(
                    {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion",
                        "model": body.get("model"),
                        "choices": [
                            {"index": 0, "message": message, "finish_reason": "tool_calls" if "tool_calls" in message else "stop"}
                        ],
                        "usage": {"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17},
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
