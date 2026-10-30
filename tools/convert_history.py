"""Convert MAM's old Access database (midamwo.mdb) into one history file for the Meter Testing App.

Usage:  python3 convert_history.py midamwo.mdb history-all.json

The output holds customers and every old work order (one meter each) with its tests,
in the same shape the app uses for meters. The app's "Import history" button splits
it into small files in the SharePoint site. No data is stored in this repository.
"""
import sys, json, datetime, os
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jet4 import Jet4

TYPE_MAP = {
    'disk/piston': 'Displacement', 'disk / piston': 'Displacement', 'piston': 'Displacement',
    'turbine': 'Turbine', 'propeller': 'Propeller', 'compound': 'Compound',
    'multi jet': 'Multi-jet', 'multi-jet': 'Multi-jet', 'single jet': 'Singlejet',
    'mag': 'Electromagnetic', 'mag meter': 'Electromagnetic',
    'ultra sonic': 'Ultrasonic', 'ultrasonic': 'Ultrasonic',
}
INSTR_MAP = {
    'test only': 'Test only', 'test ony': 'Test only',
    'clean and test': 'Clean, repair and test', 'clean, repair, test': 'Clean, repair and test',
    'clean, repair and test': 'Clean, repair and test', 'complete rebuild': 'Clean, repair and test',
    'rebuild': 'Clean, repair and test',
    'inspect and quote': 'Evaluate and inspect',
}

def s(v):
    return '' if v is None else str(v).strip()

def day(v):
    if isinstance(v, datetime.datetime) and 1990 <= v.year <= 2035:
        return v.strftime('%Y-%m-%d')
    return ''

def numstr(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v)

def pct(v):
    return '' if not v else f'{v:.2f}'

def main(src, dst):
    j = Jet4(src)
    T = j.tables()
    data = {n: list(j.rows(T[n]['page'])) for n in T if not n.startswith('MSys')}
    customers = {c['CustomerId']: c for c in data['Customers']}
    tests = defaultdict(list)
    for t in data['TestResults']:
        tests[t['WorkOrderID']].append(t)

    out_customers = []
    for c in sorted(data['Customers'], key=lambda c: s(c['Name']).lower()):
        out_customers.append({
            'id': c['CustomerId'], 'name': s(c['Name']), 'address1': s(c['Address1']), 'address2': s(c['Address2']),
            'city': s(c['City']), 'state': s(c['State']), 'zip': s(c['Zipcode']), 'type': s(c['CustType']), 'notes': s(c['Notes']),
        })

    meters = []
    stats = Counter()
    for w in sorted(data['WorkOrders'], key=lambda r: r['WorkOrderId']):
        cust = customers.get(w['CustomerId'], {})
        ts = sorted(tests.get(w['WorkOrderId'], []), key=lambda t: (t['TestID'], t['AsIs'] or 0))
        before = [{'gpm': numstr(t['AsIs']) if t['AsIsPct'] else '', 'pct': pct(t['AsIsPct'])} for t in ts]
        after = [{'gpm': numstr(t['After']) if t['AfterPct'] else '', 'pct': pct(t['AfterPct'])} for t in ts]
        has_before = any(t['pct'] for t in before)
        has_after = any(t['pct'] for t in after)
        raw_type = s(w['MeterType'])
        instr_raw = s(w['Instructions'])
        date_in, date_out = day(w['DateIn']), day(w['DateOut'])
        if w['DateIn'] and not date_in: stats['bad_date_in'] += 1
        if w['DateOut'] and not date_out: stats['bad_date_out'] += 1
        if not ts: stats['no_tests'] += 1
        if has_after and not has_before: stats['after_only'] += 1
        meters.append({
            'wo': str(w['WorkOrderId']),
            'customerId': w['CustomerId'], 'customer': s(cust.get('Name')),
            'serial': s(w['MeterSerial']), 'size': s(w['MeterSize']),
            'mfr': s(w['MeterManufacturer']), 'model': s(w['MeterModel']),
            'type': TYPE_MAP.get(raw_type.lower(), raw_type),
            'registration': s(w['MeterRegistration']), 'location': s(w['MeterLocation']),
            'instructions': INSTR_MAP.get(instr_raw.lower(), instr_raw if instr_raw not in ('--', 'Other') else ''),
            'setting': 'Field' if s(w['TestType']).lower() == 'field' else 'Shop',
            'dateIn': date_in, 'dateOut': date_out, 'testDate': date_out or date_in,
            'tech': s(w['Technician']),
            'reads': {k: numstr(v) for k, v in {
                'begin': w['SingleRegisterStart'], 'end': w['SingleRegisterEnd'],
                'lowBegin': w['DualRegisterLowStart'], 'lowEnd': w['DualRegisterLowEnd'],
                'highBegin': w['DualRegisterHighStart'], 'highEnd': w['DualRegisterHighEnd']}.items() if v is not None},
            'pctDirect': True, 'custom': True,
            'points': [{'name': f'Test {i+1}', 'low': '', 'high': ''} for i in range(len(ts))],
            'calibrated': has_after,
            'before': before, 'after': after,
            'parts': s(w['Parts']), 'comments': s(w['Comments']),
            'legacy': True,
        })

    result = {
        'version': 1,
        'generated': datetime.datetime.now().isoformat(timespec='seconds'),
        'source': os.path.basename(src),
        'counts': {'customers': len(out_customers), 'meters': len(meters), 'tests': len(data['TestResults']), **stats},
        'woMax': max(int(m['wo']) for m in meters),
        'customers': out_customers,
        'meters': meters,
    }
    with open(dst, 'w') as f:
        json.dump(result, f, separators=(',', ':'), ensure_ascii=False)
    print(json.dumps(result['counts']), 'woMax', result['woMax'], 'bytes', os.path.getsize(dst))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
