"""Shared helper: pull a node's type trees out of a bundle's metadata."""
import sys
sys.path.insert(0, '/home/user/silksongcode/.tmp/survey')
from UnityPy.helpers.Tpk import get_common_strings
import bundle_tool as BT
import typetree as TT

CS = get_common_strings()


def _resolve(data, value):
    if value & 0x80000000:
        return CS.get(value & 0x7FFFFFFF, "?%d" % (value & 0x7FFFFFFF))
    end = data.index(b"\0", value)
    return data[value:end].decode("utf-8", "replace")


TT._string = _resolve


def trees_for(bundle, node):
    """(version, types) where types is a list of (class_id, tree_root)."""
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
    ett = r.u8() != 0
    count = r.i32()
    types = []
    for _ in range(count):
        cid = r.i32()
        if version >= 16:
            r.u8()
        if version >= 17:
            r.i16()
        if version >= 13:
            if (version < 16 and cid < 0) or (version >= 16 and cid == 114):
                r.p += 16
            r.p += 16
        root = None
        if ett:
            root, r.p = TT.parse_type_tree(head, r.p, version)
        if version >= 21:
            k = r.i32()
            r.p += 4 * k
        types.append((cid, root))
    return version, types
