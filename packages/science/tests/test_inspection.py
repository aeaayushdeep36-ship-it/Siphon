import hashlib
import json
import unittest
from unittest.mock import patch

from siphon_science.inspection import inspect_source


class InspectionTests(unittest.TestCase):
    def inspect(self, source: bytes, **kwargs):
        return inspect_source(source, maximum_bytes=131072, **kwargs)

    def test_extracts_imports_and_definitions_without_importing_user_modules(self):
        source = b"import module_that_does_not_exist\nfrom .helpers import solve\ndef run(dt):\n    result = dt\n    return result\n"
        result = self.inspect(source)
        self.assertTrue(result["parsed"])
        self.assertEqual(result["sourceDigest"], hashlib.sha256(source).hexdigest())
        self.assertIn(
            {"kind": "relative_import", "name": ".helpers", "line": 2}, result["dependencies"]
        )
        self.assertIn({"kind": "FunctionDef", "name": "run", "line": 3}, result["definitions"])

    def test_never_evaluates_source_or_decorators(self):
        source = (
            b"raise RuntimeError('must not run')\n@unknown_decorator()\ndef run():\n    return 1\n"
        )
        self.assertTrue(self.inspect(source)["parsed"])

    def test_does_not_echo_literals_comments_or_syntax_error_text(self):
        secret = "private-test-value"
        result = self.inspect(f"password = '{secret}'\n# {secret}\n".encode())
        self.assertNotIn(secret, json.dumps(result))
        invalid = self.inspect(f"password = '{secret}\n".encode())
        self.assertFalse(invalid["parsed"])
        self.assertNotIn(secret, json.dumps(invalid))

    def test_byte_and_encoding_limits(self):
        self.assertEqual(
            inspect_source(b"x=1", maximum_bytes=2)["findings"][0]["code"], "source_byte_limit"
        )
        self.assertEqual(self.inspect(b"x=\x00")["findings"][0]["code"], "null_byte")
        self.assertEqual(
            self.inspect(b"# coding: fake-encoding\nx=1")["findings"][0]["code"],
            "invalid_source_encoding",
        )
        self.assertTrue(self.inspect(b"# coding: latin-1\nname='\xe9'")["parsed"])

    def test_output_bound_is_global_and_marks_truncation(self):
        result = self.inspect(b"import numpy\nx=1\ny=2\ndef solve(): pass", maximum_records=2)
        self.assertTrue(result["truncated"])
        self.assertEqual(
            sum(len(result[key]) for key in ("dependencies", "definitions", "findings")), 2
        )

    def test_dynamic_code_is_a_finding_not_execution(self):
        result = self.inspect(b"exec('raise Exception()')\n__import__('unknown')")
        self.assertEqual(
            [item["code"] for item in result["findings"]], ["dynamic_code_requires_review"] * 2
        )

    def test_parser_failure_does_not_leak_error(self):
        with patch(
            "siphon_science.inspection.ast.parse", side_effect=RecursionError("private detail")
        ):
            result = self.inspect(b"x=1")
        self.assertFalse(result["parsed"])
        self.assertNotIn("private detail", json.dumps(result))

    def test_parse_success_does_not_claim_executable_or_scientific_validity(self):
        result = self.inspect(b"return 42")
        self.assertTrue(result["parsed"])
        self.assertNotIn("ready", result)
        self.assertNotIn("passed", result)


if __name__ == "__main__":
    unittest.main()
