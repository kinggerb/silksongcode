#!/usr/bin/env python3
"""Read, edit and rewrite a UnityFS bundle one block at a time.

Verified layout (Silksong WebGL, Unity 6000.0.50f1):
  * UnityFS header, blocks info and node table are BIG endian;
  * the blocks info starts on a 16-byte boundary, and `flags & 0x200` pads the
    block data to a 16-byte boundary as well;
  * a block's own flags repeat the header's 0x40 bit and carry the block
    compression type in the low 6 bits;
  * node sizes never change, so the decompressed stream layout is preserved and
    every object keeps its offset.  Edits are size-preserving by construction.
"""
import lzma
import os
import struct

import lz4.block

CT_NONE, CT_LZMA, CT_LZ4, CT_LZ4HC = 0, 1, 2, 3
FLAG_COMBINED = 0x40
FLAG_BLOCKS_AT_END = 0x80
FLAG_INFO_PADDING = 0x200
DEFAULT_BLOCK = 1 << 17     # 128 KiB uncompressed blocks


class Reader:
    def __init__(self, data, endian="<", pos=0):
        self.d = data
        self.p = pos
        self.e = endian

    def u8(self):
        v = self.d[self.p]; self.p += 1; return v

    def u16(self):
        v = struct.unpack_from(self.e + "H", self.d, self.p)[0]; self.p += 2; return v

    def i16(self):
        v = struct.unpack_from(self.e + "h", self.d, self.p)[0]; self.p += 2; return v

    def u32(self):
        v = struct.unpack_from(self.e + "I", self.d, self.p)[0]; self.p += 4; return v

    def i32(self):
        v = struct.unpack_from(self.e + "i", self.d, self.p)[0]; self.p += 4; return v

    def u64(self):
        v = struct.unpack_from(self.e + "Q", self.d, self.p)[0]; self.p += 8; return v

    def i64(self):
        v = struct.unpack_from(self.e + "q", self.d, self.p)[0]; self.p += 8; return v

    def cstr(self):
        end = self.d.index(b"\0", self.p)
        s = self.d[self.p:end].decode("utf-8", "replace"); self.p = end + 1; return s

    def align(self, n=4):
        rem = self.p % n
        if rem:
            self.p += n - rem


def lzma_block(data, usize):
    props = data[:5]
    filters = [{"id": lzma.FILTER_LZMA1,
                "dict_size": max(struct.unpack_from("<I", props, 1)[0], 4096)}]
    dec = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=filters)
    out = dec.decompress(data[5:], max_length=usize)
    while len(out) < usize and not dec.eof:
        out += dec.decompress(b"", max_length=usize - len(out))
    return out


def decompress(chunk, usize, ctype):
    if ctype in (CT_LZ4, CT_LZ4HC):
        return lz4.block.decompress(chunk, uncompressed_size=usize)
    if ctype == CT_LZMA:
        return lzma_block(chunk, usize)
    return chunk


def lz4_compress(data, level=12):
    out = lz4.block.compress(data, mode="high_compression", compression=level,
                             store_size=False)
    return out if len(out) < len(data) else data


# --- patches ---------------------------------------------------------------
# A patch is a tuple whose first element is the kind and whose second element
# is the absolute stream offset it starts at:
#
#   ("bytes", off, data)            raw bytes, no size change
#   ("fill16", off, size, block16)  `size` bytes of a 16-byte pattern (a BC7
#                                   block repeated: the cheapest legal way to
#                                   empty out a texture)
#   ("zero", off, size)             `size` zero bytes
#
# Everything is applied while a block is being written, so a 32 MiB patch costs
# 128 KiB of memory at a time.
DEBUG_PATCH = os.environ.get("BT_DEBUG_PATCH") == "1"
PATCH_LOG = []


def apply_patch(chunk, block_off, patch):
    """Poke one patch into the decompressed block at `block_off`."""
    kind = patch[0]
    poff = patch[1]
    end = block_off + len(chunk)
    if kind == "bytes":
        data = patch[2]
        if poff + len(data) <= block_off:
            return False
        a0 = poff - block_off
        A, B = max(0, a0), min(len(chunk), a0 + len(data))
        if B <= A:
            return False
        chunk[A:B] = data[A - a0:B - a0]
        return True
    if kind == "fill16":
        size, block = patch[2], patch[3]
        if poff + size <= block_off or poff >= end:
            return False
        a0 = poff - block_off
        A, B = max(0, a0), min(len(chunk), a0 + size)
        n = B - A
        if n <= 0:
            return False
        phase = (A - a0) % 16
        rep = block * (n // 16 + 2)
        chunk[A:B] = rep[phase:phase + n]
        return True
    if kind == "zero":
        size = patch[2]
        if DEBUG_PATCH:
            PATCH_LOG.append(("zero", poff, size, block_off, len(chunk)))
        if poff + size <= block_off or poff >= end:
            return False
        a0 = poff - block_off
        A, B = max(0, a0), min(len(chunk), a0 + size)
        if B <= A:
            return False
        chunk[A:B] = bytes(B - A)
        return True
    raise ValueError("unknown patch kind %r" % (kind,))


class BundleEdit:
    """A bundle held on disk; blocks are decompressed on demand."""

    def __init__(self, path):
        self.path = path
        self.raw = open(path, "rb").read()
        self.original_size = len(self.raw)
        assert self.raw[:8] == b"UnityFS\0"
        r = Reader(self.raw, ">", 8)
        self.version = r.u32()
        self.unity = r.cstr()
        self.revision = r.cstr()
        self.declared_size = r.i64() if self.version >= 7 else len(self.raw)
        ci = r.u32()
        ui = r.u32()
        self.flags = r.u32()
        self.compression = self.flags & 0x3F
        if self.version >= 7:
            r.align(16)
        self.info_at = len(self.raw) - ci if (self.flags & FLAG_BLOCKS_AT_END) else r.p
        info = decompress(self.raw[self.info_at:self.info_at + ci], ui, self.compression)
        self.info_hash = info[:16]
        ir = Reader(info, ">", 16)
        n = ir.u32()
        self.blocks = [(ir.u32(), ir.u32(), ir.u16()) for _ in range(n)]
        nn = ir.u32()
        self.nodes = []
        for _ in range(nn):
            off = ir.i64(); size = ir.i64(); nf = ir.u32(); name = ir.cstr()
            self.nodes.append(dict(offset=off, size=size, flags=nf, name=name))
        self.data_at = self.info_at + ci
        if self.flags & FLAG_INFO_PADDING:
            self.data_at = (self.data_at + 15) // 16 * 16
        self.block_at = []
        self.block_file_at = []
        pos = 0
        p = self.data_at
        for usize, csize, _f in self.blocks:
            self.block_at.append(pos)
            self.block_file_at.append(p)
            pos += usize
            p += csize
        self.stream_size = pos
        self._cache = {}
        self.patches = []
        self.disabled_info_compression = False           # (offset, bytes)

    # ---------------- blocks ----------------
    def block(self, i):
        if i in self._cache:
            return self._cache[i]
        usize, csize, bf = self.blocks[i]
        p = self.block_file_at[i]
        data = decompress(self.raw[p:p + csize], usize, bf & 0x3F)
        self._cache = {i: data}          # keep one block
        return data

    def read(self, offset, length):
        out = bytearray()
        end = offset + length
        for i, usize in enumerate(b[0] for b in self.blocks):
            b0 = self.block_at[i]
            b1 = b0 + usize
            if b1 <= offset or b0 >= end:
                continue
            data = self.block(i)
            lo = max(0, offset - b0)
            hi = min(usize, end - b0)
            out += data[lo:hi]
            if len(out) >= length:
                break
        return bytes(out[:length])

    def patch(self, offset, data, expect=None):
        """Record a size-preserving edit (the current bytes are checked)."""
        cur = self.read(offset, len(data))
        if expect is not None:
            assert cur == expect, "unexpected bytes at %d" % offset
        assert len(cur) == len(data)
        self.patches.append((offset, bytes(data)))
        return len(data)

    # ---------------- nodes ----------------
    def node(self, name):
        for n in self.nodes:
            if n["name"] == name:
                return n
        raise KeyError(name)

    def closed_blocks(self, node):
        """Indices of the blocks that cover a node."""
        return [i for i, usize in enumerate(b[0] for b in self.blocks)
                if self.block_at[i] < node["offset"] + node["size"] and
                self.block_at[i] + usize > node["offset"]]

    # ---------------- serialized file access ----------------
    def serialized(self, node, head=None):
        """Parse header + types + object table of a serialized node."""
        if head is None:
            # read the header first, then exactly the metadata region (which ends
            # where the object data begins)
            probe = self.read(node["offset"], min(node["size"], 64))
            hr = Reader(probe, ">", 0)
            hr.u32(); hr.u32()
            version = hr.u32()
            data_offset = hr.u32()
            if version >= 9:
                hr.p += 4
                if version >= 22:
                    hr.u32(); hr.i64(); data_offset = hr.i64()
            head = self.read(node["offset"], min(node["size"], max(data_offset, 4096) + 64))
        r = Reader(head, ">", 0)
        metadata_size = r.u32(); file_size = r.u32(); version = r.u32(); data_offset = r.u32()
        endian = ">"
        if version >= 9:
            endian = "<" if r.u8() == 0 else ">"
            r.p += 3
            if version >= 22:
                metadata_size = r.u32(); file_size = r.i64(); data_offset = r.i64(); r.i64()
        d = dict(metadata_size=metadata_size, file_size=file_size, version=version,
                 data_offset=data_offset, endian=endian)
        r.e = endian
        if version >= 7:
            r.cstr()
        if version >= 8:
            r.i32()
        enable_type_tree = (r.u8() != 0) if version >= 13 else True
        type_count = r.i32()
        types = []
        for _ in range(type_count):
            cid = r.i32()
            if version >= 16:
                r.u8()
            if version >= 17:
                r.i16()
            if version >= 13:
                if (version < 16 and cid < 0) or (version >= 16 and cid == 114):
                    r.p += 16
                r.p += 16
            if enable_type_tree:
                self._skip_type_tree(r, version)
            if version >= 21:
                k = r.i32(); r.p += 4 * k
            types.append(cid)
        object_count = r.i32()
        objects = []
        for _ in range(object_count):
            r.align(4)
            path_id = r.i32() if version < 14 else r.i64()
            byte_start = r.i64() if version >= 22 else r.u32()
            byte_size = r.u32()
            type_id = r.i32()
            objects.append(dict(path_id=path_id,
                                abs=node["offset"] + data_offset + byte_start,
                                size=byte_size,
                                class_id=types[type_id] if 0 <= type_id < len(types) else -1))
        d.update(types=types, objects=objects, table_end=r.p)
        return d

    @staticmethod
    def _skip_type_tree(r, version):
        node_count = r.i32()
        sbuf = r.i32()
        size = 24 + (8 if version >= 19 else 0)
        if version >= 23:
            r.p += 4
            fmt = r.i32()
            node_count = r.i32()
            sbuf = r.i32()
            size = 24 + (8 if fmt >= 19 else 0)
        r.p += node_count * size + sbuf

    def object_name(self, abs_at, data=None):
        head = data if data is not None else self.read(abs_at, 200)
        n = struct.unpack_from("<i", head, 0)[0]
        if not (0 < n <= 200):
            return ""
        return head[4:4 + n].decode("utf-8", "replace")

    # ---------------- writing ----------------
    def plan_blocks(self, block_size):
        """Split the stream into output blocks: [(stream_offset, usize)]."""
        plan = []
        pos = 0
        while pos < self.stream_size:
            usize = min(block_size, self.stream_size - pos)
            plan.append((pos, usize))
            pos += usize
        return plan

    def build_info(self, plan):
        """Blocks info for `plan` with every block stored (compression NONE).

        Storing the blocks is deliberate: the archive is a deflate ZIP, and
        deflate beats LZ4 on this data, so an uncompressed bundle file is the
        smaller download.  The header is written the same way (`compression`
        field 0, blocks info stored), which keeps the header length fixed and
        the whole write streaming.
        """
        combined = self.flags & FLAG_COMBINED
        bi = bytearray()
        bi += self.info_hash
        bi += struct.pack(">I", len(plan))
        for _off, usize in plan:
            bi += struct.pack(">IIH", usize, usize, combined)
        bi += struct.pack(">I", len(self.nodes))
        for n in self.nodes:
            bi += struct.pack(">qqI", n["offset"], n["size"], n["flags"])
            bi += n["name"].encode("utf-8") + b"\0"
        return bytes(bi)

    def save(self, out_path, block_size=DEFAULT_BLOCK, mode="lz4", verbose=False):
        """Write the bundle back, streaming, with the recorded patches applied.

        Node sizes are unchanged, so the decompressed stream keeps its layout
        and every object inside keeps its offset.  The bundle file gets smaller
        (or stays the same) because the substituted content compresses better,
        not because anything moved.
        """
        plan = self.plan_blocks(block_size)
        if mode == "lz4":
            return self._save_lz4(out_path, plan, block_size)
        info = self.build_info(plan)
        flags = self.flags & ~0x3F          # compression NONE for the blocks info

        def header_for(info_len, total):
            h = bytearray()
            h += b"UnityFS\0"
            h += struct.pack(">I", self.version)
            h += self.unity.encode() + b"\0"
            h += self.revision.encode() + b"\0"
            h += struct.pack(">q", total)
            h += struct.pack(">II", info_len, info_len)
            h += struct.pack(">I", flags)
            if self.version >= 7:
                while len(h) % 16:
                    h += b"\0"
            h += info
            if flags & FLAG_INFO_PADDING:
                while len(h) % 16:
                    h += b"\0"
            return bytes(h)

        patches = sorted(self.patches, key=lambda p: p[1])
        body_len = sum(usize for _o, usize in plan)
        head = header_for(len(info), 0)
        total = len(head) + body_len
        head = header_for(len(info), total)

        cache = {}
        n = len(self.blocks)
        bi = 0
        with open(out_path, "wb") as fh:
            fh.write(head)
            for off, usize in plan:
                end = off + usize
                chunk = bytearray()
                while len(chunk) < usize and bi < n:
                    b0 = self.block_at[bi]
                    bsz = self.blocks[bi][0]
                    if b0 >= end:
                        break
                    if b0 + bsz <= off:            # source block starts later
                        bi += 1
                        continue
                    data = self.block(bi)
                    lo = max(0, off - b0)
                    hi = min(bsz, end - b0)
                    chunk += data[lo:hi]
                    if b0 + bsz <= end:            # fully consumed by this chunk
                        bi += 1
                    # otherwise the source block continues into the next output
                    # block, and the loop guard ends this chunk
                assert len(chunk) == usize, (len(chunk), usize)
                for patch in patches:
                    if patch[1] >= end:
                        break
                    if apply_patch(chunk, off, patch) is False:
                        pass
                fh.write(bytes(chunk))
        if verbose:
            print("    %-50s %9d -> %9d bytes  %d blocks" % (
                self.path.split("/")[-1][:50], self.original_size, total, len(plan)))
        return total

    # ---------------- LZ4 writer ----------------
    def _save_lz4(self, out_path, plan, block_size):
        """Compress every block with LZ4HC (like the upstream bundles) and write.

        Two passes: the block table has to be known before the header is
        written, and holding a multi-gigabyte body in memory is not an option,
        so the compressed body goes to a temporary file first.
        """
        import tempfile
        patches = sorted(self.patches, key=lambda p: p[1])
        table = []
        tmp = tempfile.NamedTemporaryFile(delete=False, dir=os.path.dirname(out_path) or None)
        try:
            bi = 0
            n = len(self.blocks)
            for off, usize in plan:
                end = off + usize
                chunk = bytearray()
                while len(chunk) < usize and bi < n:
                    b0 = self.block_at[bi]
                    bsz = self.blocks[bi][0]
                    if b0 >= end:
                        break
                    if b0 + bsz <= off:
                        bi += 1
                        continue
                    data = self.block(bi)
                    chunk += data[max(0, off - b0):min(bsz, end - b0)]
                    if b0 + bsz <= end:
                        bi += 1
                for patch in patches:
                    if patch[1] >= end:
                        break
                    if apply_patch(chunk, off, patch) is False:
                        pass
                if DEBUG_PATCH and len(PATCH_LOG) < 40:
                    PATCH_LOG.append(("block", off, usize, chunk.count(0)))
                comp = lz4_compress(bytes(chunk))
                ctype = CT_LZ4HC
                if len(comp) >= usize:
                    comp = bytes(chunk)
                    ctype = CT_NONE
                table.append((usize, len(comp), (self.flags & FLAG_COMBINED) | ctype))
                tmp.write(comp)
            tmp.flush()

            info = bytearray()
            info += self.info_hash
            info += struct.pack(">I", len(table))
            for usize, csize, tflags in table:
                info += struct.pack(">IIH", usize, csize, tflags)
            info += struct.pack(">I", len(self.nodes))
            for nd in self.nodes:
                info += struct.pack(">qqI", nd["offset"], nd["size"], nd["flags"])
                info += nd["name"].encode("utf-8") + b"\0"
            info_comp = bytes(info)
            if self.compression in (CT_LZ4, CT_LZ4HC):
                info_comp = lz4_compress(info_comp)
                self.disabled_info_compression = len(info_comp) >= len(info)
            head_flags = self.flags
            if self.disabled_info_compression:
                head_flags = (head_flags & ~0x3F)   # stored info needs no codec
                info_comp = bytes(info)
            elif self.compression == CT_NONE:
                head_flags = head_flags & ~0x3F

            head = bytearray()
            head += b"UnityFS\0"
            head += struct.pack(">I", self.version)
            head += self.unity.encode() + b"\0"
            head += self.revision.encode() + b"\0"
            head += struct.pack(">q", 0)
            head += struct.pack(">II", len(info_comp), len(info))
            head += struct.pack(">I", head_flags)
            if self.version >= 7:
                while len(head) % 16:
                    head += b"\0"
            head += info_comp
            if head_flags & FLAG_INFO_PADDING:
                while len(head) % 16:
                    head += b"\0"
            if DEBUG_PATCH:
                print("PATCH LOG (%d entries):" % len(PATCH_LOG))
                for e in PATCH_LOG[:40]:
                    print("   ", e)
            total = len(head) + os.path.getsize(tmp.name)
            struct.pack_into(">q", head, head.rindex(b"UnityFS\0") + 8 + 4 + len(self.unity) + 1
                             + len(self.revision) + 1, total)
            with open(out_path, "wb") as fh:
                fh.write(bytes(head))
                tmp.seek(0)
                while True:
                    block = tmp.read(8 << 20)
                    if not block:
                        break
                    fh.write(block)
            return total
        finally:
            tmp.close()
            os.unlink(tmp.name)
