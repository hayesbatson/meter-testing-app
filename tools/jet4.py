"""Minimal read-only reader for Access 2000-2003 (Jet 4) .mdb files."""
import struct, datetime, sys

PG = 4096

class Jet4:
    def __init__(self, path):
        self.d = open(path, 'rb').read()
        assert self.d[0x14] == 1, 'not Jet4'
        self.npages = len(self.d) // PG
        # index data pages by owning tdef
        self.data_pages = {}
        for p in range(self.npages):
            b = self.d[p*PG:p*PG+8]
            if b[0] == 1 and b[1] == 1:
                t = struct.unpack_from('<I', b, 4)[0]
                self.data_pages.setdefault(t, []).append(p)

    def page(self, p):
        return self.d[p*PG:(p+1)*PG]

    def tdef(self, p):
        buf = b''
        pg = p
        first = True
        while pg:
            b = self.page(pg)
            assert b[0] == 2, f'page {pg} not tdef'
            buf += b if first else b[8:]
            first = False
            pg = struct.unpack_from('<I', b, 4)[0]
        num_rows = struct.unpack_from('<I', buf, 16)[0]
        num_var, num_cols = struct.unpack_from('<HH', buf, 43)
        num_idx, num_real_idx = struct.unpack_from('<II', buf, 47)
        off = 63 + num_real_idx * 12
        cols = []
        for i in range(num_cols):
            c = buf[off:off+25]
            cols.append(dict(type=c[0], num=struct.unpack_from('<H', c, 5)[0], var_idx=struct.unpack_from('<H', c, 7)[0],
                             fixed=bool(c[15] & 1), foff=struct.unpack_from('<H', c, 21)[0], length=struct.unpack_from('<H', c, 23)[0],
                             scale=c[11], prec=c[12]))
            off += 25
        for c in cols:
            n = struct.unpack_from('<H', buf, off)[0]
            c['name'] = buf[off+2:off+2+n].decode('utf-16le')
            off += 2 + n
        cols.sort(key=lambda c: c['num'])
        return dict(num_rows=num_rows, cols=cols, num_cols=num_cols, num_var=num_var)

    @staticmethod
    def text(b):
        if b[:2] == b'\xff\xfe':
            out = []; comp = True; i = 2
            while i < len(b):
                if b[i] == 0:
                    comp = not comp; i += 1; continue
                if comp:
                    out.append(chr(b[i])); i += 1
                else:
                    out.append(b[i:i+2].decode('utf-16le', 'replace')); i += 2
            return ''.join(out)
        return b.decode('utf-16le', 'replace')

    def row_bytes(self, pg, rn):
        b = self.page(pg)
        n = struct.unpack_from('<H', b, 12)[0]
        if rn >= n: return None
        start = struct.unpack_from('<H', b, 14 + rn*2)[0] & 0x1FFF
        end = PG if rn == 0 else struct.unpack_from('<H', b, 14 + (rn-1)*2)[0] & 0x1FFF
        return b[start:end]

    def memo(self, raw):
        if len(raw) < 12: return ''
        ln = struct.unpack_from('<I', raw, 0)[0]
        flags = ln >> 24; ln &= 0xFFFFFF
        if flags & 0x80:
            return self.text(raw[12:12+ln])
        ptr = struct.unpack_from('<I', raw, 4)[0]
        if flags & 0x40:
            rb = self.row_bytes(ptr >> 8, ptr & 0xFF)
            return self.text(rb[:ln]) if rb else ''
        out = b''
        while ptr and len(out) < ln:
            rb = self.row_bytes(ptr >> 8, ptr & 0xFF)
            if not rb: break
            ptr = struct.unpack_from('<I', rb, 0)[0]
            out += rb[4:]
        return self.text(out[:ln])

    def val(self, c, raw):
        t = c['type']
        if t == 2: return raw[0]
        if t == 3: return struct.unpack('<h', raw[:2])[0]
        if t == 4: return struct.unpack('<i', raw[:4])[0]
        if t == 5: return struct.unpack('<q', raw[:8])[0] / 10000
        if t == 6: return round(struct.unpack('<f', raw[:4])[0], 6)
        if t == 7: return struct.unpack('<d', raw[:8])[0]
        if t == 8:
            v = struct.unpack('<d', raw[:8])[0]
            try: return datetime.datetime(1899, 12, 30) + datetime.timedelta(days=v)
            except Exception: return v
        if t == 10: return self.text(raw)
        if t == 12: return self.memo(raw)
        if t == 16:
            neg = raw[0] & 0x80
            n = 0
            for i in range(4):
                n = (n << 32) | struct.unpack_from('<I', raw, 1 + i*4)[0]
            v = n / (10 ** c['scale'])
            return -v if neg else v
        if t == 15: return raw[:16].hex()
        return raw.hex()[:40]

    def rows(self, tdef_pg, td=None):
        td = td or self.tdef(tdef_pg)
        # first pass: find rows that are overflow targets so they aren't read twice
        self._ovf = set(); self._ovf_targets = set()
        for pg in self.data_pages.get(tdef_pg, []):
            b = self.page(pg); n = struct.unpack_from('<H', b, 12)[0]
            for rn in range(n):
                o = struct.unpack_from('<H', b, 14 + rn*2)[0]
                if o & 0x4000 and not o & 0x8000:
                    ptr = struct.unpack_from('<I', b, o & 0x1FFF)[0]
                    self._ovf_targets.add((ptr >> 8, ptr & 0xFF))
        cols = td['cols']
        for pg in self.data_pages.get(tdef_pg, []):
            b = self.page(pg)
            n = struct.unpack_from('<H', b, 12)[0]
            for rn in range(n):
                o = struct.unpack_from('<H', b, 14 + rn*2)[0]
                if o & 0x8000: continue  # deleted
                start = o & 0x1FFF
                end = PG if rn == 0 else struct.unpack_from('<H', b, 14 + (rn-1)*2)[0] & 0x1FFF
                r = b[start:end]
                if o & 0x4000:  # overflow: pointer to the real row
                    ptr = struct.unpack_from('<I', r, 0)[0]
                    r = self.row_bytes(ptr >> 8, ptr & 0xFF)
                    if r is None: continue
                    self._ovf.add((ptr >> 8, ptr & 0xFF))
                elif (pg, rn) in self._ovf_targets:
                    continue
                if len(r) < 4: continue
                ncols = struct.unpack_from('<H', r, 0)[0]
                nb = (ncols + 7) // 8
                nullmask = r[-nb:]
                pos = len(r) - nb - 2
                if td['num_var'] == 0:
                    var_len = 0
                else:
                    var_len = struct.unpack_from('<H', r, pos)[0]
                var_offs = [struct.unpack_from('<H', r, pos - 2*(i+1))[0] for i in range(var_len + 1)] if var_len else []
                rec = {}
                for c in cols:
                    i = c['num']
                    present = i < ncols and (nullmask[i // 8] >> (i % 8)) & 1
                    if c['type'] == 1:
                        rec[c['name']] = bool(present); continue
                    if not present:
                        rec[c['name']] = None; continue
                    if c['fixed']:
                        raw = r[2 + c['foff']: 2 + c['foff'] + c['length']]
                    else:
                        vi = c['var_idx']
                        if vi >= var_len: rec[c['name']] = None; continue
                        raw = r[var_offs[vi]:var_offs[vi+1]]
                    try: rec[c['name']] = self.val(c, raw)
                    except Exception as e: rec[c['name']] = f'<err {e}>'
                yield rec

    def tables(self):
        out = {}
        for r in self.rows(2):
            if r.get('Type') == 1 and r.get('Name'):
                out[r['Name']] = dict(page=r['Id'] & 0xFFFFFF, flags=r.get('Flags'))
        return out

if __name__ == '__main__':
    j = Jet4(sys.argv[1])
    for name, info in sorted(j.tables().items()):
        if name.startswith('MSys'): continue
        td = j.tdef(info['page'])
        print(f"\n## {name}  ({td['num_rows']} rows)")
        print(', '.join(f"{c['name']}[{c['type']}]" for c in td['cols']))
