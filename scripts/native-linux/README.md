# Linux native-client qualification

This command qualifies the selected Linux runtimes against the actual ScratchPad service.
It uses a private core checkout, authenticated NATS imports, and file-backed R1 storage.
The command measures a finite publication window. It does not qualify a Live deployment or a soak workload.
Run R3 and full agent-stack qualification separately.

## Build inputs

Use the locally built Live TypeScript and Python agent images as `NODE_IMAGE` and `PYTHON_IMAGE`.
The recipe reuses their development dependencies and checks the TypeScript dependency lockfiles byte for byte.
It removes inherited sources, copies the selected checkouts, and rebuilds them.
Python resolves its development environment through the checked-in `uv.lock` and the image's Python 3.12.
This is not a clean npm/PyPI installation check.

Record the three checkout revisions and any local changes before building.
The source inventory also records the selected source paths, build inputs, and their hashes.
Use new evidence paths for every run.

```sh
uv run --no-project --python 3.12 python scripts/native-linux/sources.py \
  --sdk-root . --core-root /path/to/private/scratchpad \
  --protocol-root /path/to/synadia-agents --output /path/to/new/expected-sources.json

docker buildx build --load --tag scratchpad-native-qualification:local \
  --build-arg NODE_IMAGE=<qualified-ts-image> \
  --build-arg PYTHON_IMAGE=<qualified-python-image> \
  --build-context agents=/path/to/synadia-agents \
  --build-context scratchpad=/path/to/private/scratchpad \
  --file scripts/native-linux/Dockerfile .
```

The private core needs the native subprocess fixture, including its delayed-grant gate and `spool-32m` profile.
The profile reserves 512 objects and 128 MiB for the measured volume.
Ordinary fixtures keep their smaller scope. Product provisioning limits do not change.

## Run and inspect

Use a fresh Docker volume for Linux local storage. A Mac bind mount measures a different filesystem path.
The example below uses four CPUs and 4 GiB of memory.
The container needs no network outside its own loopback interface.

```sh
docker volume create --label task=scratchpad-native-qualification native-qualification-run
docker run --name native-qualification-run --network none --cpus 4 --memory 4g \
  --mount type=volume,source=native-qualification-run,target=/qualification \
  scratchpad-native-qualification:local \
  --output /qualification/evidence/run --cycles 10 --artifact-mib 32
docker cp native-qualification-run:/qualification/evidence/run /path/to/new/results
cmp /path/to/new/expected-sources.json /path/to/new/results/sources.json
```

The command runs both real-service suites and refuses failed, skipped, or incomplete test reports.
It then publishes, reads, verifies, releases, collects, closes, and reopens each writer for every cycle.
Use `--artifact-mib 7` for the smaller scope and `--spool-only` for a separate measured window.
Each chunk includes its cycle and index so different cycles do not reuse identical content.
The client checks the complete digest, byte count, and writer command sequence.

Inspect `summary.json`, both suite reports, and `spool/result.json`.
The environment records both runtime versions, both SQLite versions, mount details, and scratch paths.
Keep the container's image ID, CPU/memory limits, and volume mount with the source inventory.
Report the worst scheduling gap across all cycles. Do not attribute the whole gap to SQLite flushes.
Database high-water size can remain after collection; compare every cycle before claiming observed reuse.

Fixture credentials remain in `/qualification/work`, outside exported evidence.
The command refuses an output tree that contains that scratch directory.
Export only `/qualification/evidence`; preserve failed results before removing owned containers or volumes.

## Controls

The Python unit suite discovers `test_scratchpad_native_linux_reports.py`.
Those checks reject empty, skipped, and failed reports and unsafe credential-export paths.
The existing control-mutation script also accepts `--case delayed-refusal`.
It removes the earlier-unknown protection in isolated source copies.
Both language tests must fail at the specific refusal assertion; a setup error cannot pass the control.

The delayed case holds one real outgoing grant request while another connection receives a service refusal.
The writer preserves that grant across reopening. The original request later arrives and grants access.
The test checks its exact scope, a permitted reader, a denied reader, and recovered state.
This exercises reordered delivery. It does not reproduce every NATS reconnect-buffer schedule.
