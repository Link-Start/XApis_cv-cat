# -*- coding: utf-8 -*-
"""Castle token primitives and the explicit pure-computation assembly path.

The current bundle's signal serializer, timestamp field, outer mixer, and
wire framing are kept here so the pure-computation path can be tested without
starting the JavaScript runner.  Compression has two explicit backends:
Castle's JavaScript fallback and the bundled Chromium-zlib profile used by
native ``CompressionStream``.  The latter is called from Python directly and
does not create a browser/DOM environment.
"""

from __future__ import annotations

from dataclasses import dataclass
import base64
import math
import zlib


# Historical responsive-web marker retained for the legacy 632-slot profile.
CURRENT_TOKEN_PREFIX = "e8bl5yQW"
# Marker emitted by the current 749-slot x-web UMD profile.
LIVE_UMD_TOKEN_PREFIX = "uq1seNrd"


MASK32 = 0xFFFFFFFF
C1 = 0x4742E2C7
C2 = 0xF50EE6A7
C3 = 0xA847C680


def u32(value: int) -> int:
    """Return *value* with JavaScript's unsigned 32-bit arithmetic."""

    return value & MASK32


def xorshift32_step(state: int, position: int) -> int:
    """Advance Castle's recovered 32-bit word state.

    ``position`` is the byte position of the word being produced.  Castle
    calls this with 0, 4, 8, ...; the position is included before the
    xorshift and therefore must not be omitted.
    """

    state = u32(state + position + C1)
    state = u32(state + C2)
    state = u32(state ^ (state << 13))
    state = u32(state ^ (state >> 17))
    state = u32(state ^ (state << 5))
    return u32(state + C3)


def xorshift32_keystream(seed: int, length: int, *, start: int = 0) -> bytes:
    """Generate Castle's little-endian CTR-XOR keystream.

    ``start`` is useful when checking a captured suffix, and is required to
    be word-aligned because the original implementation emits one 32-bit
    word at a time.
    """

    if length < 0:
        raise ValueError("length must be non-negative")
    if start < 0 or start % 4:
        raise ValueError("start must be a non-negative 4-byte boundary")
    state = u32(seed)
    # Advance to the requested word without exposing a second, subtly
    # different recurrence implementation.
    for position in range(0, start, 4):
        state = xorshift32_step(state, position)
    out = bytearray()
    position = start
    while len(out) < length:
        state = xorshift32_step(state, position)
        out.extend(state.to_bytes(4, "little"))
        position += 4
    return bytes(out[:length])


def xor_stream(data: bytes, seed: int) -> bytes:
    """XOR *data* with the recovered outer stream cipher."""

    stream = xorshift32_keystream(seed, len(data))
    return bytes(a ^ b for a, b in zip(data, stream))


def decode_d_bytes(encoded: bytes) -> bytes:
    """Decode Castle's two-byte ``d`` transport encoding.

    Each source byte ``x`` is represented as ``d0|x>>4`` followed by
    ``(x&0xf)<<4|3``.  Rejecting malformed pairs is intentional: silently
    accepting a different alphabet would make a Python token look plausible
    while being rejected by the server.
    """

    if len(encoded) % 2:
        raise ValueError("d-encoded data must contain an even number of bytes")
    out = bytearray(len(encoded) // 2)
    for i in range(0, len(encoded), 2):
        high, low = encoded[i], encoded[i + 1]
        if high & 0xF0 != 0xD0 or low & 0x0F != 0x03:
            raise ValueError(f"invalid d-encoded pair at offset {i}")
        out[i // 2] = ((high & 0x0F) << 4) | (low >> 4)
    return bytes(out)


def encode_d_bytes(raw: bytes) -> bytes:
    """Encode bytes using Castle's confirmed two-byte ``d`` alphabet."""

    out = bytearray(len(raw) * 2)
    for i, value in enumerate(raw):
        out[2 * i] = 0xD0 | (value >> 4)
        out[2 * i + 1] = ((value & 0x0F) << 4) | 0x03
    return bytes(out)


@dataclass(frozen=True)
class CastlePayload:
    """The currently confirmed outer payload layout."""

    inner: bytes
    len_a: int
    len_b: int
    nonce: bytes
    tail: bytes
    ciphertext: bytes

    @property
    def payload_length(self) -> int:
        return 2 + len(self.inner) + 24 + len(self.ciphertext)


@dataclass(frozen=True)
class CurrentCastlePayload:
    """Current bundle framing: a full 16-byte nonce follows two split lengths."""

    inner: bytes
    len_a: int
    len_b: int
    nonce: bytes
    ciphertext: bytes


def parse_payload(payload: bytes) -> CastlePayload:
    """Parse the 2-byte-LE inner length and 24-byte outer header."""

    if len(payload) < 2:
        raise ValueError("payload is shorter than its inner-length field")
    inner_len = int.from_bytes(payload[:2], "little")
    header_start = 2 + inner_len
    header_end = header_start + 24
    if header_end > len(payload):
        raise ValueError("payload is shorter than its inner/header fields")
    inner = payload[2:header_start]
    len_a = int.from_bytes(payload[header_start:header_start + 4], "big")
    len_b = int.from_bytes(payload[header_start + 4:header_start + 8], "big")
    nonce = payload[header_start + 8:header_start + 20]
    tail = payload[header_start + 20:header_end]
    ciphertext = payload[header_end:]
    if len_a + len_b != len(ciphertext):
        raise ValueError(
            f"ciphertext length mismatch: lenA+lenB={len_a + len_b}, "
            f"actual={len(ciphertext)}"
        )
    return CastlePayload(inner, len_a, len_b, nonce, tail, ciphertext)


def parse_current_payload(payload: bytes) -> CurrentCastlePayload:
    """Parse the current bundle's 2-byte-length + 24-byte frame layout."""

    if len(payload) < 2:
        raise ValueError("payload is shorter than its inner-length field")
    inner_len = int.from_bytes(payload[:2], "little")
    header_start = 2 + inner_len
    header_end = header_start + 24
    if header_end > len(payload):
        raise ValueError("payload is shorter than its inner/header fields")
    inner = payload[2:header_start]
    len_a = int.from_bytes(payload[header_start:header_start + 4], "big")
    len_b = int.from_bytes(payload[header_start + 4:header_start + 8], "big")
    nonce = payload[header_start + 8:header_end]
    ciphertext = payload[header_end:]
    if len_a + len_b != len(ciphertext):
        raise ValueError(
            f"ciphertext length mismatch: lenA+lenB={len_a + len_b}, "
            f"actual={len(ciphertext)}"
        )
    return CurrentCastlePayload(inner, len_a, len_b, nonce, ciphertext)


def build_payload(frame: CastlePayload) -> bytes:
    """Serialize a parsed/constructed payload, checking all length fields."""

    if len(frame.inner) > 0xFFFF:
        raise ValueError("inner field exceeds its 16-bit length")
    if len(frame.nonce) != 12 or len(frame.tail) != 4:
        raise ValueError("Castle header requires a 12-byte nonce and 4-byte tail")
    if frame.len_a < 0 or frame.len_b < 0 or frame.len_a + frame.len_b != len(frame.ciphertext):
        raise ValueError("invalid ciphertext split")
    return (
        len(frame.inner).to_bytes(2, "little")
        + frame.inner
        + frame.len_a.to_bytes(4, "big")
        + frame.len_b.to_bytes(4, "big")
        + frame.nonce
        + frame.tail
        + frame.ciphertext
    )


def deflate_raw(data: bytes, *, level: int = 6) -> bytes:
    """Return a raw DEFLATE stream using Python's zlib implementation.

    Castle embeds its own raw-DEFLATE encoder.  This helper is useful for
    intermediate comparisons, but callers must still compare bytes against
    Castle before treating it as wire-compatible (the encoder's match/window
    choices can differ even when decompression is equivalent).
    """

    compressor = zlib.compressobj(level=level, wbits=-15)
    return compressor.compress(data) + compressor.flush()


def encode_current_inner(timestamp_ms: int, *, variant: str = 'legacy') -> bytes:
    """Encode the bundle's inner timestamp field.

    The older Castle UMD baseline uses the ``tg()`` 16-bit transform.  The
    currently deployed x-web UMD switched only this small framing transform:
    each decimal digit is represented as ``(0x78 + 2 * digit, 0xfc)``.  Both
    formats are kept because a locked legacy oracle and a live browser can be
    on different bundle revisions.
    """

    value = int(timestamp_ms)
    if value < 0:
        raise ValueError("timestamp_ms must be non-negative")
    if variant not in ('legacy', 'current'):
        raise ValueError("variant must be 'legacy' or 'current'")
    out = bytearray()
    for char in str(value):
        if variant == 'current':
            out.extend((0x78 + 2 * (ord(char) - 0x30), 0xfc))
        else:
            word = (ord(char) + ((118 << 8) | 157)) & 0xFFFF
            word = ((word + ((218 << 8) | 154)) & 0xFFFF) ^ ((119 << 8) | 178)
            out.extend((word >> 8, word & 0xFF))
    return base64.b64encode(bytes(out))


def build_current_payload(inner: bytes, encrypted_frame: bytes) -> bytes:
    """Assemble the current bundle's outer payload around an encrypted frame."""

    inner = bytes(inner)
    encrypted_frame = bytes(encrypted_frame)
    if len(inner) > 0xFFFF:
        raise ValueError("inner field exceeds its 16-bit length")
    if len(encrypted_frame) < 24:
        raise ValueError("encrypted frame is shorter than the 24-byte header")
    return len(inner).to_bytes(2, "little") + inner + encrypted_frame


def serialize_current_signals(values: list[object]) -> bytes:
    """Serialize the current bundle's dense ``Rl`` vector.

    The bundle feeds ``Rl`` through a compact tagged serializer before raw
    DEFLATE.  Browser captures for the current login path contain numbers,
    booleans, strings, and short integer arrays; those are implemented here
    byte-for-byte.  Unsupported object types fail loudly instead of silently
    producing a token with a different field layout.
    """

    out = bytearray()

    def put_byte(value: int) -> None:
        out.append(int(value) & 0xFF)

    def put_varint(value: int) -> None:
        value = int(value) & MASK32
        while value >= 0x80:
            put_byte((value & 0x7F) | 0x80)
            value >>= 7
        put_byte(value)

    def put_utf16_units(value: str) -> None:
        put_varint(len(value))
        for char in value:
            unit = ord(char)
            # The profile strings are BMP-only.  Match JS charCodeAt for a
            # non-BMP code point by emitting its UTF-16 surrogate pair.
            if unit > 0xFFFF:
                unit -= 0x10000
                units = (0xD800 | (unit >> 10), 0xDC00 | (unit & 0x3FF))
            else:
                units = (unit,)
            for item in units:
                put_byte(item)
                put_byte(item >> 8)

    def canonical_base64(value: str) -> bytes | None:
        if len(value) % 4:
            return None
        try:
            decoded = base64.b64decode(value, validate=True)
        except (ValueError, TypeError):
            return None
        return decoded if base64.b64encode(decoded).decode("ascii") == value else None

    def encode(value: object) -> None:
        if value is None:
            put_byte(0)
            return
        if isinstance(value, str):
            decoded = canonical_base64(value)
            if decoded is not None:
                put_byte(2)
                put_varint(len(decoded))
                out.extend(decoded)
                return
            if any(ord(char) > 0xFF for char in value):
                put_byte(1)
                put_utf16_units(value)
                return
            put_byte(9)
            put_varint(len(value))
            for char in value:
                put_byte(ord(char))
            return
        if isinstance(value, bool):
            put_byte(6 if value else 5)
            return
        if isinstance(value, (int, float)):
            number = float(value)
            if not math.isfinite(number):
                put_byte(0)
                return
            integer = int(value)
            if number.is_integer() and integer > 0x7FFFFFFF and integer <= MASK32:
                # The bundle's compact uint32 branch is reached only for
                # positive values outside signed int32 but within uint32.
                put_byte(3)
                unsigned = integer & MASK32
                for shift in (0, 8, 16, 24):
                    put_byte(unsigned >> shift)
                return
            if (not number.is_integer() or integer < -0x80000000 or integer > MASK32):
                import struct
                put_byte(4)
                out.extend(struct.pack(">d", number))
                return
            put_byte(10)
            put_varint(((integer << 1) ^ (integer >> 31)) & MASK32)
            return
        if isinstance(value, (list, tuple)):
            put_byte(7)
            put_varint(len(value))
            for item in value:
                encode(item)
            return
        raise TypeError(f"unsupported Castle signal value: {type(value).__name__}")

    put_varint(len(values))
    for value in values:
        encode(value)
    return bytes(out)


def _validate_current_serialized_signals(raw: bytes) -> None:
    """Validate a captured current-bundle serialized signal frame.

    Raw captures are deliberately accepted as an escape hatch for values
    that are expensive to reconstruct in Python, but accepting a truncated
    blob would produce a token with a plausible prefix and the wrong wire
    length.  The tagged format is self-delimiting, so validate the complete
    632/749-value frame before compressing it.
    """

    def read_varint(pos: int) -> tuple[int, int]:
        value = 0
        shift = 0
        for _ in range(5):  # uint32 varints are at most five bytes
            if pos >= len(raw):
                raise ValueError("truncated serialized signal varint")
            byte = raw[pos]
            pos += 1
            value |= (byte & 0x7F) << shift
            if byte < 0x80:
                return value, pos
            shift += 7
        raise ValueError("serialized signal varint exceeds uint32")

    def skip_value(pos: int) -> int:
        if pos >= len(raw):
            raise ValueError("truncated serialized signal tag")
        tag = raw[pos]
        pos += 1
        if tag in (0, 5, 6):  # null, false, true
            return pos
        if tag == 3:  # uint32
            end = pos + 4
            if end > len(raw):
                raise ValueError("truncated serialized uint32 signal")
            return end
        if tag == 4:  # IEEE-754 double
            end = pos + 8
            if end > len(raw):
                raise ValueError("truncated serialized float signal")
            return end
        if tag == 10:  # zig-zag signed integer
            _, pos = read_varint(pos)
            return pos
        if tag in (1, 2, 7, 9):
            length, pos = read_varint(pos)
            if tag == 7:  # nested list
                for _ in range(length):
                    pos = skip_value(pos)
                return pos
            width = 2 if tag == 1 else 1
            end = pos + length * width
            if end > len(raw):
                raise ValueError("truncated serialized signal payload")
            return end
        raise ValueError(f"unknown serialized signal tag: {tag}")

    count, pos = read_varint(0)
    if count not in (632, 749):
        raise ValueError(
            f"serialized Castle signal frame requires 632 or 749 values, got {count}")
    for _ in range(count):
        pos = skip_value(pos)
    if pos != len(raw):
        raise ValueError(
            f"serialized Castle signal frame has {len(raw) - pos} trailing bytes")


def deflate_current(data: bytes) -> bytes:
    """Run the current bundle's deterministic raw-DEFLATE implementation.

    This is intentionally not ``zlib.compress``: the Castle chunk uses a
    1024-byte, 64-candidate hash chain and emits one dynamic DEFLATE block.
    The match selection and Huffman tie-breaking below mirror that bundle.
    """

    source = bytes(data)
    n = len(source)

    class _Bits:
        __slots__ = ("buffer", "acc", "bits")

        def __init__(self):
            self.buffer: list[int] = []
            self.acc = 0
            self.bits = 0

        def write(self, value: int, width: int) -> None:
            if width <= 0:
                return
            value &= (1 << width) - 1
            self.acc |= value << self.bits
            self.bits += width
            while self.bits >= 8:
                self.buffer.append(self.acc & 0xFF)
                self.acc >>= 8
                self.bits -= 8

        def finish(self) -> bytes:
            if self.bits > 0:
                self.buffer.append(self.acc & 0xFF)
                self.acc = 0
                self.bits = 0
            return bytes(self.buffer)

    def emit_code(bits: _Bits, code: int, width: int) -> None:
        # The bundle stores canonical codes MSB-first and reverses them at
        # the bit writer boundary, as required by DEFLATE's LSB bit order.
        reversed_code = 0
        for _ in range(width):
            reversed_code = (reversed_code << 1) | (code & 1)
            code >>= 1
        bits.write(reversed_code, width)

    def huffman_lengths(freq: list[int], max_bits: int) -> list[int]:
        lengths = [0] * len(freq)
        leaves = [{"w": weight, "i": index}
                  for index, weight in enumerate(freq) if weight > 0]
        count = len(leaves)
        if count == 0:
            return lengths
        if count == 1:
            lengths[leaves[0]["i"]] = 1
            return lengths
        leaves.sort(key=lambda item: item["w"])
        original = [{"weight": item["w"], "syms": [item["i"]]}
                    for item in leaves]
        active = original
        for _ in range(2, max_bits + 1):
            merged = []
            for index in range(0, len(active) - 1, 2):
                merged.append({
                    "weight": active[index]["weight"] + active[index + 1]["weight"],
                    "syms": active[index]["syms"] + active[index + 1]["syms"],
                })
            merged_sorted = []
            left = right = 0
            while left < len(original) or right < len(merged):
                if (right >= len(merged) or
                        (left < len(original) and
                         original[left]["weight"] <= merged[right]["weight"])):
                    merged_sorted.append(original[left])
                    left += 1
                else:
                    merged_sorted.append(merged[right])
                    right += 1
            active = merged_sorted
        remaining = 2 * count - 2
        index = 0
        while remaining > index and index < len(active):
            for symbol in active[index]["syms"]:
                lengths[symbol] += 1
            index += 1
        return lengths

    def canonical_codes(lengths: list[int], max_bits: int) -> list[int]:
        counts = [0] * (max_bits + 1)
        for length in lengths:
            if length > 0:
                counts[length] += 1
        next_code = [0] * (max_bits + 1)
        code = 0
        for length in range(1, max_bits + 1):
            code = (code + counts[length - 1]) << 1
            next_code[length] = code
        result = [0] * len(lengths)
        for index, length in enumerate(lengths):
            if length > 0:
                result[index] = next_code[length]
                next_code[length] += 1
        return result

    length_base = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19,
                   23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
                   131, 163, 195, 227, 258]
    length_extra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
                    2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
                    5, 5, 5, 5, 0]
    distance_base = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65,
                     97, 129, 193, 257, 385, 513, 769, 1025, 1537,
                     2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
    distance_extra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5,
                      6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12,
                      12, 13, 13]

    literal_freq = [0] * 286
    distance_freq = [0] * 30
    tokens: list[dict[str, int]] = []
    use_matches = n >= 3
    head = [0] * 32768
    previous = [0] * n

    def update_chain(position: int) -> None:
        if position + 2 >= n:
            return
        key = (251 * source[position] + 11 * source[position + 1] +
               source[position + 2]) & 32767
        previous[position] = head[key]
        head[key] = position + 1

    def find_match(position: int) -> tuple[int, int]:
        if position + 2 >= n:
            return 0, 0
        key = (251 * source[position] + 11 * source[position + 1] +
               source[position + 2]) & 32767
        candidate = head[key] - 1
        lower = max(0, position - 1024)
        limit = min(258, n - position)
        best_length = 0
        best_distance = 0
        tries = 0
        while candidate >= lower and tries < 64:
            distance = position - candidate
            if (source[candidate] == source[position] and
                    source[candidate + 1] == source[position + 1] and
                    source[candidate + 2] == source[position + 2]):
                length = 3
                while length < limit and source[candidate + length] == source[position + length]:
                    length += 1
                if length > best_length:
                    best_distance = distance
                    best_length = length
                    if best_length >= 258:
                        break
            candidate = previous[candidate] - 1
            tries += 1
        return (best_length, best_distance) if best_length >= 3 else (0, 0)

    position = 0
    while position < n:
        length, distance = find_match(position) if use_matches else (0, 0)
        if length:
            length_index = 0
            for index, base in enumerate(length_base):
                extra = length_extra[index]
                if length >= base and length <= base + ((1 << extra) - 1):
                    length_index = index
                    break
            length_code = 257 + length_index
            length_value = length - length_base[length_index]
            distance_index = 0
            for index, base in enumerate(distance_base):
                extra = distance_extra[index]
                if distance >= base and distance <= base + ((1 << extra) - 1):
                    distance_index = index
                    break
            distance_value = distance - distance_base[distance_index]
            tokens.append({"m": 1, "lc": length_code,
                           "le": length_extra[length_index], "lv": length_value,
                           "dc": distance_index, "de": distance_extra[distance_index],
                           "dv": distance_value})
            literal_freq[length_code] += 1
            distance_freq[distance_index] += 1
            for offset in range(length):
                update_chain(position + offset)
            position += length
        else:
            literal = source[position]
            tokens.append({"m": 0, "b": literal})
            literal_freq[literal] += 1
            update_chain(position)
            position += 1
    literal_freq[256] += 1

    literal_lengths = huffman_lengths(literal_freq, 15)
    distance_lengths = huffman_lengths(distance_freq, 15)
    if not any(distance_freq):
        distance_lengths[0] = 1
        distance_lengths[1] = 1
    literal_count = 286
    while literal_count > 257 and literal_lengths[literal_count - 1] == 0:
        literal_count -= 1
    distance_count = 30
    while distance_count > 1 and distance_lengths[distance_count - 1] == 0:
        distance_count -= 1
    code_lengths = literal_lengths[:literal_count] + distance_lengths[:distance_count]
    run_codes: list[dict[str, int]] = []
    index = 0
    while index < len(code_lengths):
        value = code_lengths[index]
        end = index + 1
        while end < len(code_lengths) and code_lengths[end] == value:
            end += 1
        count = end - index
        if value != 0:
            run_codes.append({"sym": value, "extra": 0, "extraBits": 0})
            count -= 1
            while count >= 3:
                amount = 6 if count > 6 else count
                run_codes.append({"sym": 16, "extra": amount - 3, "extraBits": 2})
                count -= amount
            while count > 0:
                run_codes.append({"sym": value, "extra": 0, "extraBits": 0})
                count -= 1
        else:
            while count >= 11:
                amount = 138 if count > 138 else count
                run_codes.append({"sym": 18, "extra": amount - 11, "extraBits": 7})
                count -= amount
            while count >= 3:
                amount = 10 if count > 10 else count
                run_codes.append({"sym": 17, "extra": amount - 3, "extraBits": 3})
                count -= amount
            while count > 0:
                run_codes.append({"sym": 0, "extra": 0, "extraBits": 0})
                count -= 1
        index = end

    run_freq = [0] * 19
    for item in run_codes:
        run_freq[item["sym"]] += 1
    run_lengths = huffman_lengths(run_freq, 7)
    code_length_order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5,
                         11, 4, 12, 3, 13, 2, 14, 1, 15]
    run_count = 19
    while run_count > 4 and run_lengths[code_length_order[run_count - 1]] == 0:
        run_count -= 1
    literal_codes = canonical_codes(literal_lengths, 15)
    distance_codes = canonical_codes(distance_lengths, 15)
    run_codes_canonical = canonical_codes(run_lengths, 7)
    bits = _Bits()
    bits.write(1, 1)
    bits.write(2, 2)
    bits.write(literal_count - 257, 5)
    bits.write(distance_count - 1, 5)
    bits.write(run_count - 4, 4)
    for index in range(run_count):
        bits.write(run_lengths[code_length_order[index]], 3)
    for item in run_codes:
        emit_code(bits, run_codes_canonical[item["sym"]], run_lengths[item["sym"]])
        if item["extraBits"]:
            bits.write(item["extra"], item["extraBits"])
    for item in tokens:
        if item["m"] == 0:
            emit_code(bits, literal_codes[item["b"]], literal_lengths[item["b"]])
        else:
            emit_code(bits, literal_codes[item["lc"]], literal_lengths[item["lc"]])
            if item["le"]:
                bits.write(item["lv"], item["le"])
            emit_code(bits, distance_codes[item["dc"]], distance_lengths[item["dc"]])
            if item["de"]:
                bits.write(item["dv"], item["de"])
    emit_code(bits, literal_codes[256], literal_lengths[256])
    return bits.finish()


def deflate_current_native(data: bytes) -> bytes:
    """Compress with the Chromium zlib profile used by native CompressionStream.

    This is deliberately separate from :func:`deflate_current`: the Castle
    fallback is a valid, deterministic stream but is not byte-identical to
    Chrome.  The binding raises when the bundled native backend is absent so
    callers cannot silently send a shorter/different token while claiming
    browser parity.
    """

    from utils.chromium_deflate import deflate_raw

    return deflate_raw(data)


# Current bundle cipher helpers.
_CURRENT_MASK = 0xFFFFFFFF


def _cu(value: int) -> int:
    return value & _CURRENT_MASK


def _curshift(value: int, bits: int) -> int:
    return (value & _CURRENT_MASK) >> (bits & 31)


def _cimul(a: int, b: int) -> int:
    return ((a & _CURRENT_MASK) * (b & _CURRENT_MASK)) & _CURRENT_MASK


def _cpack(a: int, b: int, c: int, d: int) -> int:
    return _cu((a << 24) | (b << 16) | (c << 8) | d)


def _crol(value: int, bits: int) -> int:
    bits &= 31
    return _cu((value << bits) | _curshift(value, 32 - bits)) if bits else _cu(value)


def _c_nswv(r: int, t: int, f: int, u: int, e: int, mask: int) -> int:
    return _cu(r ^ ((t - f) * (u ^ e))) & mask


def _c_nsvu(r: int, t: int, f: int, u: int, e: int, o: int) -> int:
    return _cimul(r ^ t, _cpack(f, u, e, o))


def _c_nsz(n: int, r: int, t: int, f: int) -> int:
    return (n & 1023) ^ (_curshift(r, t) & 1023) ^ f


def _c_nsw9(r: int, t: int, f: int, u: int, mask: int) -> int:
    return (_curshift(r, t) ^ f ^ u ^ mask) & 127


def _c_nsw_e(r: int, u: int, e: int, o: int, c: int, i: int) -> int:
    return _cu(r ^ _cpack(u, e, o, c) ^ i)


def _c_nsw8(r: int, u: int, e: int, o: int, c: int, i: int) -> int:
    return _cu(_crol(r, 13) ^ _cpack(e, o, c, i))


def _c_nga_imul(t: int, f: int, u: int, e: int,
                 o: int, c: int, i: int, a: int,
                 w: int, v: int, d: int, l: int, y: int) -> int:
    first = _cu(t ^ _curshift(f, u)) >> (e & 31)
    packed = _cu(((o << c) | i) << a | (w << v) | d)
    return _cimul(first, _curshift(packed, l)) >> (y & 31)


def castle_current_stream_encrypt(
    plaintext: bytes, *, timestamp_ms: int | None = None
) -> bytes:
    """Encrypt one compressed frame with the current Castle bundle."""

    import time

    src = bytes(plaintext)
    length = len(src)
    if length > _CURRENT_MASK:
        raise ValueError("Castle frame is too large")
    now = int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms)

    yk, yt, yf, yu = 5, 1, 2, 3
    pg, pA, pB = 8, 16, 24
    yr, ye, pC, s_dollar = 255, 7, 127, 21
    bo, yE, y1, pI, pw = 10, 13, 15, 17, 31
    l8 = 0
    t0 = [0x86F04A55, 0x4BDC410B, 0, 0x168D97B0, 0,
          0x9C3FC74F, 0, 0x71935F08, 0, 0, 0, 0, 0, 0, 0, 0]

    t1 = _cu(((0xEFAF45C8 + 0x66C897AE) ^ _curshift(0xEFAF45C8, 6))
             + 0x99E5E56A)
    t7 = _cu((t1 + 0x2C559D6E) * 63815)
    t8 = _cu(t7 ^ _curshift(t7, 5) ^ 0xA2789ED0)
    t9 = _cu((t8 ^ pg) + pg) & y1
    t10 = _cu(t0[t9] - (_cu((t8 << 20) | _curshift(t8, 12)) + 0x26C0AAD6))
    t11 = _c_nsz(t10, t8, 20, 714)
    t12 = _curshift(t10, bo) & ye
    t13 = _curshift(t10, s_dollar) & pC
    t14 = _c_nsw9(t8, 18, t11, 94, t12)
    t15 = _cu(t13 ^ t14)
    t16 = ((_cu(t15) | _cu(-t15)) >> 31) ^ 1
    _ = _c_nswv(t11, yt, t16, t11, yE, y1)
    t23 = length // 2

    t26 = _cu(
        (_cu((t1 ^ 298213646) << yk) |
         _curshift(t1 ^ 298213646, 27)) * 43235 + 0xCB374370
    )
    t27 = _cu(t26 ^ _curshift(t26, ye))
    t28 = (_cu(_crol(t27, 15) + 307) ^ 2) & y1
    t29 = _cu(t0[t28] ^ (_cu(~_cu((t27 << 8) | _curshift(t27, 24)))
                         ^ 0xAAE9E276))
    t30 = _c_nsz(t29, t27, 15, 307)
    t31 = _curshift(t29, bo) & ye
    t32 = _curshift(t29, s_dollar) & pC
    t33 = _c_nsw9(t27, 25, t30, 90, t31)
    t34 = _cu(t32 ^ t33)
    t35 = ((_cu(t34) | _cu(-t34)) >> 31) ^ 1
    _ = _c_nswv(t30, yt, t35, t30, y1, y1)
    t41, t42, t44 = length // 2, length, length - length // 2

    t46 = 0x07D007C7
    for ch in str(now):
        t46 = _c_nsvu(t46, ord(ch), yt, l8, yt, 147)

    t1 = _cu(_cimul(t1 ^ 0xAD180B2F, 45825) + 0x80CE8AE1)
    t1 = _cu(_crol(t1 ^ 3533852484, 12) ^ _curshift(t1, 4))
    t1 = _cu(t1 + 0x115C5E38)
    t1 = _cu(_crol(t1 ^ 1234343096, 27) ^ _curshift(t1, 13))
    t1 = _cu(t1 + 175682300)

    t49 = _cu(t46 ^ _cpack(151, 153, 64, 175))
    t50 = _cu(t46 ^ _cpack(54, pw, 37, 43) ^ _cpack(183, 205, 238, 103))
    t51 = _cu(t46 ^ _cpack(yt, 37, 122, 190))
    # ``OJ`` is 70 in this bundle (the adjacent ``sq`` alias is 27); using
    # the wrong byte only affects the third nonce word, not the ciphertext.
    t52 = _cu(t46 ^ _cpack(148, 70, 175, 248) ^ _cpack(183, 205, 238, 103))
    t53 = _cu(t46 ^ _cpack(109, 237, 114, 146))
    p1, c1 = _cpack(155, 54, 203, 223), _cpack(yt, 37, 122, 190)
    p2, c2 = _cpack(99, 17, 131, 145), _cpack(bo, 113, 214, 73)
    p3 = _cpack(92, 162, 201, 166)
    encrypted = bytearray(length)
    for i, value in enumerate(src):
        t51 = _cu(t51 ^ ((value & yr) + ((i + p1) & yr)) ^ c1)
        t51 = _cu(t51 ^ _curshift(t51, yE))
        if i < t23:
            t52 = _cu(t52 ^ ((value & yr) + ((i + p2) & yr)) ^ c2)
            t52 = _cu(t52 ^ _curshift(t52, yE))
        elif i < t42:
            t50 = _cu(t50 ^ ((value & yr) + ((i - t41 + p2) & yr)) ^ c2)
            t50 = _cu(t50 ^ _curshift(t50, yE))
        if (i & yu) == l8:
            t53 = _cu(t53 + i + p3)
            t53 = _cu(t53 + _cpack(109, 237, 114, 146))
            t53 = _cu(t53 ^ (t53 << yE))
            t53 = _cu(t53 ^ _curshift(t53, pI))
            t53 = _cu(t53 ^ (t53 << yk))
            t53 = _cu(t53 + _cpack(96, 61, 105, 112))
        encrypted[i] = value ^ (_curshift(t53, (i & yu) * pg) & yr)

    def mix(seed: int, a: int, b: int, c: int, d: int,
            e: int, f: int, g: int, h: int, i: int, j: int,
            k: int, l: int, m: int) -> int:
        return _c_nga_imul(a, b, c, d, e, f, g, h, i, j, k, l, m)

    t56 = _c_nsw_e(t51, 91, 152, 196, 172, yt)
    t56 = mix(t56, t56, t56, pA, l8, 170, pg, 36, pA, 44, pg, 97, l8, l8)
    t56 = _c_nsw8(t56, t56, 91, pw, 68, 219)
    t56 = mix(t56, t56, t56, y1, l8, yt, pg, l8, pA, yt, pg, 147, l8, l8)
    t57 = _c_nsw_e(t51, 145, 14, 104, 165, yf)
    t57 = mix(t57, t57, t57, pA, l8, 81, pg, 246, pA, 11, pg, 223, l8, l8)
    t57 = _c_nsw8(t57, t57, 134, 124, 193, 245)
    t57 = mix(t57, t57, t57, y1, l8, yt, pg, l8, pA, yt, pg, 147, l8, l8)
    t58 = _c_nsw_e(t52, 183, 205, 238, 103, yu)
    t58 = mix(t58, t58, t58, pA, l8, 99, pg, 17, pA, 131, pg, 145, l8, l8)
    t58 = _c_nsw8(t58, t58, bo, 113, 214, 73)
    t58 = mix(t58, t58, t58, y1, l8, yt, pg, l8, pA, yt, pg, 147, l8, l8)
    t59 = _c_nsw_e(t50, 183, 205, 238, 103, yk)
    t59 = mix(t59, t59, t59, pA, l8, 99, pg, 17, pA, 131, pg, 145, l8, l8)
    t59 = _c_nsw8(t59, t59, bo, 113, 214, 73)
    t59 = mix(t59, t59, t59, y1, l8, yt, pg, l8, pA, yt, pg, 147, l8, l8)

    const = _cpack(151, 153, 64, 175)
    def nsa(value: int, extra: int) -> int:
        return _cimul(value ^ extra ^ const, _cpack(yt, l8, yt, 147))
    n60 = nsa(t49, l8)
    n60 = _cimul(_cu(n60 ^ _curshift(n60, pA)), const)
    n61 = nsa(t49, yt)
    n61 = _cimul(_cu(n61 ^ _curshift(n61, pA)), const)
    n62 = nsa(t49, yf)
    n62 = _cimul(_cu(n62 ^ _curshift(n62, pA)), const)
    n63 = nsa(t49, yu)
    n63 = _cimul(_cu(n63 ^ _curshift(n63, pA)), const)
    nonce = bytearray()
    for word, mask in ((t56, n60), (t57, n61), (t58, n62), (t59, n63)):
        nonce.extend((
            (_curshift(word, 24) ^ _curshift(mask, 24)) & yr,
            (_curshift(word, 16) ^ _curshift(mask, 16)) & yr,
            (_curshift(word, 8) ^ _curshift(mask, 8)) & yr,
            (word ^ mask) & yr,
        ))
    return (t44.to_bytes(4, 'big') + t23.to_bytes(4, 'big') +
            bytes(nonce) + bytes(encrypted))


def castle_live_umd_stream_encrypt(
    plaintext: bytes, *, timestamp_ms: int | None = None
) -> bytes:
    """Encrypt a frame with the live x-web ``castle.umd`` mixer.

    The login page currently loads the 749-slot UMD bundle.  Its frame
    mixer is a separate revision from the historical ``castle.js`` mixer
    above; the implementation below is a direct integer port of the UMD's
    32-bit operations (including JavaScript's unsigned-shift semantics).
    Keeping it separate preserves the old 632-slot vectors while allowing
    the live profile to be checked byte-for-byte against Chrome.
    """
    import time

    src = bytes(plaintext)
    length = len(src)
    if length > 0xFFFF:
        raise ValueError("Castle frame is too large")
    now = int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms)
    if now < 0:
        raise ValueError("timestamp_ms must be non-negative")

    def u(value: int) -> int:
        return value & MASK32

    def shr(value: int, bits: int) -> int:
        return u(value) >> (bits & 31)

    def imul(left: int, right: int) -> int:
        return u((u(left) * u(right)))

    def pack(a: int, b: int, c: int, d: int) -> int:
        return u(((a << 8 | b) << 16) | (c << 8) | d)

    def rotl(value: int, bits: int) -> int:
        bits &= 31
        return u((u(value) << bits) | shr(value, 32 - bits)) if bits else u(value)

    # Obfuscated dispatch helpers used by this particular UMD function.
    def p_lf(t: int, n: int, r: int, i: int, a: int, o: int, s: int) -> int:
        return u((shr(u(t + n), r) ^ shr(i, a)) + o) >> (s & 31)

    def p_dp(t: int, n: int, r: int, i: int, a: int, o: int,
             s: int, c: int, l: int, ee: int, te: int) -> int:
        # ``p(109, ...)`` in the UMD.
        left = shr(u((u(t) ^ u(n)) << r | shr(u(i) ^ u(a), o)), s)
        return u((left ^ shr(c, l)) + ee) >> (te & 31)

    def p_vd(t: int, n: int, r: int, i: int, a: int) -> int:
        return shr(u((u(t) ^ u(n)) * r + i), a)

    def p_hf(t: int, n: int, r: int, i: int, a: int,
             o: int, s: int, c: int) -> int:
        return shr(((u(t) << n | u(r)) << i | (u(a) << o) | u(s)), c)

    def p_cp(t: int, n: int, r: int, i: int, a: int,
             o: int, s: int, c: int, l: int, ee: int) -> int:
        return shr(u(t) ^ shr(((u(n) << r | u(i)) << a) |
                              (u(o) << s) | u(c), l), ee)

    def p_sf(t: int, n: int, r: int, i: int, a: int,
             o: int, s: int, c: int, l: int, ee: int) -> int:
        return shr(u(t) + shr(((u(n) << r | u(i)) << a) |
                              (u(o) << s) | u(c), l), ee)

    def p_vd_full(n: int, r: int, i: int, a: int, o: int,
                  s: int, c: int, l: int, ee: int, te: int,
                  ne: int, re: int, ie: int) -> int:
        packed = shr(((u(o) << s | u(c)) << l) |
                     (u(ee) << te) | u(ne), re)
        return shr(imul(shr(u(n) ^ shr(u(r), i), a), packed), ie)

    def p_ap(t: int, n: int, r: int, i: int) -> int:
        return u(shr(u(t) | u(-n), r) ^ u(i))

    def p_zf(t: int, n: int, r: int, i: int, a: int, o: int) -> int:
        return u((u(t) ^ (n - r) * (u(i) ^ u(a))) & o)

    def p_bp(t: int, n: int, r: int, i: int) -> int:
        return u((shr(t, n) & 255) ^ (shr(r, i) & 255)) & 255

    def u_yf(t: int, n: int, r: int, i: int) -> int:
        return shr(u(t) ^ shr(u(n), r), i)

    def u_ep(t: int, n: int, r: int, i: int, a: int,
             o: int, s: int, c: int) -> int:
        return u((shr(u(t) << n | shr(u(r), i), a) + o) ^ s) & c

    def u_xd(values: list[object], index: int, r: int, i: int, a: int,
             o: int, s: int, c: int, l: int, ee: int) -> int:
        rotated = shr(u(r) << i | shr(u(a), o), s)
        return shr(u(values[index]) ^ u((~rotated) ^ u(c)), l) >> (ee & 31)

    def u_ff(t: int, n: int, r: int, i: int) -> int:
        return u((t & 1023) ^ (shr(n, r) & 1023) ^ i)

    def d_ep(t: int, n: int) -> int:
        return int((t * n) // 2)

    def d_nf(n: int, r: int, i: int, a: int, o: int,
             s: int, c: int, l: int, ee: int, te: int,
             ne: int, re: int) -> int:
        packed = shr(((u(a) << o | u(s)) << c) |
                     (u(l) << ee) | u(te), ne)
        return shr(imul(shr(u(n) ^ u(r), i), packed), re)

    def d_dp(t: int, n: int, r: int, i: int, a: int, o: int) -> int:
        return u(rotl(t, 13) ^ pack(r, i, a, o))

    def d_seven(t: int, n: int, r: int, i: int, a: int,
                o: int, s: int, c: int, l: int, ee: int) -> int:
        value = shr((u(t) ^ u(n)) << r | shr(u(i) ^ u(a), o), s)
        return shr(value * c + l, ee)

    def d_sf(t: int, n: int, r: int, i: int, a: int, o: int) -> int:
        return (shr(t, n) ^ u(r) ^ u(i) ^ u(a)) & o

    def f_op(t: int, n: int, r: int, i: int, a: int, o: int) -> int:
        return u(u(t) ^ pack(n, r, i, a) ^ o)

    def f_tf(t: int, n: int) -> int:
        const_a = pack(49, 10, 175, 251)
        const_b = pack(1, 0, 1, 147)
        return imul(u(u(t) ^ u(n) ^ const_a), const_b)

    # The UMD stores a small table on n[0] and later selects Math.imul from
    # it through the obfuscating dispatch helpers.
    table: list[object] = [None] * 15
    table[10] = 2384590613
    table[8] = 'valueOf'
    table[4] = 1770853823
    table[2] = 'then'
    table[11] = 'constructor'
    table[7] = 'toString'
    table[12] = 'imul'
    table[6] = 4008323090
    table[13] = 1258216044
    table[14] = 'length'
    table[3] = 1744925664

    n1 = 1688141559
    n2 = src
    n3 = length
    n4 = bytearray(n3 + 24)
    n6 = d_ep(n3, 0)
    n7 = d_ep(n3, 1)
    n1 = p_dp(n1,  # UV, A, n1, UV, S_, 0, n1, I, 2904138674, 0
              pack(111, 241, 244, 37), 7, n1,
              pack(111, 241, 244, 37), 25, 0, n1, 17,
              2904138674, 0)
    n8 = u(n7 - n6)
    n9 = d_ep(n3, 1)
    n1 = p_lf(n1, 416218921, 0, n1, 18, 3878754293, 0)
    n10 = d_ep(n3, 2)
    n12 = u(n10 - n9)
    n4[0:4] = n12.to_bytes(4, 'big')
    n1 = p_lf(n1, 569381830, 0, n1, 12, 3725960099, 0)
    n4[4:8] = n8.to_bytes(4, 'big')
    n1 = p_vd(n1, 4039390503, 54413, 2110968904, 0)
    n1 = p_dp(n1, pack(111, 50, 108, 156), 18, n1,
              pack(111, 50, 108, 156), 14, 0, n1, 12,
              450926480, 0)
    n13 = str(now)
    n14 = p_hf(188, 8, 13, 16, 120, 8, 213, 0)
    for index, char in enumerate(n13):
        n16 = ord(char)
        n14 = d_nf(n14, n16, 0, 1, 8, 0, 16, 1, 8, 147, 0, 0)
    n14 = u(n14 or pack(158, 55, 121, 185))
    n17 = u(n14 ^ pack(118, 14, 171, 200) ^ pack(56, 199, 192, 73))
    n18 = p_cp(n14, 49, 8, 10, 16, 175, 8, 251, 0, 0)
    n19 = u(n14 ^ pack(212, 87, 33, 27) ^ pack(56, 199, 192, 73))
    n20 = p_cp(n14, 152, 8, 155, 16, 220, 8, 8, 0, 0)
    n21 = p_cp(n14, 205, 8, 0, 16, 80, 8, 68, 0, 0)

    for index, value in enumerate(n2):
        byte = value & 255
        n21 = u(n21 ^ u(byte + ((index + pack(73, 113, 59, 125)) & 255)) ^
                pack(205, 0, 80, 68))
        n21 = u(n21 ^ shr(n21, 13))
        if index < n7:
            n19 = u(n19 ^ u(byte + ((index - n6 + pack(2, 118, 108, 108)) & 255)) ^
                    pack(74, 96, 88, 170))
            n19 = u(n19 ^ shr(n19, 13))
        elif index < n10:
            n17 = u(n17 ^ u(byte + ((index - n9 + pack(2, 118, 108, 108)) & 255)) ^
                    pack(74, 96, 88, 170))
            n17 = u(n17 ^ shr(n17, 13))
        if (index & 3) == 0:
            n20 = u(n20 + index + pack(21, 95, 172, 219))
            n20 = p_sf(n20, 152, 8, 155, 16, 220, 8, 8, 0, 0)
            n20 = u(n20 ^ (n20 << 13))
            n20 = u(n20 ^ shr(n20, 17))
            n20 = u(n20 ^ (n20 << 5))
            n20 = p_sf(n20, 164, 8, 165, 16, 197, 8, 91, 0, 0)
            n20 = u(n20)
        n4[24 + index] = (byte ^ (shr(n20, (index & 3) * 8) & 255)) & 255

    n24 = f_op(n21, 146, 220, 118, 218, 1)
    n24 = p_vd_full(n24, n24, 16, 0, 51, 8, 206, 16, 192, 8, 199, 0, 0)
    n24 = d_dp(n24, n24, 84, 208, 208, 237)
    n24 = p_vd_full(n24, n24, 15, 0, 1, 8, 0, 16, 1, 8, 147, 0, 0)
    n25 = f_op(n21, 121, 7, 108, 42, 2)
    n25 = p_vd_full(n25, n25, 16, 0, 145, 8, 232, 16, 214, 8, 235, 0, 0)
    n25 = d_dp(n25, n25, 222, 251, 220, 194)
    n25 = p_vd_full(n25, n25, 15, 0, 1, 8, 0, 16, 1, 8, 147, 0, 0)
    n26 = f_op(n19, 56, 199, 192, 73, 3)

    n28 = d_seven(n1, pack(111, 189, 219, 54), 24, n1,
                  pack(111, 189, 219, 54), 8, 0, 63161, 339560408, 0)
    n29 = u_yf(n28, n28, 15, 0)
    n30 = u_ep(n29, 29, n29, 3, 0, 808, 3, 15)
    n31 = u_xd(table, n30, n29, 26, n29, 6, 0, 3073941918, 0, 0)
    n32 = u_ff(n31, n29, 17, 137)
    n33 = (shr(n31, 10) & 7)
    n34 = (shr(n31, 21) & 127)
    n35 = d_sf(n29, 2, n32, 62, n33, 127)
    n36 = u(n34 ^ n35)
    n37 = p_ap(n36, n36, 31, 1)
    n38 = p_zf(n32, 1, n37, n32, 14, 15)
    n42 = u_yf(n26, n26, 16, 0)
    n43 = p_hf(2, 8, 118, 16, 58, 8, 109, 0)
    n26 = d_dp(imul(n42, n43), imul(n42, n43), 74, 96, 88, 170)
    n26 = p_vd_full(n26, n26, 15, 0, 1, 8, 0, 16, 1, 8, 147, 0, 0)
    n44 = f_op(n17, 56, 199, 192, 73, 5)
    n44 = p_vd_full(n44, n44, 16, 0, 2, 8, 118, 16, 58, 8, 109, 0, 0)
    n44 = d_dp(n44, n44, 74, 96, 88, 170)
    n44 = p_vd_full(n44, n44, 15, 0, 1, 8, 0, 16, 1, 8, 147, 0, 0)


    const_a = pack(49, 10, 175, 251)
    def finish_word(value: int, lane: int) -> int:
        value = f_tf(value, lane)
        value = u(value ^ shr(value, 16))
        return imul(value, const_a)

    n45 = finish_word(n18, 0)
    for offset, word in enumerate((n24,)):
        base = 8
        n4[base + offset * 4 + 0] = p_bp(word, 24, n45, 24)
        n4[base + offset * 4 + 1] = p_bp(word, 16, n45, 16)
        n4[base + offset * 4 + 2] = p_bp(word, 8, n45, 8)
        n4[base + offset * 4 + 3] = u(word & 255) ^ u(n45 & 255)

    n46 = f_tf(n18, 1)
    n46 = u(n46 ^ shr(n46, 16))
    n48 = d_seven(n1, pack(163, 129, 19, 230), 9, n1,
                  pack(163, 129, 19, 230), 23, 0, 59767, 2667377672, 0)
    n49 = u_yf(n48, n48, 18, 0)
    n50 = u_ep(n49, 19, n49, 13, 0, 507, 6, 15)
    n51 = u_xd(table, n50, n49, 4, n49, 28, 0, 2576543822, 0, 0)
    n52 = u_ff(n51, n49, 17, 42)
    n53 = shr(n51, 10) & 7
    n54 = shr(n51, 21) & 127
    n55 = d_sf(n49, 11, n52, 72, n53, 127)
    n56 = u(n54 ^ n55)
    n57 = p_ap(n56, n56, 31, 1)
    n58 = p_zf(n52, 1, n57, n52, 14, 15)
    n62 = n46
    n63 = p_hf(49, 8, 10, 16, 175, 8, 251, 0)
    n46 = imul(n62, n63)

    n45 = finish_word(n18, 0)
    n64 = finish_word(n18, 2)
    n65 = finish_word(n18, 3)
    # The first lane is stored at offset 8, followed by the remaining three
    # words at offsets 12, 16, and 20.
    for base, word, mask in ((8, n24, n45), (12, n25, n46),
                             (16, n26, n64), (20, n44, n65)):
        n4[base + 0] = p_bp(word, 24, mask, 24)
        n4[base + 1] = p_bp(word, 16, mask, 16)
        n4[base + 2] = p_bp(word, 8, mask, 8)
        n4[base + 3] = u(word & 255) ^ u(mask & 255)
    return bytes(n4)


def build_current_token_pure(
    values: list[object],
    *,
    timestamp_ms: int,
    prefix: str = None,
    compression: str = 'fallback',
    inner_variant: str = None,
) -> str:
    """Build a current-bundle token without the Node/browser bridge.

    ``values`` must be a complete 632-slot legacy or 749-slot live ``Rl``
    vector captured from the same page state as the request. ``compression='native'`` selects the bundled
    Chromium-zlib profile and is the mode for browser-byte parity;
    ``compression='fallback'`` retains Castle's own deterministic fallback
    for historical vectors/tests.  Neither mode invents missing browser
    signals or reads cookies/localStorage; callers must supply the vector.
    """

    if prefix is None:
        # Keep the historical marker for short/unit-test vectors, but make a
        # complete live 749-slot vector safe when this lower-level helper is
        # called directly instead of through ``generate_pure``.
        prefix = (LIVE_UMD_TOKEN_PREFIX if len(values) == 749
                  else CURRENT_TOKEN_PREFIX)
    if not isinstance(prefix, str) or not prefix or '|' in prefix:
        raise ValueError("prefix must be a non-empty token marker without '|'")
    timestamp = int(timestamp_ms)
    if timestamp < 0:
        raise ValueError("timestamp_ms must be non-negative")
    if compression not in ('fallback', 'native'):
        raise ValueError("compression must be 'native' or 'fallback'")
    raw = serialize_current_signals(values)
    return build_current_token_raw_pure(
        raw, timestamp_ms=timestamp, prefix=prefix, compression=compression,
        inner_variant=inner_variant, validate=len(values) in (632, 749))


def build_current_token_raw_pure(
    raw: bytes | bytearray | list[int],
    *,
    timestamp_ms: int,
    prefix: str = None,
    compression: str = 'fallback',
    inner_variant: str = None,
    validate: bool = False,
) -> str:
    """Build a current token from an already captured serialized signal blob.

    The browser-side UMD serializes the 749-slot signal vector before it
    enters ``CompressionStream``.  A diagnostic capture may therefore keep
    that exact byte blob instead of the higher-level ``Rl`` vector.  This
    lower-level entry point preserves those bytes verbatim and performs only
    the compression, timestamp framing, and Python outer encryption locally.
    """

    if isinstance(raw, list):
        try:
            raw = bytes(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("raw signal list must contain byte values") from exc
    else:
        raw = bytes(raw)
    if prefix is None:
        prefix = LIVE_UMD_TOKEN_PREFIX
    if not isinstance(prefix, str) or not prefix or '|' in prefix:
        raise ValueError("prefix must be a non-empty token marker without '|' ")
    timestamp = int(timestamp_ms)
    if timestamp < 0:
        raise ValueError("timestamp_ms must be non-negative")
    if compression not in ('fallback', 'native'):
        raise ValueError("compression must be 'native' or 'fallback'")
    if validate:
        _validate_current_serialized_signals(raw)
    compressed = (deflate_current_native(raw) if compression == 'native'
                  else deflate_current(raw))
    if inner_variant is None:
        inner_variant = ('current' if prefix == LIVE_UMD_TOKEN_PREFIX
                         else 'legacy')
    inner = encode_current_inner(timestamp, variant=inner_variant)
    # The live 749-slot UMD revision uses a distinct outer mixer.  Keep the
    # historical mixer for legacy profiles, but select the UMD mixer for the
    # current marker so the frame is byte-for-byte identical to Chrome.
    frame = (castle_live_umd_stream_encrypt(compressed, timestamp_ms=timestamp)
             if prefix == LIVE_UMD_TOKEN_PREFIX
             else castle_current_stream_encrypt(compressed, timestamp_ms=timestamp))
    payload = build_current_payload(inner, frame)
    return prefix + '|' + base64.b64encode(payload).decode('ascii')
