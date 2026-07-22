#!/usr/bin/env python3
"""Synthesize a lossy JPEG XL DNG (VarDCT/XYB, sRGB-tagged) the way real
writers do (verified against a Lightroom X100VI pano): the payload is
COLORIMETRIC — the codestream tag fully describes the samples — so a
correct reader must NOT apply the DNG develop (AsShotNeutral/ColorMatrix)
on top. The container still carries camera-style color tags to prove they
are ignored for XYB payloads.

Scene: a neutral gray ramp plus saturated R/G/B/white patches. Rendered
correctly, the ramp is NEUTRAL gray; a reader that wrongly applies the WB
gains turns it magenta (R x1.88, B x1.81 vs G with these tags).
"""
import io
import struct

import imagecodecs
import numpy as np

W, H = 768, 512
NEUTRAL = np.array([183 / 512, 1.0, 403 / 512])  # from the real S22 file

# Linear scene luminance 0..1
img = np.zeros((H, W, 3), dtype=np.float64)
ramp = np.linspace(0.02, 1.0, W)[None, :]
img[: H // 2, :, :] = ramp[..., None]  # top half: neutral ramp
# bottom half: R/G/B/white patches
quarter = W // 4
img[H // 2 :, :quarter] = [0.8, 0.05, 0.05]
img[H // 2 :, quarter : 2 * quarter] = [0.05, 0.8, 0.05]
img[H // 2 :, 2 * quarter : 3 * quarter] = [0.05, 0.05, 0.8]
img[H // 2 :, 3 * quarter :] = [0.95, 0.95, 0.95]

# The writer stores the colorimetric image itself, sRGB-gamma encoded for
# the perceptual XYB codec.
srgb_gamma = np.clip(img, 0, 1) ** (1 / 2.2)
samples = np.round(srgb_gamma * 65535).astype(np.uint16)

jxl = imagecodecs.jpegxl_encode(samples, distance=1.0, effort=4,
    transfer=imagecodecs.JPEGXL.TRANSFER_FUNCTION.SRGB)
print("jxl bytes:", len(jxl), "lossy VarDCT")

# Sanity: what does a default decode return? (gamma-domain values)
back = imagecodecs.jpegxl_decode(jxl)
print("roundtrip err (gamma domain):", np.abs(back.astype(int) - samples.astype(int)).mean())

# --- wrap in a DNG (little-endian, raw in IFD0, single strip) ---
TYPE = {"B": 1, "A": 2, "S": 3, "L": 4, "R": 5, "SR": 10}

def build(tags, payload):
    tags = sorted(tags, key=lambda t: t[0])
    n = len(tags)
    ifd_off = 8
    heap_off = ifd_off + 2 + n * 12 + 4
    heap = b""
    entries = []
    payload_marker = []
    for tag, typ, vals in tags:
        if typ == "A":
            raw = vals.encode() + b"\x00"
            count = len(raw)
        elif typ == "S":
            raw = struct.pack("<%dH" % len(vals), *vals)
            count = len(vals)
        elif typ == "L":
            raw = struct.pack("<%dI" % len(vals), *vals)
            count = len(vals)
        elif typ in ("R", "SR"):
            fmt = "<" + ("ii" if typ == "SR" else "II") * (len(vals) // 2)
            raw = struct.pack(fmt, *vals)
            count = len(vals) // 2
        elif typ == "B":
            raw = bytes(vals)
            count = len(raw)
        entries.append((tag, TYPE[typ], count, raw))
    out = io.BytesIO()
    out.write(struct.pack("<2sHI", b"II", 42, ifd_off))
    out.write(struct.pack("<H", n))
    # first pass to compute heap layout
    heap_cursor = 0
    heap_blobs = []
    slots = []
    for tag, typ, count, raw in entries:
        if len(raw) <= 4:
            slots.append(raw + b"\x00" * (4 - len(raw)))
        else:
            slots.append(struct.pack("<I", heap_off + heap_cursor))
            heap_blobs.append(raw + (b"\x00" if len(raw) % 2 else b""))
            heap_cursor += len(heap_blobs[-1])
    strip_off = heap_off + heap_cursor
    for (tag, typ, count, raw), slot in zip(entries, slots):
        if tag == 273:
            slot = struct.pack("<I", strip_off)
        out.write(struct.pack("<HHI", tag, typ, count) + slot)
    out.write(struct.pack("<I", 0))
    for b in heap_blobs:
        out.write(b)
    out.write(payload)
    return out.getvalue()

cm1 = [799, 1024, -223, 1024, -116, 1024, -548, 1024, 1436, 1024, 100, 1024, -153, 1024, 320, 1024, 470, 1024]
dng = build(
    [
        (254, "L", [0]),
        (256, "L", [W]),
        (257, "L", [H]),
        (258, "S", [16, 16, 16]),
        (259, "S", [52546]),
        (262, "S", [34892]),
        (271, "A", "samsung"),
        (272, "A", "SM-S24-SYNTH"),
        (273, "L", [0]),
        (274, "S", [1]),
        (277, "S", [3]),
        (278, "L", [H]),
        (279, "L", [len(jxl)]),
        (50706, "B", [1, 7, 0, 0]),
        (50714, "S", [0]),
        (50717, "L", [65535]),
        (50721, "SR", cm1),
        (50728, "R", [183, 512, 1, 1, 403, 512]),
        (50778, "S", [21]),
    ],
    jxl,
)
path = "/home/joel/dev/open.raweditor.io/samples/synthetic-s24-lossy.dng"
open(path, "wb").write(dng)
print("wrote", path, len(dng))
