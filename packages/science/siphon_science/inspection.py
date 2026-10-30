"""Static Python inspection. Production invocation belongs in an isolated E2B job.

Parsing is not a security boundary or proof of valid execution. Never import,
evaluate, compile to bytecode, or execute inspected source in this module.
"""

import ast
import hashlib
import io
import tokenize
from typing import TypedDict


class Finding(TypedDict):
    code: str
    line: int | None


class Symbol(TypedDict):
    kind: str
    name: str
    line: int


class Inspection(TypedDict):
    schemaVersion: str
    sourceDigest: str
    parsed: bool
    dependencies: list[Symbol]
    definitions: list[Symbol]
    findings: list[Finding]
    truncated: bool


def inspect_source(source: bytes, *, maximum_bytes: int, maximum_records: int = 200) -> Inspection:
    """Return observations only, with byte policy supplied by the backend snapshot.

    Local tests use authored fixtures. Arbitrary uploaded inputs must never be
    routed to a developer-host invocation: even ast.parse can exhaust resources.
    """
    if type(maximum_bytes) is not int or maximum_bytes < 0:
        raise ValueError("Invalid source byte policy")
    if type(maximum_records) is not int or not 1 <= maximum_records <= 200:
        raise ValueError("Invalid inspection output bound")
    if not isinstance(source, bytes):
        raise TypeError("Source must be bytes")
    result: Inspection = {
        "schemaVersion": "1.0",
        "sourceDigest": hashlib.sha256(source).hexdigest(),
        "parsed": False,
        "dependencies": [],
        "definitions": [],
        "findings": [],
        "truncated": False,
    }
    if len(source) > maximum_bytes:
        result["findings"].append({"code": "source_byte_limit", "line": None})
        return result
    if b"\x00" in source:
        result["findings"].append({"code": "null_byte", "line": None})
        return result
    try:
        encoding, _ = tokenize.detect_encoding(io.BytesIO(source).readline)
        text = source.decode(encoding, errors="strict")
    except (SyntaxError, UnicodeError, LookupError):
        result["findings"].append({"code": "invalid_source_encoding", "line": None})
        return result
    try:
        tree = ast.parse(text, filename="<uploaded-source>", mode="exec")
    except SyntaxError as error:
        # Do not echo exception messages or source lines containing private data.
        result["findings"].append({"code": "syntax_error", "line": error.lineno})
        return result
    except (ValueError, RecursionError, MemoryError):
        result["findings"].append({"code": "parser_resource_or_input_error", "line": None})
        return result
    result["parsed"] = True
    records = 0

    def symbol(target: list[Symbol], kind: str, name: str, line: int) -> None:
        nonlocal records
        if records >= maximum_records or len(name) > 200:
            result["truncated"] = True
            return
        target.append({"kind": kind, "name": name, "line": line})
        records += 1

    def finding(code: str, line: int) -> None:
        nonlocal records
        if records >= maximum_records:
            result["truncated"] = True
            return
        result["findings"].append({"code": code, "line": line})
        records += 1

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                symbol(result["dependencies"], "absolute_import", alias.name, node.lineno)
        elif isinstance(node, ast.ImportFrom):
            symbol(
                result["dependencies"],
                "relative_import" if node.level else "absolute_import",
                "." * node.level + (node.module or ""),
                node.lineno,
            )
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            symbol(result["definitions"], type(node).__name__, node.name, node.lineno)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            symbol(result["definitions"], "assignment", node.id, node.lineno)
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in {
                "eval",
                "exec",
                "__import__",
                "compile",
            }:
                finding("dynamic_code_requires_review", node.lineno)
            elif isinstance(node.func, ast.Attribute) and node.func.attr in {
                "import_module",
                "exec_module",
            }:
                finding("dynamic_import_requires_review", node.lineno)
    # No dependency allowlist or execution authorization is inferred here.
    return result
