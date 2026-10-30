"""Fixed original-baseline launcher, exclusively for fresh untrusted source VMs."""

import sys

from .source_job import run_cli

if __name__ == "__main__":
    raise SystemExit(
        run_cli(
            sys.stdin.buffer,
            root="/tmp/siphon-source-job",
            result_path="/tmp/siphon-source-result.json",
            extraction_kind="reference",
        )
    )
