"""Independent declarative extraction for a source-sandbox baseline.

The user's source remains untrusted and must run only inside a fresh isolated
sandbox. Agreement checks transformation fidelity, not variable semantics.
"""

import math

import numpy as np

from .adapter import AdapterError, validate_mapping_metadata


def extract_reference(namespace, mappings, *, maximum_bytes, maximum_elements):
    validate_mapping_metadata(mappings)
    if type(namespace) is not dict:
        raise AdapterError("invalid_observation_mapping")
    if any(type(limit) is not int or limit < 1 for limit in (maximum_bytes, maximum_elements)):
        raise ValueError("Invalid adapter resource policy")
    sizes = [math.prod(item["expectedShape"]) for item in mappings]
    if sum(sizes) > maximum_elements or sum(sizes) * 8 > maximum_bytes:
        raise AdapterError("observation_resource_limit")
    observations = {}
    for mapping in mappings:
        if mapping["root"] not in namespace:
            raise AdapterError("missing_observation_root")
        value = namespace[mapping["root"]]
        for step in mapping["steps"]:
            if step["kind"] == "key":
                if type(value) is not dict or step["key"] not in value:
                    raise AdapterError("missing_dictionary_observation")
                value = value[step["key"]]
            else:
                if type(value) not in (list, tuple) or step["index"] >= len(value):
                    raise AdapterError("invalid_sequence_observation")
                value = value[step["index"]]
        if type(value) is not np.ndarray or value.dtype != np.dtype("float64"):
            raise AdapterError("unsupported_observation_dtype")
        order = mapping["axisOrder"]
        if value.ndim != len(order) or tuple(value.shape[i] for i in order) != tuple(
            mapping["expectedShape"]
        ):
            raise AdapterError("observation_shape_mismatch")
        if not np.isfinite(value).all():
            raise AdapterError("non_finite_observation")
        # Move original axes to canonical positions; never scale or interpolate.
        canonical = np.moveaxis(value, order, list(range(value.ndim))).copy()
        canonical.setflags(write=False)
        observations[mapping["key"]] = canonical
    return observations
