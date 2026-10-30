"""Declarative observation extraction in an UNTRUSTED source sandbox only.

The trusted numerical evaluator must never receive a live source namespace.
This module does not import, run, repair or rewrite uploaded simulations.
"""

import re

import numpy as np


class AdapterError(ValueError):
    pass


OBSERVATION_KEYS = {
    "times",
    "temperature",
    "positions",
    "velocities",
    "masses",
    "central_mu",
    "gravity_constant",
    "thermal_weights",
    "source_power",
    "outward_power",
}


def validate_mapping_metadata(mappings):
    """Validate the complete declarative selector set before any source execution."""
    if type(mappings) is not list or not 1 <= len(mappings) <= 10:
        raise AdapterError("invalid_observation_mapping")
    seen = set()
    for mapping in mappings:
        _fields(mapping, ("key", "root", "steps", "expectedShape", "axisOrder", "declaredUnit"))
        key, root = mapping["key"], mapping["root"]
        if (
            not isinstance(key, str)
            or key not in OBSERVATION_KEYS
            or key in seen
            or not isinstance(root, str)
            or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,99}", root) is None
            or root.startswith("__")
        ):
            raise AdapterError("invalid_observation_mapping")
        seen.add(key)
        shape, order = mapping["expectedShape"], mapping["axisOrder"]
        if (
            type(shape) is not list
            or len(shape) > 4
            or any(type(n) is not int or not 1 <= n <= 65536 for n in shape)
            or type(order) is not list
            or any(type(n) is not int for n in order)
            or sorted(order) != list(range(len(shape)))
        ):
            raise AdapterError("invalid_observation_axes")
        if (
            not isinstance(mapping["declaredUnit"], str)
            or not 1 <= len(mapping["declaredUnit"]) <= 100
        ):
            raise AdapterError("invalid_observation_unit")
        if type(mapping["steps"]) is not list or len(mapping["steps"]) > 8:
            raise AdapterError("invalid_selector")
        for step in mapping["steps"]:
            if type(step) is not dict:
                raise AdapterError("invalid_selector")
            if step.get("kind") == "key":
                _fields(step, ("kind", "key"))
                if not isinstance(step["key"], str) or not 1 <= len(step["key"]) <= 200:
                    raise AdapterError("invalid_selector")
            elif step.get("kind") == "index":
                _fields(step, ("kind", "index"))
                if type(step["index"]) is not int or not 0 <= step["index"] <= 1000000:
                    raise AdapterError("invalid_selector")
            else:
                raise AdapterError("invalid_selector")


def _fields(value, expected):
    if type(value) is not dict or set(value) != set(expected):
        raise AdapterError("invalid_observation_mapping")


def extract_observations(namespace, mappings, *, maximum_bytes, maximum_elements):
    """Literal dict/list traversal and explicit axis permutation only.

    Float64 arrays are copied without scaling, interpolation or dtype coercion.
    expectedShape is canonical AFTER the declared axis permutation. Scalar
    parameters must be zero-dimensional float64 arrays in this initial handler.
    Server-owned resource caps apply cumulatively before copies are allocated.
    """
    validate_mapping_metadata(mappings)
    if type(namespace) is not dict:
        raise AdapterError("invalid_observation_mapping")
    if any(type(limit) is not int or limit < 1 for limit in (maximum_bytes, maximum_elements)):
        raise ValueError("Invalid adapter resource policy")
    prepared = []
    keys = set()
    total = 0
    # Validate all mappings before producing snapshots.
    for mapping in mappings:
        _fields(mapping, ("key", "root", "steps", "expectedShape", "axisOrder", "declaredUnit"))
        key, root = mapping["key"], mapping["root"]
        if (
            not isinstance(key, str)
            or key not in OBSERVATION_KEYS
            or key in keys
            or not isinstance(root, str)
            or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,99}", root) is None
            or root.startswith("__")
        ):
            raise AdapterError("invalid_observation_mapping")
        keys.add(key)
        if root not in namespace:
            raise AdapterError("missing_observation_root")
        value = namespace[root]
        steps = mapping["steps"]
        if type(steps) is not list or len(steps) > 8:
            raise AdapterError("invalid_selector")
        for step in steps:
            if type(step) is not dict:
                raise AdapterError("invalid_selector")
            if step.get("kind") == "key":
                _fields(step, ("kind", "key"))
                selector = step["key"]
                if (
                    not isinstance(selector, str)
                    or not 1 <= len(selector) <= 200
                    or type(value) is not dict
                    or selector not in value
                ):
                    raise AdapterError("missing_dictionary_observation")
                value = value[selector]
            elif step.get("kind") == "index":
                _fields(step, ("kind", "index"))
                selector = step["index"]
                if (
                    type(selector) is not int
                    or not 0 <= selector <= 1000000
                    or type(value) not in (list, tuple)
                    or selector >= len(value)
                ):
                    raise AdapterError("invalid_sequence_observation")
                value = value[selector]
            else:
                raise AdapterError("invalid_selector")
        shape, order, unit = mapping["expectedShape"], mapping["axisOrder"], mapping["declaredUnit"]
        if (
            type(shape) is not list
            or len(shape) > 4
            or any(type(n) is not int or not 1 <= n <= 65536 for n in shape)
            or type(order) is not list
            or any(type(n) is not int for n in order)
            or sorted(order) != list(range(len(shape)))
            or not isinstance(unit, str)
            or not 1 <= len(unit) <= 100
        ):
            raise AdapterError("invalid_observation_axes")
        if type(value) is not np.ndarray or value.dtype != np.dtype("float64"):
            raise AdapterError("unsupported_observation_dtype")
        elements = 1
        for dimension in shape:
            elements *= dimension
        total += elements
        if total > maximum_elements or total * 8 > maximum_bytes:
            raise AdapterError("observation_resource_limit")
        if value.ndim != len(shape) or tuple(value.shape[axis] for axis in order) != tuple(shape):
            raise AdapterError("observation_shape_mismatch")
        if not np.isfinite(value).all():
            raise AdapterError("non_finite_observation")
        prepared.append((key, value, order))
    output = {}
    for key, value, order in prepared:
        snapshot = np.transpose(value, axes=order).copy()
        snapshot.setflags(write=False)
        output[key] = snapshot
    return output
