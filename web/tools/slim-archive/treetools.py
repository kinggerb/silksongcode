"""Shared helper: pull a node's type trees out of a bundle's metadata.

UnityPy supplies the binary type-tree parser and Unity's common-string table;
this adapter exposes the small lower-case node interface consumed by
`typetree_read.py` without depending on a private `.tmp/survey` checkout.
"""
from types import SimpleNamespace

from UnityPy.helpers.TypeTreeNode import TypeTreeNode
from UnityPy.streams.EndianBinaryReader import EndianBinaryReader

import bundle_tool as BT


def _adapt(node):
    """Convert a UnityPy node into the interface used by TreeReader."""
    return SimpleNamespace(
        name=node.m_Name,
        type=node.m_Type,
        size=node.m_ByteSize,
        meta_flag=node.m_MetaFlag or 0,
        children=[_adapt(child) for child in node.m_Children],
    )


def trees_for(bundle, node):
    """Return `(serialized-file version, [(class id, root node), ...])`."""
    probe = bundle.read(node["offset"], min(node["size"], 64))
    r = BT.Reader(probe, ">", 0)
    r.u32(); r.u32()
    version = r.u32()
    data_offset = r.u32()
    if version >= 9:
        r.p += 4
        if version >= 22:
            r.u32(); r.i64(); data_offset = r.i64()
    head = bundle.read(node["offset"], min(node["size"], max(data_offset, 4096) + 64))
    r = BT.Reader(head, ">", 0)
    r.u32(); r.u32(); r.u32(); r.u32()
    r.p += 4
    if version >= 22:
        r.u32(); r.i64(); r.i64(); r.i64()
    r.e = "<"
    r.cstr()                       # unity version
    r.i32()                        # platform
    has_type_tree = r.u8() != 0
    count = r.i32()
    types = []
    for _ in range(count):
        class_id = r.i32()
        if version >= 16:
            r.u8()
        if version >= 17:
            r.i16()
        if version >= 13:
            if (version < 16 and class_id < 0) or (version >= 16 and class_id == 114):
                r.p += 16
            r.p += 16

        root = None
        if has_type_tree:
            reader = EndianBinaryReader(head, "<")
            reader.Position = r.p
            if version >= 12 or version == 10:
                parsed = TypeTreeNode.parse_blob(reader, version)
            else:
                parsed = TypeTreeNode.parse(reader, version)
            root = _adapt(parsed)
            r.p = reader.Position

        if version >= 21:
            dependency_count = r.i32()
            r.p += 4 * dependency_count
        types.append((class_id, root))
    return version, types
