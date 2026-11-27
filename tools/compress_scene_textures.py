"""Convert the embedded PNG textures in a gltfpack GLB to lossless WebP."""
import json
import struct
import subprocess
import sys
from pathlib import Path


def compress(source, target):
    data = source.read_bytes()
    magic, version, _, json_size, json_type = struct.unpack_from("<5I", data)
    binary_start = 20 + json_size
    binary_size, binary_type = struct.unpack_from("<2I", data, binary_start)
    doc = json.loads(data[20:binary_start])
    binary = memoryview(data)[binary_start + 8:binary_start + 8 + binary_size]
    views = doc["bufferViews"]
    entries = sorted((views[image["bufferView"]].get("byteOffset", 0), image["bufferView"], image)
                     for image in doc.get("images", [])
                     if image["mimeType"] == "image/png")
    references = [item for view in views
                  for item in (view, view.get("extensions", {}).get("EXT_meshopt_compression"))
                  if item is not None and item["buffer"] == 0]
    replacements = []
    for offset, index, image in entries:
        view = views[index]
        end = offset + view["byteLength"]
        webp = subprocess.run(["cwebp", "-quiet", "-lossless", "-exact", "-q", "80",
                               "-o", "-", "--", "-"],
                              input=binary[offset:end], capture_output=True, check=True).stdout
        if len(webp) >= end - offset:
            continue
        if any(item is not view and item.get("byteOffset", 0) < end and
               item.get("byteOffset", 0) + item["byteLength"] > offset for item in references):
            raise ValueError("Texture payload overlaps a different buffer view")
        replacements.append((offset, end, webp, view))
        image["mimeType"] = "image/webp"

    output = bytearray()
    cursor = 0
    for offset, end, webp, view in replacements:
        output.extend(binary[cursor:offset])
        output.extend(webp)
        output.extend(bytes((end - offset - len(webp)) % 4))
        cursor = end
        old_length = view["byteLength"]
        view["byteLength"] = len(webp)
        shift = len(webp) + (old_length - len(webp)) % 4 - old_length
        for item in references:
            original = item.get("byteOffset", 0)
            # Offsets already include shifts from earlier replacements.
            shifted_end = len(output) - shift
            if original >= shifted_end:
                item["byteOffset"] = original + shift
    output.extend(binary[cursor:])
    doc["buffers"][0]["byteLength"] = len(output)
    extension = "EXT_texture_webp"
    if replacements:
        for texture in doc["textures"]:
            if "source" in texture and doc["images"][texture["source"]]["mimeType"] == "image/webp":
                texture.setdefault("extensions", {})[extension] = {"source": texture.pop("source")}
        for key in ("extensionsUsed", "extensionsRequired"):
            if extension not in doc.setdefault(key, []):
                doc[key].append(extension)
    metadata = json.dumps(doc, separators=(",", ":")).encode()
    metadata += b" " * (-len(metadata) % 4)
    header = struct.pack("<5I", magic, version, 28 + len(metadata) + len(output),
                         len(metadata), json_type)
    target.write_bytes(header + metadata + struct.pack("<2I", len(output), binary_type) + output)


if __name__ == "__main__":
    compress(Path(sys.argv[1]), Path(sys.argv[2]))
