"""Separate native Python client; parent can SIGKILL after a real unknown reply."""

import asyncio
import json
import sys

import nats

from synadia_ai.agent_fabric import native_scratchpad


async def main() -> None:
    mode, encoded = sys.argv[1:]
    options = json.loads(encoded)
    nc = await nats.connect(
        options["url"], user_credentials=options["credentials"], allow_reconnect=False
    )
    await nc.flush()
    args = {key: options[key] for key in ("volume", "dir", "creator", "timeout_s")}
    if mode == "lock-probe":
        opened = 0
        try:
            pad = await native_scratchpad(nc=nc, **args)
            opened += 1
            await pad.close()
            print(
                json.dumps({"event": "unexpected_success", "successful_opens": opened}), flush=True
            )
        except Exception as error:
            print(
                json.dumps(
                    {
                        "event": "refused",
                        "code": getattr(error, "code", None),
                        "local": getattr(error, "local", None),
                        "successful_opens": opened,
                    }
                ),
                flush=True,
            )
        finally:
            await nc.close()
        return
    pad = await native_scratchpad(nc=nc, **args)
    if mode == "publish":
        try:
            value = bytes(index % 251 for index in range(options["bytes"]))
            result = await pad.publish_bytes(
                value, options["path"], operation_id=options["operation_id"], ttl_seconds=600
            )
            print(json.dumps({"event": "unexpected_success", "result": result}), flush=True)
        except Exception as error:
            if not getattr(error, "unknown", False):
                raise
            print(
                json.dumps({"event": "unknown", "code": error.code, "unknown": error.unknown}),
                flush=True,
            )
            await asyncio.Event().wait()
    elif mode == "recover":
        result = await pad.recover()
        print(json.dumps({"event": "recovered", "result": result}), flush=True)
    else:
        raise ValueError("worker needs explicit mode")
    await pad.close()
    await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
