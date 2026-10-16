#!/usr/bin/env python3
"""Repackage an existing, authorized ZIP for a large-file host. No game edits.

Examples:
  python3 web/tools/package-assets.py --zip slim.zip --out web/optimized-assets \
    --asset-base https://assets.example/v1/ --compression preserve --part-mib 32
  # Direct LZ4 bundles avoid outer ZIP inflate; upload bundles/ too:
  python3 web/tools/package-assets.py --zip slim.zip --out web/optimized-assets \
    --asset-base https://assets.example/v1/ --bundles \
    --bundle-base https://assets.example/v1/bundles/ --compression store
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import zipfile


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zip', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--descriptor', type=Path, default=Path(__file__).resolve().parent.parent / 'community-build.json')
    parser.add_argument('--asset-base', required=True, help='Actual upload root; this tool does not provision or upload a CDN')
    parser.add_argument('--compression', choices=['preserve', 'store', 'deflate'], default='preserve')
    parser.add_argument('--part-mib', choices=[16, 32, 64], type=int, default=32)
    parser.add_argument('--part-bytes', type=int, help='Override for small test fixtures (1024..64 MiB)')
    parser.add_argument('--bundles', action='store_true')
    parser.add_argument('--bundle-base')
    args = parser.parse_args()
    if not args.asset_base.startswith(('https://', 'http://')):
        parser.error('--asset-base must be an HTTP(S) root')
    if args.bundle_base and not args.bundles:
        parser.error('--bundle-base requires --bundles')
    size = args.part_bytes or args.part_mib * 1024 * 1024
    if not 1024 <= size <= 64 * 1024 * 1024:
        parser.error('part size must be between 1024 bytes and 64 MiB')
    if args.out.exists() and any(args.out.iterdir()):
        parser.error('output directory must be empty (never overwrites a deployed build)')
    source = json.loads(args.descriptor.read_text())
    # Validate the complete ZIP before publishing any output/descriptor.
    with zipfile.ZipFile(args.zip) as archive:
        for info in archive.infolist():
            name = PurePosixPath(info.filename)
            if name.is_absolute() or '..' in name.parts or '\\' in info.filename:
                raise ValueError('unsafe archive path: ' + info.filename)
        bad = archive.testzip()
        if bad:
            raise ValueError('CRC mismatch: ' + bad)
    args.out.mkdir(parents=True, exist_ok=True)
    target = args.out / 'WebGL.zip'
    if args.compression == 'preserve':
        shutil.copyfile(args.zip, target)
    else:
        mode = zipfile.ZIP_STORED if args.compression == 'store' else zipfile.ZIP_DEFLATED
        with zipfile.ZipFile(args.zip) as incoming, zipfile.ZipFile(target, 'w', compression=mode, compresslevel=9 if mode else None, allowZip64=True) as outgoing:
            for info in incoming.infolist():
                item = copy.copy(info)
                item.compress_type = mode
                item._compresslevel = 9 if mode else None
                with incoming.open(info) as reader, outgoing.open(item, 'w', force_zip64=True) as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
    digest = sha256(target)
    parts = []
    with target.open('rb') as reader:
        number = 1
        while True:
            data = reader.read(size)
            if not data:
                break
            name = 'WebGL.zip.part' + str(number)
            (args.out / name).write_bytes(data)
            parts.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            number += 1
    entries = []
    with zipfile.ZipFile(target) as archive:
        for info in archive.infolist():
            record = {'filename': info.filename, 'directory': info.is_dir(), 'offset': info.header_offset, 'compressedSize': info.compress_size,
                      'uncompressedSize': info.file_size, 'signature': info.CRC}
            if args.bundles and not info.is_dir():
                path = args.out / 'bundles' / info.filename
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as reader, path.open('wb') as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
                record['sha256'] = sha256(path)
            entries.append(record)
    total = target.stat().st_size
    source['buildId'] += '-assets-' + digest[:12]
    source['assetArchive'] = {'cacheKey': 'assets-' + digest[:12] + '.zip', 'base': args.asset_base.rstrip('/') + '/',
                              'total': total, 'slim': True, 'mime': 'application/zip', 'parts': parts}
    if args.bundle_base:
        source['assetArchive']['bundleBase'] = args.bundle_base.rstrip('/') + '/'
        source['assetArchive']['index'] = 'zip-index.json'
    (args.out / 'zip-index.json').write_text(json.dumps({'schema': 1, 'bytes': total, 'sha256': digest, 'entries': entries}, indent=2) + '\n')
    (args.out / 'community-build.json').write_text(json.dumps(source, indent=2) + '\n')
    print(json.dumps({'archiveBytes': total, 'parts': len(parts), 'sha256': digest,
                      'descriptor': str(args.out / 'community-build.json'), 'uploaded': False}, indent=2))


if __name__ == '__main__':
    main()
