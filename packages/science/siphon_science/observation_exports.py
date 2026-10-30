"""Trusted DATA-ONLY validation of source-VM observation exports.

Never imports source modules, receives a live namespace, opens manifest paths or
unpickles objects. Callers separately establish experiment/sandbox provenance.
"""

import hashlib
import math

import numpy as np

from .adapter import validate_mapping_metadata
from .numeric_inputs import NumericInputError, read_npy


def validate_observation_exports(
    manifest,
    payloads,
    *,
    operation_id,
    input_digest,
    adapter_digest,
    mappings,
    maximum_bytes,
    maximum_elements,
):
    """Return read-only NumericInput arrays after identity, hash and format checks.

    Expected identifiers/mappings/limits come from the server's approved plan,
    never from source output. This is integrity/structure evidence, not physics.
    """
    if any(type(limit) is not int or limit < 1 for limit in (maximum_bytes, maximum_elements)):
        raise ValueError("Invalid observation export policy")
    validate_mapping_metadata(mappings)
    fields = {
        "schemaVersion",
        "operationId",
        "inputDigest",
        "adapterDigest",
        "executionProfile",
        "observations",
    }
    if (
        type(manifest) is not dict
        or set(manifest) != fields
        or manifest["schemaVersion"] != "1.0"
        or manifest["operationId"] != operation_id
        or manifest["inputDigest"] != input_digest
        or manifest["adapterDigest"] != adapter_digest
        or manifest["executionProfile"] != "runpy_main_root_v1"
    ):
        raise NumericInputError("observation_export_identity_mismatch")
    descriptors = manifest["observations"]
    if (
        type(descriptors) is not list
        or len(descriptors) != len(mappings)
        or type(payloads) is not dict
    ):
        raise NumericInputError("observation_export_set_mismatch")
    expected = {mapping["key"]: mapping for mapping in mappings}
    seen, filenames, total_bytes, total_elements = set(), set(), 0, 0
    prepared = []
    # Inspect all descriptor/payload lengths and hashes before allocating arrays.
    for descriptor in descriptors:
        if type(descriptor) is not dict or set(descriptor) != {
            "key",
            "filename",
            "sha256",
            "bytes",
            "shape",
            "dtype",
            "declaredUnit",
        }:
            raise NumericInputError("invalid_observation_descriptor")
        key = descriptor["key"]
        if type(key) is not str or key not in expected or key in seen:
            raise NumericInputError("observation_export_set_mismatch")
        mapping = expected[key]
        filename = "obs_" + key + ".npy"
        if (
            descriptor["filename"] != filename
            or type(descriptor["shape"]) is not list
            or any(type(n) is not int for n in descriptor["shape"])
            or descriptor["shape"] != mapping["expectedShape"]
            or descriptor["dtype"] != "float64"
            or descriptor["declaredUnit"] != mapping["declaredUnit"]
        ):
            raise NumericInputError("observation_export_mapping_mismatch")
        seen.add(key)
        filenames.add(filename)
        payload = payloads.get(filename)
        if (
            type(payload) is not bytes
            or type(descriptor["bytes"]) is not int
            or descriptor["bytes"] != len(payload)
        ):
            raise NumericInputError("observation_export_length_mismatch")
        total_bytes += len(payload)
        elements = math.prod(mapping["expectedShape"])
        total_elements += elements
        if total_bytes > maximum_bytes or total_elements > maximum_elements:
            raise NumericInputError("observation_export_resource_limit")
        if hashlib.sha256(payload).hexdigest() != descriptor["sha256"]:
            raise NumericInputError("observation_export_hash_mismatch")
        prepared.append((key, mapping, payload, elements))
    if set(payloads) != filenames:
        raise NumericInputError("observation_export_set_mismatch")
    result = {}
    for key, mapping, payload, elements in prepared:
        decoded = read_npy(
            payload,
            maximum_bytes=maximum_bytes,
            maximum_elements=elements,
            allow_scalar=key in ("central_mu", "gravity_constant"),
            require_float64=True,
        )
        if decoded.values.shape != tuple(mapping["expectedShape"]):
            raise NumericInputError("observation_export_shape_mismatch")
        result[key] = decoded
    if "times" in result:
        times = result["times"].values
        if times.ndim != 1 or not times.size or np.any(times[1:] <= times[:-1]):
            raise NumericInputError("invalid_exported_time_axis")
    return result
