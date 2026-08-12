jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));

const pool = require('../../src/db/pool');
const {
  createPrescriptionRequest,
  getRequestById,
  transitionRequestStatus,
  insertDoctorRequestLog,
  markDoctorLogSendFailed,
  markDoctorLogResponded,
  markDoctorLogSuperseded,
  markDoctorLogExpired,
  findDoctorLogByMessageId,
  findAwaitingDoctorLog,
  findRecentByPhone,
  existsByShopifyOrderId,
} = require('../../src/repositories/prescriptionRequest.repository');

describe('createPrescriptionRequest', () => {
  it('inserts all fields and returns the new row id', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 42 }] });

    const id = await createPrescriptionRequest({
      customerName: 'Jane Doe',
      customerPhone: '+919999999999',
      method: 'upload',
      fileUrl: 'https://example.com/rx.png',
      products: [{ product_id: 1 }],
      medicineName: 'Amoxicillin 250mg',
      shopifyOrderId: '#1001',
      shopifyOrderGid: 'gid://shopify/Order/1001',
      status: 'pending_secondary',
    });

    expect(id).toBe(42);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO prescription_requests'),
      [
        'Jane Doe',
        '+919999999999',
        'upload',
        'https://example.com/rx.png',
        JSON.stringify([{ product_id: 1 }]),
        'Amoxicillin 250mg',
        '#1001',
        'gid://shopify/Order/1001',
        'pending_secondary',
      ],
    );
  });

  it('defaults optional fields to null, products to an empty array, and status to pending_primary', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] });

    await createPrescriptionRequest({
      customerName: 'Jane Doe',
      customerPhone: '+919999999999',
      method: 'consult',
    });

    const params = pool.query.mock.calls[0][1];
    expect(params).toEqual(['Jane Doe', '+919999999999', 'consult', null, '[]', null, null, null, 'pending_primary']);
  });
});

describe('getRequestById', () => {
  it('returns the matching row', async () => {
    const row = { id: 1, status: 'approved' };
    pool.query.mockResolvedValue({ rows: [row] });

    expect(await getRequestById(1)).toEqual(row);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [1]);
  });

  it('returns null when nothing matches', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    expect(await getRequestById('missing')).toBeNull();
  });
});

describe('transitionRequestStatus', () => {
  it('performs a plain CAS update when no doctor info is given', async () => {
    const row = { id: 1, status: 'pending_secondary' };
    pool.query.mockResolvedValue({ rows: [row] });

    const result = await transitionRequestStatus(1, 'pending_primary', 'pending_secondary');

    expect(result).toEqual(row);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("WHERE id = $1 AND status = $3"), [
      1,
      'pending_secondary',
      'pending_primary',
    ]);
  });

  it('also sets doctor_name/doctor_mobile when doctor info is given (a resolving reply)', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1, status: 'approved' }] });

    await transitionRequestStatus(1, 'pending_primary', 'approved', { doctorName: 'Dr Primary', doctorMobile: '+911111111111' });

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('doctor_name = $3, doctor_mobile = $4'), [
      1,
      'approved',
      'Dr Primary',
      '+911111111111',
      'pending_primary',
    ]);
  });

  it('returns null when the row is not in the expected fromStatus (lost the race)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    expect(await transitionRequestStatus(1, 'pending_primary', 'approved')).toBeNull();
  });
});

describe('doctor_request_log helpers', () => {
  it('insertDoctorRequestLog inserts and returns the new log id', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'log-1' }] });

    const id = await insertDoctorRequestLog({
      prescriptionRequestId: 'req-1',
      doctorSlot: 'primary',
      doctorName: 'Dr Primary',
      doctorMobile: '+911111111111',
      gupshupMessageId: 'gs-1',
    });

    expect(id).toBe('log-1');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO doctor_request_log'),
      ['req-1', 'primary', 'Dr Primary', '+911111111111', 'gs-1'],
    );
  });

  it('markDoctorLogSendFailed sets outcome and error_detail', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await markDoctorLogSendFailed('log-1', 'boom');

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("outcome = 'send_failed'"), ['log-1', 'boom']);
  });

  it('markDoctorLogResponded sets outcome, responded_at, and response', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await markDoctorLogResponded('log-1', 'approved');

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("outcome = 'responded'"), ['log-1', 'approved']);
  });

  it('markDoctorLogSuperseded returns true the first time it marks a row late', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'log-1' }] });

    expect(await markDoctorLogSuperseded('log-1', 'approved')).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("outcome != 'superseded'"), ['log-1', 'approved']);
  });

  it('markDoctorLogSuperseded returns false on a duplicate delivery (already superseded)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    expect(await markDoctorLogSuperseded('log-1', 'approved')).toBe(false);
  });

  it('markDoctorLogExpired only affects a row still awaiting', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await markDoctorLogExpired('log-1');

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("outcome = 'awaiting'"), ['log-1']);
  });

  it('findDoctorLogByMessageId joins through to the parent request', async () => {
    const row = { log_id: 'log-1', doctor_slot: 'primary', request_status: 'pending_primary' };
    pool.query.mockResolvedValue({ rows: [row] });

    expect(await findDoctorLogByMessageId('gs-1')).toEqual(row);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN prescription_requests r');
    // Regression guard: doctor_name/doctor_mobile must come from the log (l.*)
    // — this attempt's own doctor — not the request (r.*), which is still
    // null pre-resolution. Selecting r.doctor_name/r.doctor_mobile here silently
    // makes resolve() record a null doctor on every successful approval/rejection.
    expect(sql).toMatch(/l\.doctor_name/);
    expect(sql).toMatch(/l\.doctor_mobile/);
    expect(sql).not.toMatch(/r\.doctor_name/);
    expect(sql).not.toMatch(/r\.doctor_mobile/);
  });

  it('findDoctorLogByMessageId returns null when unrecognized', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    expect(await findDoctorLogByMessageId('unknown')).toBeNull();
  });

  it('findAwaitingDoctorLog scopes to request + slot + awaiting outcome', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'log-1' }] });

    const result = await findAwaitingDoctorLog('req-1', 'primary');

    expect(result).toEqual({ id: 'log-1' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("outcome = 'awaiting'"), ['req-1', 'primary']);
  });
});

describe('findRecentByPhone', () => {
  it('passes the phone and default limit through to the query', async () => {
    pool.query.mockResolvedValue({ rows: [{ status: 'approved' }] });

    const rows = await findRecentByPhone('+919999999999');

    expect(rows).toEqual([{ status: 'approved' }]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM prescription_requests'), [
      '+919999999999',
      50,
    ]);
  });

  it('honors a custom limit', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await findRecentByPhone('+919999999999', { limit: 5 });

    expect(pool.query).toHaveBeenCalledWith(expect.anything(), ['+919999999999', 5]);
  });
});

describe('existsByShopifyOrderId', () => {
  it('returns true when a row is found', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] });

    expect(await existsByShopifyOrderId('#1001')).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE shopify_order_id = $1'), ['#1001']);
  });

  it('returns false when no row is found', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    expect(await existsByShopifyOrderId('#9999')).toBe(false);
  });
});
