#!/usr/bin/env python3
"""Converts SmolLM2-135M weights into the file that src/model.rs loads.

    python3 tools/convert_weights.py model.safetensors www/model

`model.safetensors` is the one from https://huggingface.co/HuggingFaceTB/SmolLM2-135M.
Every weight matrix is stored as 8-bit integers with one scale per row, and the
result is split into parts below GitHub's 100 MB file limit, with a manifest.

Any change to the output renumbers every page, so bump MODEL_CACHE in
www/llm.mjs when regenerating.
"""
import json
import os
import struct
import sys

import numpy as np

LAYERS = 30
PART_SIZE = 90 * 1024 * 1024
NAME = "model.bin"


def read_safetensors(path):
    with open(path, "rb") as f:
        (header_size,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(header_size))
        data = f.read()
    tensors = {}
    for name, info in header.items():
        if name == "__metadata__":
            continue
        start, end = info["data_offsets"]
        raw = data[start:end]
        if info["dtype"] == "BF16":
            # bfloat16 is the upper half of a float32
            values = (np.frombuffer(raw, dtype="<u2").astype("<u4") << 16).view("<f4")
        elif info["dtype"] == "F32":
            values = np.frombuffer(raw, dtype="<f4")
        else:
            raise ValueError(f"unsupported dtype {info['dtype']} for {name}")
        tensors[name] = values.reshape(info["shape"])
    return tensors


def matrix(weights):
    """Rows of int8 with a float32 scale per row: weights ~ scale * int8."""
    scales = np.abs(weights).max(axis=1) / 127.0
    scales[scales == 0] = 1.0
    quantized = np.rint(weights / scales[:, None]).astype(np.int8)
    return scales.astype("<f4").tobytes() + quantized.tobytes()


def vector(weights):
    return weights.astype("<f4").tobytes()


def convert(tensors):
    out = [b"INFNB1\0\0", matrix(tensors["model.embed_tokens.weight"])]
    for i in range(LAYERS):
        layer = f"model.layers.{i}."
        out.append(vector(tensors[layer + "input_layernorm.weight"]))
        for name in ["q_proj", "k_proj", "v_proj", "o_proj"]:
            out.append(matrix(tensors[layer + f"self_attn.{name}.weight"]))
        out.append(vector(tensors[layer + "post_attention_layernorm.weight"]))
        for name in ["gate_proj", "up_proj", "down_proj"]:
            out.append(matrix(tensors[layer + f"mlp.{name}.weight"]))
    out.append(vector(tensors["model.norm.weight"]))
    return b"".join(out)


def main():
    source, directory = sys.argv[1:]
    model = convert(read_safetensors(source))
    parts = []
    for i, start in enumerate(range(0, len(model), PART_SIZE)):
        part = model[start:start + PART_SIZE]
        file = f"{NAME}.part{i:02d}"
        with open(os.path.join(directory, file), "wb") as f:
            f.write(part)
        parts.append({"file": file, "size": len(part)})
    with open(os.path.join(directory, NAME + ".json"), "w") as f:
        json.dump({"parts": parts}, f, indent=2)
        f.write("\n")
    print(f"{len(model)} bytes in {len(parts)} parts")


if __name__ == "__main__":
    main()
