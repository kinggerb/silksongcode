#!/usr/bin/env python3
"""AssetStudio-style type tree reader that records the byte span of every field.

`span(path)` then gives (offset, size, kind) inside the object for any field, so
a field can be edited in place without changing the object's size.
"""
import struct

from types import SimpleNamespace

ALIGN_FLAG = 0x4000
PRIMITIVES = {
    "SInt8": 1, "UInt8": 1, "char": 1, "bool": 1, "unsigned char": 1,
    "SInt16": 2, "UInt16": 2, "short": 2, "unsigned short": 2,
    "SInt32": 4, "UInt32": 4, "int": 4, "unsigned int": 4, "float": 4,
    "SInt64": 8, "UInt64": 8, "long": 8, "unsigned long long": 8, "double": 8,
    "Type*": 4,
}


def align4(p):
    return (p + 3) & ~3


class TreeReader:
    def __init__(self, data, start=0):
        self.d = data
        self.start = start
        self.spans = {}          # path -> (offset, size, kind)
        self.values = {}         # path -> decoded value (or small byte blob)

    # ------------- helpers -------------
    def _record(self, path, off, size, kind):
        # keep the first hit for a path (fields are unique per path in practice)
        self.spans.setdefault(path, (off, size, kind))

    def span(self, path):
        return self.spans.get(path)

    def value(self, path):
        return self.values.get(path)

    # ------------- reading -------------
    def read(self, node, pos, path=""):
        full = path + node.name if path else node.name
        # TypelessData / string / vector all use the same shape: a u32 count
        # followed by that many elements
        if node.type == "TypelessData":
            count = struct.unpack_from("<I", self.d, pos)[0]
            self._record(full, pos + 4, count, "bytes")
            if count <= 4096:
                self.values[full] = bytes(self.d[pos + 4:pos + 4 + count])
            self._record(full + ".__count", pos, 4, "count")
            return self.d[pos + 4:pos + 4 + count], align4(pos + 4 + count)
        if node.children:
            first = node.children[0]
            if first.name == "Array":
                count = struct.unpack_from("<I", self.d, pos)[0]
                self._record(full + ".__count", pos, 4, "count")
                pos += 4
                size_node = first.children[0] if first.children else None
                data_node = first.children[1] if len(first.children) > 1 else None
                if data_node is None:
                    return None, pos
                stride = PRIMITIVES.get(data_node.type,
                                        data_node.size if data_node.size > 0 else 0)
                if not data_node.children and data_node.type in ("UInt8", "char",
                                                                 "unsigned char", "SInt8"):
                    size = count
                    self._record(full, pos, size, "bytes")
                    raw = self.d[pos:pos + size]
                    if node.type == "string":
                        raw = raw.decode("utf-8", "replace")
                    return raw, align4(pos + size)
                if not data_node.children and stride:
                    self._record(full, pos, stride * count, "array")
                    return None, pos + stride * count
                start = pos
                for _ in range(count):
                    _, pos = self.read(data_node, pos, path)
                self._record(full, start, pos - start, "array")
                return None, pos
            # a plain struct
            start = pos
            values = {}
            for c in node.children:
                v, pos = self.read(c, pos, full + ".")
                values[c.name] = v
            if node.meta_flag & ALIGN_FLAG:
                pos = align4(pos)
            self._record(full, start, pos - start, "struct")
            return values, pos

        # leaves
        if node.type == "string":
            n = struct.unpack_from("<I", self.d, pos)[0]
            value = self.d[pos + 4:pos + 4 + n].decode("utf-8", "replace")
            self.values[full] = value
            self._record(full, pos + 4, n, "string")
            self._record(full + ".__len", pos, 4, "count")
            return value, align4(pos + 4 + n)
        size = PRIMITIVES.get(node.type)
        if size is None:
            size = node.size if node.size > 0 else 0
        raw = self.d[pos:pos + size]
        if node.type == "bool":
            v = raw[0] != 0
        elif node.type == "float":
            v = struct.unpack("<f", raw)[0]
        elif node.type in ("double",):
            v = struct.unpack("<d", raw)[0]
        elif node.type in ("SInt8", "char"):
            v = struct.unpack("<b", raw)[0]
        elif node.type == "UInt8":
            v = raw[0]
        elif node.type in ("SInt16", "short"):
            v = struct.unpack("<h", raw)[0]
        elif node.type in ("UInt16", "unsigned short"):
            v = struct.unpack("<H", raw)[0]
        elif node.type in ("SInt32", "int"):
            v = struct.unpack("<i", raw)[0]
        elif node.type in ("UInt32", "unsigned int", "Type*"):
            v = struct.unpack("<I", raw)[0]
        elif node.type in ("SInt64", "long"):
            v = struct.unpack("<q", raw)[0]
        elif node.type in ("UInt64", "unsigned long long"):
            v = struct.unpack("<Q", raw)[0]
        else:
            v = None
        self.values[full] = v
        self._record(full, pos, size, "value")
        pos += size
        if node.meta_flag & ALIGN_FLAG:
            pos = align4(pos)
        return v, pos
