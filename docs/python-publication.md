# Publish the Python package

Publish the protocol caller and service first, in that order. The Fabric
release is `synadia-ai-agent-fabric` 0.1.0 and uses exact protocol versions
0.8.0 and 0.5.0 in its publication artifacts. Those versions must already
be available on PyPI before the Fabric installation gate can pass.

## Trusted publisher

The PyPI project owner creates a pending GitHub trusted publisher for:

- Project: `synadia-ai-agent-fabric`
- GitHub owner: `synadia-ai`
- Repository: `agent-fabric-sdk`
- Workflow filename: `release-python.yml`
- Environment: `pypi`

The workflow uses short-lived GitHub OIDC credentials. No permanent PyPI
token belongs in this repository. Before the publisher is enabled, a
repository admin must restrict the `pypi` environment to `python-v*` tags.
It must not accept branch or pull-request deployments. Tag protection is
recommended so only authorized release maintainers can create those tags.

Repository visibility remains an owner decision. Package installation
requires PyPI only. The package's SDK repository links need repository
access until the owner makes that SDK repository public.

## Qualification and publication

Run the complete package suites before selecting a release commit. The
publication workflow's controls inspect packaging; they do not replace
source behavior tests.

`python-v0.1.0` is the explicit publication trigger. Build and inspection
also run for pull requests that change this workflow or its controls.
The publishing job downloads and verifies the same wheel and sdist that
passed installation on Python 3.11, 3.12 and 3.13. It does not rebuild.

External runtime and build dependencies use the October 7 UTC cutoff for
the October 14 release: at least seven days of hold-off. Only the two
exact, first-party protocol packages are exempt from that date, so the
three packages can be released in sequence. Update the recorded cutoff
deliberately for a later release.

Local controls and artifact preparation:

```sh
uv run --python 3.12 python -m unittest discover -s scripts/tests -p test_python_release.py -v
uv run --python 3.12 scripts/python-release.py build --version 0.1.0 --artifacts /new/outside-checkout/directory
uv run --python 3.12 scripts/python-release.py verify --version 0.1.0 --artifacts /new/outside-checkout/directory --install
```

Use a clean committed checkout for the build. Artifact metadata records
its exact source and checksums. Installation tests resolve protocol
packages from PyPI, with no local checkout or private service source.
