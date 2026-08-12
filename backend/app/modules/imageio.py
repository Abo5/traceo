"""PNG reader — stdlib only.

The visual engine must run on an air-gapped node, so it decodes its own images
rather than pulling in an imaging stack. PNG is the right and only input format
here: it is lossless, so the palette a designer exported is the palette that
arrives, byte for byte. A JPEG would quantise the colours before the engine ever
sees them and every "exact" claim downstream would be a claim about the
compressor's guesses.

Supported: 8-bit and 16-bit greyscale, RGB, palette, and their alpha variants,
non-interlaced. Alpha is composited over a stated background because a
comparison needs a colour per pixel, not a colour and a maybe.
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

from .visual import Image


class PngError(ValueError):
    """The file is not a PNG this reader can decode — never guessed around."""


_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}  # colour type -> samples per pixel


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _unfilter(raw: bytes, width: int, height: int, bpp: int, stride: int) -> bytearray:
    out = bytearray(height * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ft = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                upleft = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(left, prev[i], upleft)) & 0xFF
        elif ft != 0:
            raise PngError(f"unknown scanline filter {ft}")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out


def read_png(path: str | Path, *, background: tuple[int, int, int] = (255, 255, 255)) -> Image:
    """Decode a PNG into an RGB raster.

    `background` is what a transparent pixel is composited over. It is explicit
    because the choice changes every colour that follows it, and silently
    assuming white would put a colour in the palette that the design never had.
    """
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise PngError("not a PNG file")

    pos = 8
    header = None
    palette: list[tuple[int, int, int]] = []
    trns: bytes = b""
    idat = bytearray()
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length  # length + type + data + crc
        if ctype == b"IHDR":
            w, h, depth, colour, compression, filt, interlace = struct.unpack(">IIBBBBB", chunk)
            if compression != 0 or filt != 0:
                raise PngError("unsupported compression or filter method")
            if interlace != 0:
                raise PngError("interlaced PNG is not supported — re-export without Adam7")
            if depth not in (8, 16):
                raise PngError(f"unsupported bit depth {depth} — re-export as 8-bit")
            if colour not in _CHANNELS:
                raise PngError(f"unsupported colour type {colour}")
            header = (w, h, depth, colour)
        elif ctype == b"PLTE":
            palette = [tuple(chunk[i:i + 3]) for i in range(0, len(chunk), 3)]
        elif ctype == b"tRNS":
            trns = chunk
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
    if header is None:
        raise PngError("no IHDR chunk")

    width, height, depth, colour = header
    samples = _CHANNELS[colour]
    sample_bytes = depth // 8
    bpp = samples * sample_bytes
    stride = width * bpp
    raw = zlib.decompress(bytes(idat))
    if len(raw) < height * (stride + 1):
        raise PngError("truncated image data")
    plane = _unfilter(raw, width, height, bpp, stride)

    def sample(row_off: int, index: int) -> int:
        off = row_off + index * sample_bytes
        if sample_bytes == 1:
            return plane[off]
        return plane[off]  # 16-bit: take the high byte, which IS the 8-bit value

    br, bg, bb = background
    pixels: list[tuple[int, int, int]] = []
    for y in range(height):
        row = y * stride
        for x in range(width):
            base = x * samples
            if colour == 0:      # greyscale
                g = sample(row, base)
                px = (g, g, g)
            elif colour == 4:    # greyscale + alpha
                g, a = sample(row, base), sample(row, base + 1)
                px = tuple(round((g * a + c * (255 - a)) / 255) for c in (br, bg, bb)) \
                    if a != 255 else (g, g, g)
            elif colour == 2:    # rgb
                px = (sample(row, base), sample(row, base + 1), sample(row, base + 2))
            elif colour == 6:    # rgba
                r, g, b, a = (sample(row, base), sample(row, base + 1),
                              sample(row, base + 2), sample(row, base + 3))
                if a == 255:
                    px = (r, g, b)
                else:
                    px = (round((r * a + br * (255 - a)) / 255),
                          round((g * a + bg * (255 - a)) / 255),
                          round((b * a + bb * (255 - a)) / 255))
            else:                # indexed
                idx = sample(row, base)
                if idx >= len(palette):
                    raise PngError("palette index out of range")
                r, g, b = palette[idx]
                a = trns[idx] if idx < len(trns) else 255
                px = (r, g, b) if a == 255 else (
                    round((r * a + br * (255 - a)) / 255),
                    round((g * a + bg * (255 - a)) / 255),
                    round((b * a + bb * (255 - a)) / 255))
            pixels.append(px)  # type: ignore[arg-type]

    return Image(width, height, tuple(pixels))
